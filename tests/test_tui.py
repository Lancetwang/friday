from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from friday.tui import _command_help, _git_branch


class TUITests(unittest.TestCase):
    def test_help_lists_details_toggle(self) -> None:
        self.assertIn("/details", _command_help())

    def test_git_branch_handles_non_git_directory(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(_git_branch(Path(tmp)), "no git")


if __name__ == "__main__":
    unittest.main()
