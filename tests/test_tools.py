from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agent_core import RunContext

from friday.app import PROJECT_INSTRUCTIONS_LIMIT, build_friday, build_instructions, compact_friday, ensure_user_home, init_project, prepare_context_for_chat, reset_friday, resume_choices, resume_friday, save_turn
from friday.context import compact_tool_results, context_report
from friday.loop import AGENT_MAX_STEPS, goal_chat, verified_chat
from friday.tools import APPROVAL_FILE, PERMISSIONS_FILE, approve_pending, build_tools, pending_approval, skill_catalog
from friday.verification import VERIFIER_MAX_STEPS, needs_verification, parse_verification, verification_prompt


class ToolTests(unittest.TestCase):
    def test_file_tools_stay_inside_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tools = {tool.name: tool for tool in build_tools(root, root / ".friday")}

            tools["Write"]("note.txt", "hello")
            read = tools["Read"]("note.txt")
            self.assertIn("hello", read["content"])

            tools["Edit"]("note.txt", "hi", old_text="hello")
            self.assertIn("hi", tools["Read"]("note.txt")["content"])

            with self.assertRaises(ValueError):
                tools["Read"]("../escape.txt")

    def test_read_and_edit_line_ranges(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tools = {tool.name: tool for tool in build_tools(root, root / ".friday")}
            tools["Write"]("note.txt", "one\ntwo\nthree\nfour\n")

            read = tools["Read"]("note.txt", start_line=2, line_count=2)
            self.assertEqual(read["content"], "2: two\n3: three")
            self.assertEqual(read["end_line"], 3)

            result = tools["Edit"]("note.txt", "TWO\nTHREE", start_line=2, end_line=3)
            self.assertEqual(result["mode"], "line_range")
            self.assertEqual((root / "note.txt").read_text(encoding="utf-8"), "one\nTWO\nTHREE\nfour\n")

            tools["Edit"]("note.txt", "inserted", start_line=2, end_line=0)
            self.assertEqual(
                (root / "note.txt").read_text(encoding="utf-8"),
                "one\ninserted\nTWO\nTHREE\nfour\n",
            )

            tools["Edit"]("note.txt", "", start_line=1, end_line=5)
            self.assertEqual((root / "note.txt").read_text(encoding="utf-8"), "")

    def test_run_shell_returns_errors(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tools = {tool.name: tool for tool in build_tools(root, root / ".friday")}

            result = tools["Bash"]("exit 7")
            self.assertEqual(result["exit_code"], 7)
            self.assertFalse(result["timed_out"])

    def test_bash_approval_blocks_dangerous_commands_only(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tools = {tool.name: tool for tool in build_tools(root, root / ".friday")}

            safe = tools["Bash"]("python -c \"print('ok')\"")
            safe_comparison = tools["Bash"]("python -c \"print(2 > 1)\"")
            blocked = tools["Bash"]("rm missing-file")
            approved = approve_pending(root)

            self.assertFalse(safe["timed_out"])
            self.assertFalse(safe_comparison["timed_out"])
            self.assertTrue(blocked["approval_required"])
            self.assertFalse((root / ".friday" / APPROVAL_FILE).exists())
            self.assertTrue(approved["approved"])

    def test_pending_approval_reads_without_consuming(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tools = {tool.name: tool for tool in build_tools(root, root / ".friday")}

            tools["Bash"]("rm missing-file")
            pending = pending_approval(root)

            self.assertTrue(pending["pending"])
            self.assertEqual(pending["command"], "rm missing-file")
            self.assertTrue((root / ".friday" / APPROVAL_FILE).exists())

    def test_bash_permissions_json_controls_persistent_policy(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            friday_dir = root / ".friday"
            friday_dir.mkdir()
            (friday_dir / PERMISSIONS_FILE).write_text(
                '{"version":1,"bash":{"allow":["rm missing-file","python -c \\"print(1)\\""],"deny":["python -c deny"],"require_approval":["python -c approve"]}}',
                encoding="utf-8",
            )
            tools = {tool.name: tool for tool in build_tools(root, friday_dir)}

            denied = tools["Bash"]("python -c deny")
            approval = tools["Bash"]("python -c approve")
            allowed = tools["Bash"]("rm missing-file")
            quoted = tools["Bash"]('python -c "print(1)"')

            self.assertTrue(denied["blocked"])
            self.assertTrue(approval["approval_required"])
            self.assertNotIn("approval_required", allowed)
            self.assertEqual(quoted["exit_code"], 0)

    def test_permission_modes_control_approval(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tools = {tool.name: tool for tool in build_tools(root, root / ".friday")}

            with patch.dict(os.environ, {"FRIDAY_PERMISSION_MODE": "bypass"}, clear=False):
                bypassed = tools["Bash"]("rm missing-file")
            with patch.dict(os.environ, {"FRIDAY_PERMISSION_MODE": "dont-ask"}, clear=False):
                denied = tools["Bash"]("rm missing-file")
            with patch.dict(os.environ, {"FRIDAY_PERMISSION_MODE": "accept-edits"}, clear=False):
                edit = tools["Bash"]('Set-Content allowed.txt "ok"')
                delete = tools["Bash"]("Remove-Item allowed.txt")

            self.assertNotIn("approval_required", bypassed)
            self.assertTrue(denied["blocked"])
            self.assertEqual(edit["exit_code"], 0)
            self.assertTrue(delete["approval_required"])

    def test_temporary_allowed_and_disallowed_tools(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tools = {tool.name: tool for tool in build_tools(root, root / ".friday")}

            with patch.dict(os.environ, {"FRIDAY_ALLOWED_TOOLS": '["Bash(rm missing-file *)"]'}, clear=False):
                allowed = tools["Bash"]("rm missing-file")
            with patch.dict(os.environ, {"FRIDAY_DISALLOWED_TOOLS": '["Bash(python -c deny *)"]'}, clear=False):
                denied = tools["Bash"]("python -c deny")

            self.assertNotIn("approval_required", allowed)
            self.assertTrue(denied["blocked"])

    def test_glob_and_grep(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tools = {tool.name: tool for tool in build_tools(root, root / ".friday")}
            tools["Write"]("src/a.py", "alpha\nneedle here\n")
            tools["Write"]("src/b.txt", "needle too\n")

            glob = tools["Glob"]("src/*.py")
            self.assertEqual([path.replace("\\", "/") for path in glob["paths"]], ["src/a.py"])

            grep = tools["Grep"]("needle", path_glob="src/*")
            self.assertEqual(grep["count"], 2)
            self.assertEqual(grep["matches"][0]["line"], 2)

    def test_web_search_requires_tavily_key(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tools = {tool.name: tool for tool in build_tools(root, root / ".friday")}

            with patch.dict(os.environ, {}, clear=True):
                result = tools["WebSearch"]("latest Friday agent news")

            self.assertEqual(result["error"], "TAVILY_API_KEY is not configured.")

    def test_web_search_calls_tavily_api(self) -> None:
        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self) -> bytes:
                return json.dumps(
                    {
                        "query": "Friday agent",
                        "answer": "Friday is a local agent.",
                        "results": [
                            {
                                "title": "Friday",
                                "url": "https://example.com/friday",
                                "content": "  useful   result  ",
                                "score": 0.9,
                                "published_date": "2026-07-10",
                            }
                        ],
                    }
                ).encode("utf-8")

        seen = {}

        def fake_urlopen(request, timeout):
            seen["timeout"] = timeout
            seen["url"] = request.full_url
            seen["auth"] = request.get_header("Authorization")
            seen["payload"] = json.loads(request.data.decode("utf-8"))
            return FakeResponse()

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tools = {tool.name: tool for tool in build_tools(root, root / ".friday")}

            with patch.dict(os.environ, {"TAVILY_API_KEY": "test-key"}, clear=True):
                with patch("friday.tools.urllib.request.urlopen", side_effect=fake_urlopen):
                    result = tools["WebSearch"](
                        "Friday agent",
                        max_results=20,
                        search_depth="advanced",
                        include_answer=True,
                        time_range="week",
                    )

            self.assertEqual(seen["url"], "https://api.tavily.com/search")
            self.assertEqual(seen["auth"], "Bearer test-key")
            self.assertEqual(seen["timeout"], 20)
            self.assertEqual(seen["payload"]["query"], "Friday agent")
            self.assertEqual(seen["payload"]["max_results"], 10)
            self.assertEqual(seen["payload"]["search_depth"], "advanced")
            self.assertEqual(seen["payload"]["time_range"], "week")
            self.assertFalse(seen["payload"]["include_raw_content"])
            self.assertEqual(result["answer"], "Friday is a local agent.")
            self.assertEqual(result["results"][0]["content"], "useful result")

    def test_web_fetch_requires_http_url(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tools = {tool.name: tool for tool in build_tools(root, root / ".friday")}

            result = tools["WebFetch"]("file:///etc/passwd")

            self.assertIn("http:// or https://", result["error"])

    def test_web_fetch_calls_jina_reader(self) -> None:
        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self) -> bytes:
                return b"# Title\n\ncontent"

        seen = {}

        def fake_urlopen(request, timeout):
            seen["timeout"] = timeout
            seen["url"] = request.full_url
            seen["auth"] = request.get_header("Authorization")
            return FakeResponse()

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tools = {tool.name: tool for tool in build_tools(root, root / ".friday")}

            with patch.dict(os.environ, {"JINA_API_KEY": "jina-key"}, clear=True):
                with patch("friday.tools.urllib.request.urlopen", side_effect=fake_urlopen):
                    result = tools["WebFetch"]("https://example.com/a b#section")

            self.assertEqual(seen["timeout"], 30)
            self.assertEqual(seen["auth"], "Bearer jina-key")
            self.assertIn("https://r.jina.ai/https://example.com/a%20b%23section", seen["url"])
            self.assertEqual(result["content"], "# Title\n\ncontent")
            self.assertFalse(result["truncated"])

    def test_memory_tool_updates_scoped_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tools = {tool.name: tool for tool in build_tools(root, root / ".friday")}

            tools["Memory"]("add", "project", "Friday should be concise.")
            memory = tools["Memory"]("read", "project")
            self.assertIn("Friday should be concise.", memory["content"])

            tools["Memory"]("replace", "project", "Friday should stay concise.", "Friday should be concise.")
            self.assertIn("Friday should stay concise.", tools["Memory"]("read", "project")["content"])

            tools["Memory"]("remove", "project", "Friday should stay concise.")
            self.assertNotIn("Friday should stay concise.", tools["Memory"]("read", "project")["content"])

    def test_nested_instruction_context_is_loaded_once_for_touched_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "src").mkdir()
            (root / "src" / "AGENTS.md").write_text("src rules", encoding="utf-8")
            (root / "src" / "app.py").write_text("print('hi')\n", encoding="utf-8")
            tools = {tool.name: tool for tool in build_tools(root, root / ".friday")}

            first = tools["Read"]("src/app.py")
            second = tools["Read"]("src/app.py")

            self.assertEqual(first["context"][0]["path"].replace("\\", "/"), "src/AGENTS.md")
            self.assertIn("src rules", first["context"][0]["content"])
            self.assertEqual(len(first["context"]), 1)
            self.assertNotIn("context", second)

    def test_skill_tool_lists_and_reads_skill_md(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            skill_dir = root / ".friday" / "FridaySkills" / "review"
            skill_dir.mkdir(parents=True)
            (skill_dir / "SKILL.md").write_text(
                "---\nname: review\ndescription: Review code changes.\n---\n\nFull review workflow.",
                encoding="utf-8",
            )
            tools = {tool.name: tool for tool in build_tools(root, root / ".friday")}

            listed = tools["Skill"]("list")
            loaded = tools["Skill"]("read", "review")

            self.assertIn("review", {skill["name"] for skill in listed["skills"]})
            self.assertIn("Review code changes.", skill_catalog(root))
            self.assertIn("Full review workflow.", loaded["content"])


class ResetTests(unittest.TestCase):
    def test_reset_clears_project_state(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            home = root / "home"
            state = root / ".friday"
            global_state = home / ".friday"
            (state / "sessions").mkdir(parents=True)
            global_state.mkdir(parents=True)
            (state / "MEMORY.md").write_text("# Memory\nold", encoding="utf-8")
            (state / "sessions" / "x.json").write_text("{}", encoding="utf-8")
            (global_state / "MEMORY.md").write_text("old", encoding="utf-8")
            (global_state / "USER.md").write_text("old", encoding="utf-8")
            (global_state / "SOUL.md").write_text("old", encoding="utf-8")

            reset_friday(root, user_home=home)

            # Project state is wiped and recreated lazily on use, not by reset.
            self.assertFalse(state.exists())
            # Global defaults are re-provisioned.
            self.assertEqual((global_state / "MEMORY.md").read_text(encoding="utf-8"), "# User Memory\n")
            self.assertIn("Friday Soul", (global_state / "SOUL.md").read_text(encoding="utf-8"))
            self.assertTrue((global_state / "FridaySkills").is_dir())

    def test_ensure_user_home_migrates_legacy_prompt_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / "home"
            user_dir = home / ".friday"
            user_dir.mkdir(parents=True)
            (user_dir / "soul.md").write_text("legacy soul", encoding="utf-8")
            (user_dir / "user.md").write_text("legacy user", encoding="utf-8")

            ensure_user_home(home)

            self.assertEqual((user_dir / "SOUL.md").read_text(encoding="utf-8"), "legacy soul")
            self.assertEqual((user_dir / "USER.md").read_text(encoding="utf-8"), "legacy user")
            names = {path.name for path in user_dir.iterdir()}
            self.assertIn("SOUL.md", names)
            self.assertIn("USER.md", names)
            self.assertNotIn("soul.md", names)
            self.assertNotIn("user.md", names)

    def test_init_creates_only_project_agents_md(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)

            created = init_project(root)

            self.assertEqual(created, [root / "AGENTS.md"])
            self.assertTrue((root / "AGENTS.md").exists())
            self.assertFalse((root / "FRIDAY.md").exists())
            # init touches only project rules; memory/permissions/skills stay lazy.
            self.assertFalse((root / ".friday").exists())
            self.assertEqual(init_project(root), [])

    def test_build_friday_provisions_user_home_on_first_run(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            home = root / "home"

            with patch("friday.app.Path.home", return_value=home), patch("friday.tools.Path.home", return_value=home):
                build_friday(root, stream=False)

            user_dir = home / ".friday"
            for name in ("SOUL.md", "AGENTS.md", "USER.md", "MEMORY.md"):
                self.assertTrue((user_dir / name).exists(), name)
            self.assertTrue((user_dir / "FridaySkills").is_dir())


class PromptTests(unittest.TestCase):
    def test_prompt_keeps_stable_prefix_order(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "AGENTS.md").write_text("project rules", encoding="utf-8")
            (root / ".friday").mkdir()
            (root / ".friday" / "MEMORY.md").write_text("# Project Memory\n", encoding="utf-8")
            text = build_instructions(root, root / ".friday")

            self.assertLess(text.index("## Soul"), text.index("## Runtime"))
            self.assertLess(text.index("## Runtime"), text.index("## Tool Guidance"))
            self.assertLess(text.index("## Tool Guidance"), text.index("## Global Rules"))
            self.assertLess(text.index("## Global Rules"), text.index("## Project Instructions"))
            self.assertLess(text.index("## Project Instructions"), text.index("## Environment"))
            self.assertIn("## Project Memory", text)
            self.assertNotIn("## Short-Term State", text)
            self.assertIn("project rules", text)

    def test_global_rules_layer_reads_home_agents_md(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            home = root / "home"
            ensure_user_home(home)
            (home / ".friday" / "AGENTS.md").write_text(
                "# Friday Global Rules\n\n## My rules\n- always run tests with uv\n",
                encoding="utf-8",
            )

            with patch("friday.app.Path.home", return_value=home), patch("friday.tools.Path.home", return_value=home):
                text = build_instructions(root, root / ".friday")

            self.assertIn("## Global Rules", text)
            self.assertIn("always run tests with uv", text)

    def test_build_friday_does_not_persist_or_inject_short_term_state(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with patch("friday.app.Path.home", return_value=root / "home"), patch("friday.tools.Path.home", return_value=root / "home"):
                _agent, context = build_friday(root, stream=False)

            self.assertFalse((root / ".friday" / "STATE.md").exists())
            self.assertNotIn("Short-Term State", "".join(str(m.get("content", "")) for m in context.get_messages()))

    def test_build_friday_loads_project_env_without_overriding_shell(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".env").write_text(
                "\ufeffDEEPSEEK_API_KEY=dummy\nTAVILY_API_KEY=from-file\nLLM_MODEL=from-file\n",
                encoding="utf-8",
            )

            with patch.dict(os.environ, {"LLM_MODEL": "from-shell"}, clear=True):
                with patch("friday.app.Path.home", return_value=root / "home"), patch("friday.tools.Path.home", return_value=root / "home"):
                    build_friday(root, stream=False)
                self.assertEqual(os.environ["DEEPSEEK_API_KEY"], "dummy")
                self.assertEqual(os.environ["TAVILY_API_KEY"], "from-file")
                self.assertEqual(os.environ["LLM_MODEL"], "from-shell")

    def test_large_project_instructions_are_truncated(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "AGENTS.md").write_text("x" * (PROJECT_INSTRUCTIONS_LIMIT + 100), encoding="utf-8")
            with patch("friday.app.Path.home", return_value=root / "home"), patch("friday.tools.Path.home", return_value=root / "home"):
                text = build_instructions(root, root / ".friday")

            self.assertIn("[truncated:", text)
            self.assertLess(len(text), PROJECT_INSTRUCTIONS_LIMIT + 8000)


class CompactTests(unittest.TestCase):
    def test_save_turn_writes_one_snapshot_per_session(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sessions = root / ".friday" / "sessions"

            save_turn(root, "hi", "hello", [], "s1", [{"role": "user", "content": "hi"}])
            data = json.loads((sessions / "s1.json").read_text(encoding="utf-8"))
            self.assertEqual(data["session_id"], "s1")
            self.assertEqual(data["turns"], 1)
            self.assertEqual(data["messages"], [{"role": "user", "content": "hi"}])
            self.assertNotIn("events", data)
            self.assertFalse((root / ".friday" / "STATE.md").exists())

            save_turn(root, "hi", "hello again", [], "s1", [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hi2"}])
            updated = json.loads((sessions / "s1.json").read_text(encoding="utf-8"))
            self.assertEqual(updated["turns"], 2)
            self.assertEqual(len(updated["messages"]), 2)
            self.assertEqual(len(list(sessions.glob("*.json"))), 1)

    def test_context_report_breaks_down_prompt_tools_and_messages(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            context = RunContext()
            context.add_message("system", "## Runtime\nrules\n\n## Skill Catalog\n- test: skill")
            context.add_message("user", "hello")
            context.metadata["friday.last_usage"] = {"input_tokens": 123, "output_tokens": 7}
            tools = build_tools(root, root / ".friday")

            report = context_report(context, tools)

            self.assertIn("system prompt", report)
            self.assertIn("skill catalog", report)
            self.assertIn("tool schemas", report)
            self.assertIn("messages", report)
            self.assertIn("input 123 / output 7 / total 130", report)
            self.assertIn("Local est. tokens", report)

    def test_tool_result_compaction_summarizes_structured_output(self) -> None:
        context = RunContext()
        context.emit(
            "tool.call",
            category="tool",
            data={"tool_call_id": "call-1", "name": "Bash", "arguments": {"command": "python big.py"}},
        )
        context.add_message(
            "tool",
            '{"exit_code":0,"timed_out":false,"output":"' + ("x" * 2000) + '"}',
            tool_call_id="call-1",
        )

        count = compact_tool_results(context)

        self.assertEqual(count, 1)
        self.assertIn("Tool: Bash", context.messages[-1]["content"])
        self.assertIn("exit_code=0", context.messages[-1]["content"])
        self.assertLess(len(context.messages[-1]["content"]), 800)

    def test_prepare_context_compacts_tools_when_probe_is_worthwhile(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            context = RunContext()
            context.metadata["workspace"] = tmp
            context.emit("tool.call", category="tool", data={"tool_call_id": "call-1", "name": "Read", "arguments": {"path": "big.txt"}})
            context.add_message("tool", '{"path":"big.txt","content":"' + ("x" * 5000) + '"}', tool_call_id="call-1")

            fake_agent = object()
            with patch.dict("os.environ", {"FRIDAY_CONTEXT_WINDOW": "1000"}):
                agent, new_context, notice = prepare_context_for_chat(fake_agent, context, stream=False)

            self.assertIs(agent, fake_agent)
            self.assertIs(new_context, context)
            self.assertIn("tool results compacted", notice)

    def test_prepare_context_compacts_conversation_when_tool_probe_is_small(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            context = RunContext()
            context.metadata["workspace"] = tmp
            context.add_message("user", "x" * 7000)
            context.emit("tool.call", category="tool", data={"tool_call_id": "call-1", "name": "Bash", "arguments": {"command": "echo ok"}})
            context.add_message("tool", '{"exit_code":0,"output":"' + ("y" * 1000) + '"}', tool_call_id="call-1")

            fake_agent = object()
            rebuilt = RunContext()
            with patch.dict("os.environ", {"FRIDAY_CONTEXT_WINDOW": "2500"}):
                with patch("friday.app.compact_friday", return_value=(object(), rebuilt, "summary")):
                    agent, new_context, notice = prepare_context_for_chat(fake_agent, context, stream=False)

            self.assertIs(new_context, rebuilt)
            self.assertIsNot(agent, fake_agent)
            self.assertIn("conversation compacted", notice)

    def test_compact_saves_memory_and_summarizes_in_one_pass(self) -> None:
        class FakeAgent:
            def __init__(self) -> None:
                self.prompts = []

            def chat(self, prompt, *args, **kwargs) -> str:
                self.prompts.append(prompt)
                return "Continue with the memory harness work."

        class FakeContext:
            def __init__(self) -> None:
                self.messages = []

            def add_message(self, role: str, content: str) -> None:
                self.messages.append({"role": role, "content": content})

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            friday_dir = root / ".friday"
            friday_dir.mkdir()
            (friday_dir / "MEMORY.md").write_text("# Project Memory\n", encoding="utf-8")
            tools = {tool.name: tool for tool in build_tools(root, friday_dir)}
            old_context = tools["Memory"]("read", "project")

            context = type("Context", (), {})()
            context.metadata = {"workspace": str(root)}
            fake_agent = FakeAgent()

            def fake_build(workspace, *, stream=True):
                return object(), FakeContext()

            with patch("friday.app.build_friday", side_effect=fake_build):
                agent, new_context, summary = compact_friday(fake_agent, context, stream=False)

            # Single in-band pass: one chat carrying both the memory step and the schema.
            self.assertEqual(len(fake_agent.prompts), 1)
            self.assertIn("Memory tool", fake_agent.prompts[0])
            self.assertIn("## Current Goal", fake_agent.prompts[0])
            self.assertIn("Recent Conversations", fake_agent.prompts[0])
            self.assertEqual(summary, "Continue with the memory harness work.")
            self.assertEqual(new_context.messages[-1]["role"], "assistant")
            self.assertIn("## Session Summary", new_context.messages[-1]["content"])
            self.assertIn("Continue with the memory harness work.", new_context.messages[-1]["content"])
            self.assertFalse((root / ".friday" / "STATE.md").exists())
            self.assertEqual(old_context["content"], tools["Memory"]("read", "project")["content"])


class VerificationTests(unittest.TestCase):
    def test_verification_is_required_only_for_delivery_changes(self) -> None:
        read_events = [{"type": "tool.call", "data": {"name": "Read", "arguments": {"path": "x.py"}}}]
        write_events = [{"type": "tool.call", "data": {"name": "Edit", "arguments": {"path": "x.py"}}}]
        bash_write_events = [{"type": "tool.call", "data": {"name": "Bash", "arguments": {"command": "Set-Content x.py hi"}}}]

        self.assertFalse(needs_verification(read_events))
        self.assertTrue(needs_verification(write_events))
        self.assertTrue(needs_verification(bash_write_events))

    def test_verifier_prompt_excludes_main_answer(self) -> None:
        prompt = verification_prompt("fix the bug", [{"type": "tool.call", "data": {"name": "Edit", "arguments": {"path": "x.py"}}}])

        self.assertIn("fix the bug", prompt)
        self.assertIn("Do not trust", prompt)
        self.assertNotIn("main answer", prompt.lower())

    def test_verified_chat_repairs_once_when_verifier_fails(self) -> None:
        class FakeAgent:
            def __init__(self) -> None:
                self.prompts = []

            def chat(self, prompt, *args, **kwargs) -> str:
                self.prompts.append(prompt)
                return "answer"

        class FakeContext:
            def __init__(self) -> None:
                self.events = []
                self.metadata = {"workspace": "."}
                self.emitted = []

            def emit(self, event_type: str, **kwargs) -> None:
                self.emitted.append((event_type, kwargs))

        agent = FakeAgent()
        context = FakeContext()
        results = [
            {"passed": False, "feedback": "x.py still fails"},
            {"passed": True, "feedback": ""},
        ]

        with patch("friday.loop.verify_friday", side_effect=results):
            answer, verifications = verified_chat(agent, context, "fix x", "instructions")

        self.assertEqual(answer, "answer")
        self.assertEqual(len(agent.prompts), 2)
        self.assertIn("x.py still fails", agent.prompts[1])
        self.assertEqual([item["passed"] for item in verifications], [False, True])
        self.assertEqual(len(context.emitted), 2)

    def test_goal_chat_loops_until_pass_or_blocked(self) -> None:
        class FakeAgent:
            def __init__(self) -> None:
                self.prompts = []

            def chat(self, prompt, *args, **kwargs) -> str:
                self.prompts.append(prompt)
                return "answer"

        class FakeContext:
            def __init__(self) -> None:
                self.events = []
                self.metadata = {"workspace": "."}
                self.emitted = []

            def emit(self, event_type: str, **kwargs) -> None:
                self.emitted.append((event_type, kwargs))

        results = [
            {"passed": False, "blocked": False, "feedback": "not done"},
            {"passed": True, "blocked": False, "feedback": ""},
        ]
        agent = FakeAgent()
        context = FakeContext()
        with patch("friday.loop.verify_friday", side_effect=results):
            answer, verifications = goal_chat(agent, context, "finish it", "instructions", max_attempts=5)

        self.assertEqual(answer, "answer")
        self.assertEqual(len(agent.prompts), 2)
        self.assertEqual([item["passed"] for item in verifications], [False, True])

        blocked_agent = FakeAgent()
        blocked_context = FakeContext()
        with patch("friday.loop.verify_friday", return_value={"passed": False, "blocked": True, "feedback": "missing dependency"}):
            _answer, blocked = goal_chat(blocked_agent, blocked_context, "finish it", "instructions", max_attempts=5)

        self.assertEqual(len(blocked_agent.prompts), 1)
        self.assertTrue(blocked[0]["blocked"])

    def test_verifier_error_stops_without_repairing(self) -> None:
        class FakeAgent:
            def __init__(self) -> None:
                self.prompts = []

            def chat(self, prompt, *args, **kwargs) -> str:
                self.prompts.append(prompt)
                return "answer"

        class FakeContext:
            def __init__(self) -> None:
                self.events = []
                self.metadata = {"workspace": "."}
                self.emitted = []

            def emit(self, event_type: str, **kwargs) -> None:
                self.emitted.append((event_type, kwargs))

        error = {"passed": False, "error": True, "feedback": "Verifier failed"}
        agent = FakeAgent()
        context = FakeContext()

        with patch("friday.loop.verify_friday", return_value=error):
            answer, verifications = verified_chat(agent, context, "fix x", "instructions")

        self.assertEqual(answer, "answer")
        self.assertEqual(len(agent.prompts), 1)
        self.assertTrue(verifications[0]["error"])

    def test_pending_approval_stops_without_repairing(self) -> None:
        class FakeAgent:
            def __init__(self) -> None:
                self.prompts = []

            def chat(self, prompt, *args, **kwargs) -> str:
                self.prompts.append(prompt)
                return "answer"

        class FakeContext:
            def __init__(self) -> None:
                self.events = []
                self.metadata = {"workspace": "."}
                self.emitted = []

            def emit(self, event_type: str, **kwargs) -> None:
                self.emitted.append((event_type, kwargs))

        pending = {"passed": False, "approval_required": True, "feedback": "Approve first"}
        agent = FakeAgent()
        context = FakeContext()

        with patch("friday.loop.verify_friday", return_value=pending):
            _answer, verifications = verified_chat(agent, context, "delete x", "instructions")

        self.assertEqual(len(agent.prompts), 1)
        self.assertTrue(verifications[0]["approval_required"])

    def test_parse_verification_accepts_blocked(self) -> None:
        parsed = parse_verification('{"passed": false, "blocked": true, "evidence": ["x"], "feedback": "cannot"}')

        self.assertTrue(parsed["blocked"])
        self.assertFalse(parsed["passed"])
        self.assertEqual(AGENT_MAX_STEPS, 10000)
        self.assertEqual(VERIFIER_MAX_STEPS, 10000)


class ResumeTests(unittest.TestCase):
    def test_resume_without_snapshot_restores_no_body(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sessions = root / ".friday" / "sessions"
            sessions.mkdir(parents=True)
            (sessions / "s1.json").write_text(
                json.dumps({"session_id": "s1", "turns": 1, "user": "hi", "assistant": "hello"}),
                encoding="utf-8",
            )

            home = root / "home"
            with patch("friday.app.Path.home", return_value=home), patch("friday.tools.Path.home", return_value=home):
                agent, context, count = resume_friday(root, stream=False)

            self.assertEqual(count, 1)
            self.assertEqual(context.metadata["session_id"], "s1")
            self.assertEqual([m for m in context.get_messages() if m.get("role") != "system"], [])
            self.assertNotIn("Resumed Session", "".join(str(m.get("content", "")) for m in context.get_messages()))

    def test_resume_rebuilds_fresh_prefix_and_restores_body(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot = [
                {"role": "system", "content": "stale prefix"},
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": "hello"},
            ]

            save_turn(root, "hi", "hello", [], "s1", snapshot)
            home = root / "home"
            with patch("friday.app.Path.home", return_value=home), patch("friday.tools.Path.home", return_value=home):
                _agent, resumed, count = resume_friday(root, stream=False)

            messages = resumed.get_messages()
            non_system = [m for m in messages if m.get("role") != "system"]
            self.assertEqual(count, 1)
            self.assertEqual(non_system, [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}])
            self.assertEqual(messages[0]["role"], "system")
            self.assertNotIn("stale prefix", "".join(str(m.get("content", "")) for m in messages if m.get("role") == "system"))

    def test_resume_can_select_session(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sessions = root / ".friday" / "sessions"
            sessions.mkdir(parents=True)
            (sessions / "s1.json").write_text(
                json.dumps(
                    {
                        "session_id": "s1",
                        "turns": 2,
                        "updated": "2",
                        "user": "first",
                        "assistant": "one more",
                        "messages": [
                            {"role": "user", "content": "first"},
                            {"role": "assistant", "content": "one"},
                            {"role": "user", "content": "follow"},
                            {"role": "assistant", "content": "one more"},
                        ],
                    }
                ),
                encoding="utf-8",
            )
            (sessions / "s2.json").write_text(
                json.dumps(
                    {
                        "session_id": "s2",
                        "turns": 1,
                        "updated": "3",
                        "user": "second",
                        "assistant": "two",
                        "messages": [
                            {"role": "user", "content": "second"},
                            {"role": "assistant", "content": "two"},
                        ],
                    }
                ),
                encoding="utf-8",
            )

            choices = resume_choices(root)
            home = root / "home"
            with patch("friday.app.Path.home", return_value=home), patch("friday.tools.Path.home", return_value=home):
                agent, context, count = resume_friday(root, stream=False, resume_id=choices[1]["id"])

            non_system = [m for m in context.get_messages() if m.get("role") != "system"]
            self.assertEqual([choice["id"] for choice in choices], ["s2", "s1"])
            self.assertEqual(count, 2)
            self.assertEqual(choices[1]["turns"], "2")
            self.assertEqual(context.metadata["session_id"], "s1")
            self.assertEqual(non_system[-1], {"role": "assistant", "content": "one more"})
            self.assertIn({"role": "user", "content": "follow"}, non_system)
            self.assertNotIn({"role": "user", "content": "second"}, non_system)


if __name__ == "__main__":
    unittest.main()
