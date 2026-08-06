from __future__ import annotations

import os
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from friday.storage import (
    checkpoint_dir,
    close_project,
    friday_home,
    list_projects,
    migrate_legacy_runtime,
    project_state_dir,
    record_project,
    resolve_workspace,
    workspace_key,
)


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


class ProjectRegistryTests(unittest.TestCase):
    """The sidebar restores what the user left open, not every workspace seen."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / "home" / ".friday"
        patcher = patch.dict(os.environ, {"FRIDAY_HOME": str(self.home)})
        patcher.start()
        self.addCleanup(patcher.stop)

    def _workspace(self, name: str) -> Path:
        path = Path(self.tmp.name) / name
        path.mkdir(parents=True, exist_ok=True)
        return path.resolve()

    def _listed(self) -> list[str]:
        return [item["workspace"] for item in list_projects(open_only=True)]

    def test_working_in_a_project_does_not_add_it_to_the_sidebar(self) -> None:
        # build_friday records every workspace it builds an agent in, including
        # CLI runs the desktop never opened.
        root = self._workspace("cli-only")

        record_project(root)

        self.assertEqual(self._listed(), [])
        self.assertEqual([item["workspace"] for item in list_projects()], [str(root)])

    def test_a_closed_project_stays_closed_when_friday_runs_there_again(self) -> None:
        root = self._workspace("closed")
        record_project(root, opened=True)
        close_project(root)

        # Anything that builds an agent in the directory re-records it; deleting
        # the record instead of flagging it is how the project used to come back.
        record_project(root)

        self.assertEqual(self._listed(), [])

    def test_reopening_a_closed_project_brings_it_back(self) -> None:
        root = self._workspace("reopened")
        record_project(root, opened=True)
        close_project(root)

        record_project(root, opened=True)

        self.assertEqual(self._listed(), [str(root)])

    def test_closing_keeps_the_session_state_and_the_first_seen_time(self) -> None:
        root = self._workspace("history")
        created = json.loads(record_project(root, opened=True).read_text(encoding="utf-8"))["created"]
        sessions = project_state_dir(root) / "sessions"
        sessions.mkdir(parents=True)
        (sessions / "s1.json").write_text("{}", encoding="utf-8")

        close_project(root)

        record = json.loads((project_state_dir(root) / "project.json").read_text(encoding="utf-8"))
        self.assertFalse(record["open"])
        self.assertEqual(record["created"], created)
        self.assertTrue((sessions / "s1.json").exists())

    def test_records_written_before_the_open_flag_keep_showing(self) -> None:
        root = self._workspace("legacy")
        path = project_state_dir(root) / "project.json"
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({"workspace": str(root), "updated": "2026-01-01T00:00:00"}), encoding="utf-8")

        self.assertEqual(self._listed(), [str(root)])

        record_project(root)

        self.assertEqual(self._listed(), [str(root)])

    def test_a_workspace_that_no_longer_exists_is_skipped_without_being_closed(self) -> None:
        root = self._workspace("removed")
        record_project(root, opened=True)
        shutil.rmtree(root)

        self.assertEqual(self._listed(), [])

        root.mkdir()

        self.assertEqual(self._listed(), [str(root)])

    def test_a_windows_extended_length_path_is_the_same_project(self) -> None:
        # The desktop used to hand back what Windows canonicalisation gave it, so
        # closing a project wrote the flag to a record nothing else ever read.
        root = self._workspace("extended")
        extended = Path(f"\\\\?\\{root}")

        self.assertEqual(workspace_key(extended), workspace_key(root))
        self.assertEqual(resolve_workspace(extended), root)

    def test_a_workspace_recorded_under_two_spellings_is_listed_once(self) -> None:
        root = self._workspace("twice")
        record_project(root, opened=True)
        # A record left behind by the build that stored the extended-length path.
        legacy = friday_home() / "projects" / "legacyextendedkey0000"
        legacy.mkdir(parents=True)
        (legacy / "project.json").write_text(
            json.dumps({"workspace": f"\\\\?\\{root}", "updated": "2020-01-01T00:00:00", "open": True}),
            encoding="utf-8",
        )

        self.assertEqual(self._listed(), [str(root)])

    def test_the_newest_decision_wins_when_a_workspace_was_recorded_twice(self) -> None:
        # The user closed the project through the desktop, which wrote the flag
        # under the extended-length spelling; the older record still says open.
        root = self._workspace("conflicted")
        path = project_state_dir(root) / "project.json"
        path.parent.mkdir(parents=True)
        path.write_text(
            json.dumps({"workspace": str(root), "updated": "2020-01-01T00:00:00", "open": True}),
            encoding="utf-8",
        )
        legacy = friday_home() / "projects" / "legacyextendedkey0001"
        legacy.mkdir(parents=True)
        (legacy / "project.json").write_text(
            json.dumps({"workspace": f"\\\\?\\{root}", "updated": "2026-01-01T00:00:00", "open": False}),
            encoding="utf-8",
        )

        self.assertEqual(self._listed(), [])

    def test_open_projects_come_back_most_recently_used_first(self) -> None:
        older = self._workspace("older")
        newer = self._workspace("newer")
        record_project(older, opened=True)
        record_project(newer, opened=True)
        path = project_state_dir(older) / "project.json"
        record = json.loads(path.read_text(encoding="utf-8"))
        path.write_text(json.dumps({**record, "updated": "2020-01-01T00:00:00"}), encoding="utf-8")

        self.assertEqual(self._listed(), [str(newer), str(older)])


if __name__ == "__main__":
    unittest.main()
