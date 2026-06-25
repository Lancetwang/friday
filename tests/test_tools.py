from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from friday.app import reset_friday
from friday.tools import build_tools


class ToolTests(unittest.TestCase):
    def test_file_tools_stay_inside_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tools = {tool.name: tool for tool in build_tools(root, root / ".friday")}

            tools["write_file"]("note.txt", "hello")
            read = tools["read_file"]("note.txt")
            self.assertIn("hello", read["content"])

            tools["edit_file"]("note.txt", "hi", old_text="hello")
            self.assertIn("hi", tools["read_file"]("note.txt")["content"])

            with self.assertRaises(ValueError):
                tools["read_file"]("../escape.txt")

    def test_read_and_edit_line_ranges(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tools = {tool.name: tool for tool in build_tools(root, root / ".friday")}
            tools["write_file"]("note.txt", "one\ntwo\nthree\nfour\n")

            read = tools["read_file"]("note.txt", start_line=2, line_count=2)
            self.assertEqual(read["content"], "2: two\n3: three")
            self.assertEqual(read["end_line"], 3)

            result = tools["edit_file"]("note.txt", "TWO\nTHREE", start_line=2, end_line=3)
            self.assertEqual(result["mode"], "line_range")
            self.assertEqual((root / "note.txt").read_text(encoding="utf-8"), "one\nTWO\nTHREE\nfour\n")

            tools["edit_file"]("note.txt", "inserted", start_line=2, end_line=0)
            self.assertEqual(
                (root / "note.txt").read_text(encoding="utf-8"),
                "one\ninserted\nTWO\nTHREE\nfour\n",
            )

            tools["edit_file"]("note.txt", "", start_line=1, end_line=5)
            self.assertEqual((root / "note.txt").read_text(encoding="utf-8"), "")

    def test_run_shell_returns_errors(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tools = {tool.name: tool for tool in build_tools(root, root / ".friday")}

            result = tools["run_shell"]("exit 7")
            self.assertEqual(result["exit_code"], 7)
            self.assertFalse(result["timed_out"])

    def test_memory_appends(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tools = {tool.name: tool for tool in build_tools(root, root / ".friday")}

            tools["remember"]("Friday should be concise.", "project")
            memory = tools["read_memory"]("project")
            self.assertIn("Friday should be concise.", memory["content"])


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
            (global_state / "user.md").write_text("old", encoding="utf-8")
            (global_state / "soul.md").write_text("old", encoding="utf-8")

            reset_friday(root, user_home=home)

            self.assertEqual((state / "MEMORY.md").read_text(encoding="utf-8"), "# Project Memory\n")
            self.assertFalse((state / "sessions").exists())
            self.assertEqual((global_state / "MEMORY.md").read_text(encoding="utf-8"), "# User Memory\n")
            self.assertIn("Friday Soul", (global_state / "soul.md").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
