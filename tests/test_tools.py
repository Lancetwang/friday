from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from friday.app import PROJECT_INSTRUCTIONS_LIMIT, build_instructions, compact_friday, init_project, reset_friday
from friday.tools import build_tools, skill_catalog


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

    def test_nested_agents_context_is_loaded_once_for_touched_paths(self) -> None:
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


class PromptTests(unittest.TestCase):
    def test_prompt_keeps_stable_prefix_order(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "AGENTS.md").write_text("project rules", encoding="utf-8")
            text = build_instructions(root, root / ".friday")

            self.assertLess(text.index("## Soul"), text.index("## Runtime"))
            self.assertLess(text.index("## Runtime"), text.index("## Tool Guidance"))
            self.assertLess(text.index("## Tool Guidance"), text.index("## Project Instructions"))
            self.assertLess(text.index("## Project Instructions"), text.index("## Environment"))

    def test_large_project_instructions_are_truncated(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "AGENTS.md").write_text("x" * (PROJECT_INSTRUCTIONS_LIMIT + 100), encoding="utf-8")
            with patch("friday.app.Path.home", return_value=root / "home"), patch("friday.tools.Path.home", return_value=root / "home"):
                text = build_instructions(root, root / ".friday")

            self.assertIn("[truncated:", text)
            self.assertLess(len(text), PROJECT_INSTRUCTIONS_LIMIT + 3000)


class CompactTests(unittest.TestCase):
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
            with patch("friday.app.build_friday", return_value=(object(), FakeContext())):
                agent, new_context, summary = compact_friday(fake_agent, context, stream=False)

            self.assertIn("Before compacting", fake_agent.prompts[0])
            self.assertIn("Summarize the conversation", fake_agent.prompts[1])
            self.assertEqual(summary, "Continue with the memory harness work.")
            self.assertIn("Conversation Summary", new_context.messages[-1]["content"])
            self.assertEqual(old_context["content"], tools["Memory"]("read", "project")["content"])


if __name__ == "__main__":
    unittest.main()
