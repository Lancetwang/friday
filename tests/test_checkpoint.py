from __future__ import annotations

import os
import json
import shutil
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from agent_core import RunContext

from friday.checkpoint import begin_checkpoint, checkpoint_artifacts, checkpoint_choices, discard_checkpoint, finish_checkpoint, restore_checkpoint
from friday.app import undo_friday
from friday.state import delete_session, save_turn
from friday.storage import checkpoint_dir, project_state_dir
from friday.trace import begin_live_trace


class CheckpointTests(unittest.TestCase):
    def setUp(self) -> None:
        self.storage = tempfile.TemporaryDirectory()
        self.environment = patch.dict(
            os.environ,
            {
                "FRIDAY_CHECKPOINT_DIR": str(Path(self.storage.name) / "checkpoints"),
                "FRIDAY_HOME": str(Path(self.storage.name) / "home" / ".friday"),
                "FRIDAY_OBSERVABILITY_DIR": str(Path(self.storage.name) / "traces"),
            },
        )
        self.environment.start()

    def tearDown(self) -> None:
        self.environment.stop()
        self.storage.cleanup()

    def test_restore_reverts_modified_and_created_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            original = root / "original.txt"
            created = root / "created.txt"
            original.write_text("before", encoding="utf-8")
            checkpoint_id = self._begin(root)

            original.write_text("after", encoding="utf-8")
            created.write_text("new", encoding="utf-8")
            finish_checkpoint(root, checkpoint_id, pending=False)

            restored = restore_checkpoint(root)

            self.assertEqual(original.read_text(encoding="utf-8"), "before")
            self.assertFalse(created.exists())
            self.assertEqual(restored["messages"][0]["content"], "stable prefix")
            self.assertEqual(set(restored["changed_paths"]), {"created.txt", "original.txt"})
            self.assertEqual(checkpoint_choices(root), [])

    def test_checkpoint_does_not_require_git_on_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patch("shutil.which", return_value=None):
            root = Path(tmp)
            path = root / "work.txt"
            ignored = root / "generated" / "cache.txt"
            ignored.parent.mkdir()
            (root / ".gitignore").write_text("generated/\n", encoding="utf-8")
            path.write_text("before", encoding="utf-8")
            ignored.write_text("before", encoding="utf-8")
            checkpoint_id = self._begin(root)
            path.write_text("after", encoding="utf-8")
            ignored.write_text("after", encoding="utf-8")
            finish_checkpoint(root, checkpoint_id, pending=False)

            restore_checkpoint(root)

            self.assertEqual(path.read_text(encoding="utf-8"), "before")
            self.assertEqual(ignored.read_text(encoding="utf-8"), "after")

    def test_checkpoint_reports_previewable_artifacts_only(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            checkpoint_id = self._begin(root)
            (root / "report.md").write_text("# Result", encoding="utf-8")
            (root / "script.py").write_text("print('done')", encoding="utf-8")

            entry = finish_checkpoint(root, checkpoint_id, pending=False)

            self.assertEqual(
                checkpoint_artifacts(root, entry),
                [{"kind": "markdown", "name": "report.md", "path": "report.md", "size": 8}],
            )

    def test_discard_removes_a_cancelled_checkpoint(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            checkpoint_id = self._begin(root)

            discard_checkpoint(root, checkpoint_id)

            self.assertEqual(checkpoint_choices(root), [])

    def test_restore_refuses_unrecorded_workspace_changes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root / "work.txt"
            path.write_text("before", encoding="utf-8")
            checkpoint_id = self._begin(root)
            path.write_text("friday", encoding="utf-8")
            finish_checkpoint(root, checkpoint_id, pending=False)
            path.write_text("user edit", encoding="utf-8")

            with self.assertRaisesRegex(RuntimeError, "Workspace changed"):
                restore_checkpoint(root)

            restore_checkpoint(root, force=True)
            self.assertEqual(path.read_text(encoding="utf-8"), "before")

    def test_restore_does_not_rewrite_unchanged_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stable = root / "stable.txt"
            changed = root / "changed.txt"
            stable.write_text("stable", encoding="utf-8")
            changed.write_text("before", encoding="utf-8")
            checkpoint_id = self._begin(root)
            changed.write_text("after", encoding="utf-8")
            finish_checkpoint(root, checkpoint_id, pending=False)
            old_time = time.time() - 3600
            os.utime(stable, (old_time, old_time))

            restore_checkpoint(root)

            self.assertEqual(changed.read_text(encoding="utf-8"), "before")
            self.assertAlmostEqual(stable.stat().st_mtime, old_time, delta=2)

    def test_undo_rebuilds_prefix_and_rewinds_saved_session(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sessions = root / ".friday" / "sessions"
            sessions.mkdir(parents=True)
            session_path = sessions / "session-1.json"
            session_path.write_text(
                json.dumps(
                    {
                        "session_id": "session-1",
                        "created": "2026-01-01T00:00:00",
                        "updated": "2026-01-01T00:00:01",
                        "turns": 1,
                        "user": "first request",
                        "assistant": "first answer",
                        "messages": [],
                        "progress": {"objective": "first request"},
                    }
                ),
                encoding="utf-8",
            )
            context = RunContext(metadata={"workspace": str(root), "session_id": "session-1"})
            context.add_message("system", "old prefix")
            context.add_message("user", "first request")
            context.add_message("assistant", "first answer")
            _path, turn_id = begin_live_trace(
                root,
                context=context,
                mode="chat",
                user="second request",
                prompt_messages=context.get_messages(),
            )
            checkpoint_id = begin_checkpoint(
                root,
                session_id="session-1",
                turn_id=turn_id,
                user="second request",
                progress={"objective": "first request", "mode": "normal", "status": "done"},
            )
            (root / "changed.txt").write_text("new", encoding="utf-8")
            finish_checkpoint(root, checkpoint_id, pending=False)

            fresh = RunContext(metadata={"workspace": str(root), "session_id": "fresh"})
            fresh.add_message("system", "new prefix")
            with patch("friday.app.build_friday", return_value=(object(), fresh)):
                _agent, restored_context, _restored = undo_friday(root, stream=False)

            messages = restored_context.get_messages()
            self.assertEqual(messages[0]["content"], "new prefix")
            self.assertEqual([message["content"] for message in messages if message["role"] == "user"], ["first request"])
            self.assertFalse((root / "changed.txt").exists())
            saved = json.loads(session_path.read_text(encoding="utf-8"))
            self.assertEqual(saved["turns"], 1)

    def test_checkpoint_history_is_bounded_and_remaining_trees_survive_gc(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patch("friday.checkpoint.MAX_CHECKPOINTS", 2):
            root = Path(tmp)
            ids = []
            for index in range(3):
                (root / "work.txt").write_text(str(index), encoding="utf-8")
                checkpoint_id = self._begin(root)
                (root / "work.txt").write_text(f"done-{index}", encoding="utf-8")
                finish_checkpoint(root, checkpoint_id, pending=False)
                ids.append(checkpoint_id)

            choices = checkpoint_choices(root)
            self.assertEqual([choice["id"] for choice in choices], list(reversed(ids[-2:])))
            restored = restore_checkpoint(root, checkpoint_id=ids[-2], force=True)
            self.assertEqual(restored["id"], ids[-2])

    def test_deleting_a_session_removes_its_recovery_and_tool_artifacts_when_pack_is_locked(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            save_turn(root, "change", "done", "session-delete", [])
            context = RunContext(metadata={"workspace": str(root), "session_id": "session-delete"})
            path, turn_id = begin_live_trace(
                root,
                context=context,
                mode="chat",
                user="change",
                prompt_messages=[],
            )
            checkpoint_id = begin_checkpoint(
                root,
                session_id="session-delete",
                turn_id=turn_id,
                user="change",
                progress={},
            )
            finish_checkpoint(root, checkpoint_id, pending=False)
            artifacts = project_state_dir(root) / "tool-results" / "session-delete"
            artifacts.mkdir(parents=True)
            (artifacts / "bash.txt").write_text("large output", encoding="utf-8")

            with patch("friday.checkpoint.porcelain.gc", side_effect=PermissionError("pack is locked")):
                delete_session(root, "session-delete")

            self.assertFalse(path.parent.exists())
            self.assertFalse(artifacts.exists())
            self.assertEqual(checkpoint_choices(root), [])

    def test_missing_internal_git_refs_are_repaired_without_a_project_repo(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "work.txt").write_text("before", encoding="utf-8")
            first = self._begin(root)
            (root / "work.txt").write_text("after", encoding="utf-8")
            finish_checkpoint(root, first, pending=False)
            repo = checkpoint_dir(root) / "repo.git"
            shutil.rmtree(repo / "refs")

            second = self._begin(root)
            finish_checkpoint(root, second, pending=False)

            self.assertTrue((repo / "refs").is_dir())
            self.assertEqual([choice["id"] for choice in checkpoint_choices(root)], [second, first])

    def _begin(self, root: Path) -> str:
        context = RunContext(metadata={"workspace": str(root), "session_id": "session-1"})
        context.add_message("system", "stable prefix")
        _path, turn_id = begin_live_trace(
            root,
            context=context,
            mode="chat",
            user="change files",
            prompt_messages=context.get_messages(),
        )
        return begin_checkpoint(
            root,
            session_id="session-1",
            turn_id=turn_id,
            user="change files",
            progress={"objective": "previous goal"},
        )


if __name__ == "__main__":
    unittest.main()
