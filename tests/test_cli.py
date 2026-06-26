from __future__ import annotations

import unittest
from unittest.mock import patch

from friday import cli
from friday import tui_node


class CliTests(unittest.TestCase):
    def test_tui_launch_does_not_build_agent_first(self) -> None:
        with patch("friday.cli.build_friday") as build_friday:
            with patch("friday.cli.run_tui") as run_tui:
                cli.main(["tui"])

        build_friday.assert_not_called()
        run_tui.assert_called_once_with()

    def test_tui_launch_runs_npm_from_ui_dir(self) -> None:
        def exists(path):
            return str(path).endswith("node_modules")

        with patch("friday.tui_node.Path.exists", exists):
            with patch("friday.tui_node.shutil.which", side_effect=lambda name: f"{name}.cmd"):
                with patch("friday.tui_node.subprocess.call", return_value=0) as call:
                    with self.assertRaises(SystemExit) as exit:
                        tui_node.run_tui()

        self.assertEqual(exit.exception.code, 0)
        args, kwargs = call.call_args
        self.assertEqual(args[0], ["npm.cmd", "start"])
        self.assertEqual(kwargs["cwd"].name, "ui-tui")
        self.assertEqual(kwargs["env"]["PYTHONIOENCODING"], "utf-8")
        self.assertEqual(kwargs["env"]["PYTHONUTF8"], "1")

    def test_tui_configures_windows_console_utf8(self) -> None:
        class Kernel32:
            def __init__(self) -> None:
                self.calls = []

            def SetConsoleCP(self, codepage):
                self.calls.append(("in", codepage))

            def SetConsoleOutputCP(self, codepage):
                self.calls.append(("out", codepage))

        kernel32 = Kernel32()
        with patch("friday.tui_node.os.name", "nt"):
            with patch("friday.tui_node.ctypes.windll", type("Windll", (), {"kernel32": kernel32})()):
                tui_node._configure_windows_console()

        self.assertEqual(kernel32.calls, [("in", 65001), ("out", 65001)])


if __name__ == "__main__":
    unittest.main()
