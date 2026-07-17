from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from friday.memory import (
    add_memory,
    capture_user_memory,
    list_memories,
    relevant_memory,
    remove_memory,
    search_memories,
    update_memory,
)


class MemoryTests(unittest.TestCase):
    def test_markdown_memory_supports_lifecycle_without_a_database(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "workspace"
            home = Path(tmp) / "home"
            root.mkdir()

            added = add_memory(root, "user", "Preferred language is Chinese.", home=home, source="user")
            duplicate = add_memory(root, "user", "Preferred language is Chinese.", home=home, source="user")

            self.assertTrue(duplicate["duplicate"])
            self.assertEqual(len(list_memories(root, scope="user", home=home)), 1)
            self.assertIn("friday-memory", (home / ".friday" / "USER.md").read_text(encoding="utf-8"))

            update_memory(root, added["id"], "Default response language is Chinese.", home=home)
            self.assertEqual(search_memories(root, "Chinese", home=home)[0]["content"], "Default response language is Chinese.")

            remove_memory(root, added["id"], home=home)
            self.assertEqual(list_memories(root, scope="user", home=home), [])

    def test_explicit_user_signal_is_captured_and_recalled_from_daily_markdown(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "workspace"
            home = Path(tmp) / "home"
            root.mkdir()

            captured = capture_user_memory(root, "以后请默认使用中文回答，不要写套话。", session_id="s1", home=home)

            self.assertIsNotNone(captured)
            self.assertTrue(list((home / ".friday" / "memory").glob("*.md")))
            self.assertIn("默认使用中文回答", (home / ".friday" / "USER.md").read_text(encoding="utf-8"))
            self.assertIn("默认使用中文回答", relevant_memory(root, "请用中文回答", home=home))
            self.assertIsNone(capture_user_memory(root, "帮我读取这个文件。", home=home))

    def test_credentials_are_never_captured(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "workspace"
            home = Path(tmp) / "home"
            root.mkdir()

            captured = capture_user_memory(root, "记住我的 token=hf_abcdefghijklmnopqrstuvwxyz", home=home)

            self.assertIsNone(captured)
            self.assertEqual(list_memories(root, scope="episode", home=home), [])

    def test_project_like_future_instruction_does_not_pollute_hot_user_profile(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "workspace"
            home = Path(tmp) / "home"
            root.mkdir()

            capture_user_memory(root, "以后这个分支不用处理 TUI。", session_id="s1", home=home)

            self.assertEqual(list_memories(root, scope="user", home=home), [])
            self.assertEqual(len(list_memories(root, scope="episode", home=home)), 1)

            capture_user_memory(root, "我喜欢这个方案。", session_id="s1", home=home)
            self.assertEqual(list_memories(root, scope="user", home=home), [])


if __name__ == "__main__":
    unittest.main()
