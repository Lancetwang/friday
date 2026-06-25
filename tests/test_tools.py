from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from friday.tools import build_tools


class ToolTests(unittest.TestCase):
    def test_file_tools_stay_inside_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tools = {tool.name: tool for tool in build_tools(root, root / ".friday")}

            tools["write_file"]("note.txt", "hello")
            read = tools["read_file"]("note.txt")
            self.assertIn("hello", read["content"])

            tools["edit_file"]("note.txt", "hello", "hi")
            self.assertIn("hi", tools["read_file"]("note.txt")["content"])

            with self.assertRaises(ValueError):
                tools["read_file"]("../escape.txt")

    def test_memory_appends(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tools = {tool.name: tool for tool in build_tools(root, root / ".friday")}

            tools["remember"]("Friday should be concise.", "project")
            memory = tools["read_memory"]("project")
            self.assertIn("Friday should be concise.", memory["content"])


if __name__ == "__main__":
    unittest.main()
