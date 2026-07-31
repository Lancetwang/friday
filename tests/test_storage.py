from __future__ import annotations

import os
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from friday.storage import checkpoint_dir, migrate_legacy_runtime, project_state_dir, record_project, workspace_key


class StorageTests(unittest.TestCase):
    def test_runtime_state_migrates_out_of_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "workspace"
            legacy = root / ".friday"
            (legacy / "sessions").mkdir(parents=True)
            (legacy / "sessions" / "s1.json").write_text("{}", encoding="utf-8")
            (legacy / "tool-results").mkdir()
            (legacy / "tool-results" / "bash.txt").write_text("output", encoding="utf-8")
            (legacy / "config.json").write_text('{"model":"legacy"}', encoding="utf-8")

            with patch.dict(os.environ, {"FRIDAY_HOME": str(Path(tmp) / "home" / ".friday")}):
                target = migrate_legacy_runtime(root)

                self.assertEqual(target, project_state_dir(root))
                self.assertTrue((target / "sessions" / "s1.json").exists())
                self.assertTrue((target / "tool-results" / "bash.txt").exists())
                self.assertTrue((target / "config.json").exists())
                self.assertFalse(legacy.exists())

    def test_unknown_legacy_files_are_not_moved(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "workspace"
            legacy = root / ".friday"
            legacy.mkdir(parents=True)
            custom = legacy / "custom.txt"
            custom.write_text("keep", encoding="utf-8")

            with patch.dict(os.environ, {"FRIDAY_HOME": str(Path(tmp) / "home" / ".friday")}):
                migrate_legacy_runtime(root)

            self.assertEqual(custom.read_text(encoding="utf-8"), "keep")

    def test_checkpoint_storage_migrates_under_the_project(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "workspace"
            home = Path(tmp) / "home" / ".friday"
            legacy = home / "checkpoints" / workspace_key(root)
            (legacy / "entries").mkdir(parents=True)
            (legacy / "entries" / "cp.json").write_text("{}", encoding="utf-8")

            with patch.dict(os.environ, {"FRIDAY_HOME": str(home)}):
                migrate_legacy_runtime(root)

                self.assertEqual(checkpoint_dir(root), project_state_dir(root) / "checkpoints")
                self.assertTrue((checkpoint_dir(root) / "entries" / "cp.json").exists())
                self.assertFalse(legacy.exists())

    def test_project_manifest_keeps_hash_directories_identifiable(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "workspace"
            root.mkdir()
            with patch.dict(os.environ, {"FRIDAY_HOME": str(Path(tmp) / "home" / ".friday")}):
                path = record_project(root)

            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["workspace"], str(root.resolve()))


if __name__ == "__main__":
    unittest.main()
