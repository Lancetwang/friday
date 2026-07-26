from __future__ import annotations

import os
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agent_core import RunContext

from friday.checkpoint import begin_checkpoint, checkpoint_choices, finish_checkpoint, restore_checkpoint
from friday.app import undo_friday
from friday.trace import begin_live_trace


class CheckpointTests(unittest.TestCase):
    def setUp(self) -> None:
        self.storage = tempfile.TemporaryDirectory()
        self.environment = patch.dict(
            os.environ,
            {
                "FRIDAY_CHECKPOINT_DIR": str(Path(self.storage.name) / "checkpoints"),
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
