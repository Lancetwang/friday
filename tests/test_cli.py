from __future__ import annotations

import unittest
from unittest.mock import patch

from friday import cli


class CliTests(unittest.TestCase):
    def test_tui_launch_does_not_build_agent_first(self) -> None:
        with patch("friday.cli.build_friday") as build_friday:
            with patch("friday.cli.run_tui") as run_tui:
                cli.main(["tui"])

        build_friday.assert_not_called()
        run_tui.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
