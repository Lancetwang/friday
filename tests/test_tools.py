from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agent_core import RunContext

from friday.app import PROJECT_INSTRUCTIONS_LIMIT, STATE_FILE, build_friday, build_instructions, compact_friday, init_project, prepare_context_for_chat, reset_friday, resume_choices, resume_friday, save_turn
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
            (root / "src" / "FRIDAY.md").write_text("friday src rules", encoding="utf-8")
            (root / "src" / "app.py").write_text("print('hi')\n", encoding="utf-8")
            tools = {tool.name: tool for tool in build_tools(root, root / ".friday")}

            first = tools["Read"]("src/app.py")
            second = tools["Read"]("src/app.py")

            self.assertEqual(first["context"][0]["path"].replace("\\", "/"), "src/AGENTS.md")
            self.assertIn("src rules", first["context"][0]["content"])
            self.assertEqual(first["context"][1]["path"].replace("\\", "/"), "src/FRIDAY.md")
            self.assertIn("friday src rules", first["context"][1]["content"])
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
            (state / "sessions" / "x.jsonl").write_text("{}", encoding="utf-8")
            (global_state / "MEMORY.md").write_text("old", encoding="utf-8")
            (global_state / "USER.md").write_text("old", encoding="utf-8")
            (global_state / "SOUL.md").write_text("old", encoding="utf-8")

            reset_friday(root, user_home=home)

            self.assertEqual((state / "MEMORY.md").read_text(encoding="utf-8"), "# Project Memory\n")
            self.assertFalse((state / "sessions").exists())
            self.assertEqual((global_state / "MEMORY.md").read_text(encoding="utf-8"), "# User Memory\n")
            self.assertIn("Friday Soul", (global_state / "SOUL.md").read_text(encoding="utf-8"))

    def test_init_migrates_legacy_prompt_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            home = root / "home"
            user_dir = home / ".friday"
            user_dir.mkdir(parents=True)
            (user_dir / "soul.md").write_text("legacy soul", encoding="utf-8")
            (user_dir / "user.md").write_text("legacy user", encoding="utf-8")

            init_project(root, user_home=home)

            self.assertEqual((user_dir / "SOUL.md").read_text(encoding="utf-8"), "legacy soul")
            self.assertEqual((user_dir / "USER.md").read_text(encoding="utf-8"), "legacy user")
            names = {path.name for path in user_dir.iterdir()}
            self.assertIn("SOUL.md", names)
            self.assertIn("USER.md", names)
            self.assertNotIn("soul.md", names)
            self.assertNotIn("user.md", names)

    def test_init_creates_friday_project_files_not_agents_md(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            home = root / "home"

            init_project(root, user_home=home)

            self.assertTrue((root / "FRIDAY.md").exists())
            self.assertFalse((root / "AGENTS.md").exists())
            self.assertTrue((root / ".friday" / "MEMORY.md").exists())
            self.assertTrue((root / ".friday" / STATE_FILE).exists())
            self.assertTrue((root / ".friday" / PERMISSIONS_FILE).exists())


class PromptTests(unittest.TestCase):
    def test_prompt_keeps_stable_prefix_order(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "AGENTS.md").write_text("project rules", encoding="utf-8")
            (root / "FRIDAY.md").write_text("friday rules", encoding="utf-8")
            (root / ".friday").mkdir()
            (root / ".friday" / "MEMORY.md").write_text("# Project Memory\n", encoding="utf-8")
            (root / ".friday" / STATE_FILE).write_text("# Short-Term State\n", encoding="utf-8")
            text = build_instructions(root, root / ".friday")

            self.assertLess(text.index("## Soul"), text.index("## Runtime"))
            self.assertLess(text.index("## Runtime"), text.index("## Tool Guidance"))
            self.assertLess(text.index("## Tool Guidance"), text.index("## Project Instructions"))
            self.assertLess(text.index("## Project Instructions"), text.index("## Environment"))
            self.assertIn("## Project Memory", text)
            self.assertNotIn("## Short-Term State", text)
            self.assertLess(text.index("AGENTS.md"), text.index("FRIDAY.md"))
            self.assertIn("friday rules", text)

    def test_short_term_state_is_not_part_of_stable_instructions(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            init_project(root, user_home=root / "home")
            (root / ".friday" / STATE_FILE).write_text("# Short-Term State\n\n## Current Goal\nship it\n", encoding="utf-8")

            with patch("friday.app.Path.home", return_value=root / "home"), patch("friday.tools.Path.home", return_value=root / "home"):
                instructions = build_instructions(root, root / ".friday")
                _agent, context = build_friday(root, stream=False)

            self.assertNotIn("ship it", instructions)
            self.assertIn("ship it", context.get_messages()[-1]["content"])

    def test_large_project_instructions_are_truncated(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "AGENTS.md").write_text("x" * (PROJECT_INSTRUCTIONS_LIMIT + 100), encoding="utf-8")
            with patch("friday.app.Path.home", return_value=root / "home"), patch("friday.tools.Path.home", return_value=root / "home"):
                text = build_instructions(root, root / ".friday")

            self.assertIn("[truncated:", text)
            self.assertLess(len(text), PROJECT_INSTRUCTIONS_LIMIT + 4000)


class CompactTests(unittest.TestCase):
    def test_save_turn_updates_short_term_recent_conversations(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            init_project(root, user_home=root / "home")

            for index in range(12):
                save_turn(root, f"user {index}", f"assistant {index}", [], "s1")

            state = (root / ".friday" / STATE_FILE).read_text(encoding="utf-8")
            row = json.loads(next((root / ".friday" / "sessions").glob("*.jsonl")).read_text(encoding="utf-8").splitlines()[-1])
            self.assertIn("## Recent Conversations", state)
            self.assertNotIn("user 0", state)
            self.assertIn("user 11", state)
            self.assertEqual(state.count("- User:"), 10)
            self.assertNotIn("events", row)

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

    def test_compact_reviews_memory_then_rebuilds_context(self) -> None:
        class FakeAgent:
            def __init__(self) -> None:
                self.prompts = []

            def chat(self, prompt, *args, **kwargs) -> str:
                self.prompts.append(prompt)
                if "Before compacting" in prompt:
                    return "No durable memory updates."
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
                rebuilt = FakeContext()
                rebuilt.add_message("system", "## Short-Term State\n" + (Path(workspace) / ".friday" / STATE_FILE).read_text(encoding="utf-8"))
                return object(), rebuilt

            with patch("friday.app.build_friday", side_effect=fake_build):
                agent, new_context, summary = compact_friday(fake_agent, context, stream=False)

            self.assertIn("Before compacting", fake_agent.prompts[0])
            self.assertIn("Compact the conversation", fake_agent.prompts[1])
            self.assertIn("## Current Goal", fake_agent.prompts[1])
            self.assertIn("Recent Conversations", fake_agent.prompts[1])
            self.assertEqual(summary, "Continue with the memory harness work.")
            self.assertIn("Short-Term State", new_context.messages[-1]["content"])
            self.assertEqual((root / ".friday" / STATE_FILE).read_text(encoding="utf-8"), "Continue with the memory harness work.\n")
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
    def test_resume_adds_recent_session_context(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sessions = root / ".friday" / "sessions"
            sessions.mkdir(parents=True)
            (sessions / "20260701.jsonl").write_text(
                '{"session_id":"s1","user":"hi","assistant":"hello","events":[]}\n',
                encoding="utf-8",
            )

            agent, context, count = resume_friday(root, stream=False)

            self.assertEqual(count, 1)
            self.assertIn("Resumed Session", context.messages[-1]["content"])
            self.assertIn("User: hi", context.messages[-1]["content"])

    def test_resume_restores_full_message_snapshot_when_available(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            context = RunContext()
            context.add_message("system", "prefix")
            context.add_message("user", "hi")
            context.add_message("assistant", "hello")

            save_turn(root, "hi", "hello", [], "s1", context.get_messages())
            _agent, resumed, count = resume_friday(root, stream=False)

            self.assertEqual(count, 1)
            self.assertEqual(resumed.get_messages(), context.get_messages())
            self.assertNotIn("Resumed Session", resumed.get_messages()[-1]["content"])

    def test_resume_clears_legacy_rows_without_session_id(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sessions = root / ".friday" / "sessions"
            sessions.mkdir(parents=True)
            path = sessions / "20260701.jsonl"
            path.write_text(
                '{"time":"1","user":"old","assistant":"legacy","events":[]}\n'
                '{"time":"2","session_id":"s1","user":"new","assistant":"fresh","events":[]}\n',
                encoding="utf-8",
            )

            choices = resume_choices(root)

            self.assertEqual(len(choices), 1)
            self.assertEqual(choices[0]["user"], "new")
            self.assertNotIn("legacy", path.read_text(encoding="utf-8"))

    def test_resume_can_select_session(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sessions = root / ".friday" / "sessions"
            sessions.mkdir(parents=True)
            (sessions / "20260701.jsonl").write_text(
                '{"time":"1","session_id":"s1","user":"first","assistant":"one","events":[]}\n'
                '{"time":"2","session_id":"s1","user":"follow","assistant":"one more","events":[]}\n'
                '{"time":"3","session_id":"s2","user":"second","assistant":"two","events":[]}\n',
                encoding="utf-8",
            )

            choices = resume_choices(root)
            agent, context, count = resume_friday(root, stream=False, resume_id=choices[1]["id"])

            self.assertEqual(count, 2)
            self.assertEqual(choices[1]["turns"], "2")
            self.assertIn("User: first", context.messages[-1]["content"])
            self.assertIn("User: follow", context.messages[-1]["content"])
            self.assertNotIn("User: second", context.messages[-1]["content"])


if __name__ == "__main__":
    unittest.main()
