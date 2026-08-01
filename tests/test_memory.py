from __future__ import annotations

import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

from friday.memory import (
    add_memory,
    capture_user_memory,
    consolidate_memory,
    list_memories,
    load_user_profile_settings,
    relevant_memory,
    remove_memory,
    run_memory_command,
    search_memories,
    save_user_profile_settings,
    update_memory,
)


class MemoryTests(unittest.TestCase):
    def test_user_profile_form_preserves_manual_content_and_memory_boundaries(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "workspace"
            home = Path(tmp) / "home"
            root.mkdir()
            path = home / ".friday" / "USER.md"
            path.parent.mkdir(parents=True)
            path.write_text("# User Profile\n\n- Keep this manual memory.\n", encoding="utf-8")

            saved = save_user_profile_settings(
                {
                    "preferred_name": "Kai",
                    "preferred_language": "Chinese",
                    "habits": "- Keep answers concise.\n- Use PowerShell examples.",
                },
                home=home,
            )

            self.assertEqual(load_user_profile_settings(home=home), saved)
            self.assertEqual([item["content"] for item in list_memories(root, scope="user", home=home)], ["Keep this manual memory."])
            self.assertEqual(path.read_text(encoding="utf-8").count("friday-profile:start"), 1)

            save_user_profile_settings({"preferred_name": "", "preferred_language": "", "habits": ""}, home=home)
            self.assertNotIn("friday-profile:start", path.read_text(encoding="utf-8"))
            self.assertIn("Keep this manual memory.", path.read_text(encoding="utf-8"))

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
            self.assertEqual(list_memories(root, scope="user", home=home), [])
            self.assertIn("默认使用中文回答", relevant_memory(root, "请用中文回答", home=home))
            self.assertIsNone(capture_user_memory(root, "帮我读取这个文件。", home=home))

    def test_permanent_signal_skips_episode_and_uses_appropriate_scope(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "workspace"
            home = Path(tmp) / "home"
            root.mkdir()

            capture_user_memory(root, "永远记住我喜欢使用中文。", home=home)
            capture_user_memory(root, "始终记住这个项目不处理 TUI。", home=home)
            capture_user_memory(root, "永远不要忘记本机默认使用 PowerShell。", home=home)

            self.assertEqual(len(list_memories(root, scope="episode", home=home)), 0)
            self.assertEqual(len(list_memories(root, scope="user", home=home)), 1)
            self.assertEqual(len(list_memories(root, scope="project", home=home)), 1)
            self.assertEqual(len(list_memories(root, scope="global", home=home)), 1)

    def test_duplicate_episode_increments_count_and_consolidation_promotes_it(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "workspace"
            home = Path(tmp) / "home"
            root.mkdir()
            now = datetime(2026, 7, 20, 12, 0)

            first = add_memory(root, "episode", "The machine uses PowerShell.", home=home, now=now)
            duplicate = add_memory(root, "episode", "The machine uses PowerShell.", home=home, now=now)
            self.assertEqual(duplicate["count"], 2)

            operations = [{"action": "promote", "source_ids": [first["id"]], "content": "The machine uses PowerShell.", "scope": "global"}]
            with patch("friday.memory._review_memory", return_value=operations):
                result = consolidate_memory(root, days=2, home=home, now=now)

            self.assertEqual(result["promoted"], 1)
            self.assertEqual(list_memories(root, scope="episode", home=home), [])
            self.assertEqual(list_memories(root, scope="global", home=home)[0]["content"], "The machine uses PowerShell.")

    def test_consolidation_merges_semantic_duplicates_and_sums_counts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "workspace"
            home = Path(tmp) / "home"
            root.mkdir()
            now = datetime(2026, 7, 20, 12, 0)

            first = add_memory(root, "episode", "Prefer concise answers.", home=home, now=now)
            second = add_memory(root, "episode", "Do not make answers verbose.", home=home, now=now)
            operations = [{"action": "merge", "source_ids": [first["id"], second["id"]], "content": "Prefer concise answers."}]
            with patch("friday.memory._review_memory", return_value=operations):
                result = consolidate_memory(root, days=2, home=home, now=now)

            memories = list_memories(root, scope="episode", home=home)
            self.assertEqual(result["merged"], 1)
            self.assertEqual(len(memories), 1)
            self.assertEqual(memories[0]["count"], 2)

    def test_memory_command_exposes_consolidation_to_chat_and_tui(self) -> None:
        result = {"reviewed": 0, "merged": 0, "promoted": 0, "remaining": 0}
        with patch("friday.memory.consolidate_memory", return_value=result) as consolidate:
            self.assertEqual(run_memory_command("consolidate --days 3", Path.cwd()), result)
        consolidate.assert_called_once_with(Path.cwd(), days=3, home=None)

    def test_consolidation_never_promotes_another_workspace_episode_to_project(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "workspace"
            other = Path(tmp) / "other"
            home = Path(tmp) / "home"
            root.mkdir()
            other.mkdir()
            now = datetime(2026, 7, 20, 12, 0)
            episode = add_memory(other, "episode", "This project uses uv.", home=home, now=now, count=2)
            operations = [{"action": "promote", "source_ids": [episode["id"]], "content": "This project uses uv.", "scope": "project"}]

            with patch("friday.memory._review_memory", return_value=operations):
                result = consolidate_memory(root, days=2, home=home, now=now)

            self.assertEqual(result["promoted"], 0)
            self.assertEqual(list_memories(root, scope="project", home=home), [])

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
