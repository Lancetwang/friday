from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from agent_core import RunContext

from friday import cli
from friday import tui_node


class CliTests(unittest.TestCase):
    def test_cli_help_exposes_tui_session_commands(self) -> None:
        output = StringIO()
        with patch.object(sys, "stdout", output), self.assertRaises(SystemExit):
            cli.main(["--help"])

        for command in ("memory", "context", "progress", "compact", "goal", "resume", "approve", "reject", "reset"):
            self.assertIn(command, output.getvalue())

    def test_progressive_help_aliases_work(self) -> None:
        for argv, expected in ((["help"], "Friday personal CLI agent"), (["skill", "help"], "Inspect reusable Friday skills"), (["memory", "help"], "Inspect and manage Friday memory")):
            output = StringIO()
            with patch.object(sys, "stdout", output), self.assertRaises(SystemExit):
                cli.main(argv)
            self.assertIn(expected, output.getvalue())

    def test_bare_friday_starts_tui(self) -> None:
        with patch("friday.cli.build_friday") as build_friday:
            with patch("friday.cli.run_tui") as run_tui:
                cli.main([])

        build_friday.assert_not_called()
        run_tui.assert_called_once_with()

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
        self.assertEqual(args[0], ["npm.cmd", "--silent", "start"])
        self.assertEqual(kwargs["cwd"].name, "ui-tui")
        self.assertEqual(kwargs["env"]["FRIDAY_CWD"], str(Path.cwd().resolve()))
        self.assertEqual(kwargs["env"]["PYTHONIOENCODING"], "utf-8")
        self.assertEqual(kwargs["env"]["PYTHONUTF8"], "1")

    def test_tui_local_source_wins_over_stale_dist(self) -> None:
        with patch("friday.tui_node.Path.exists", return_value=True):
            with patch("friday.tui_node.shutil.which", side_effect=lambda name: f"{name}.cmd"):
                with patch("friday.tui_node.subprocess.call", return_value=0) as call:
                    with self.assertRaises(SystemExit):
                        tui_node.run_tui()

        self.assertEqual(call.call_args.args[0], ["npm.cmd", "--silent", "start"])

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

    def test_cli_approve_continues_chat_context(self) -> None:
        agent = object()
        context = RunContext()

        with patch("friday.cli.approve_pending", return_value={"approved": True, "result": {"exit_code": 0}}):
            with patch("friday.cli._ask", return_value=(agent, context, "done")) as ask:
                with patch("builtins.print"):
                    returned_agent, returned_context = cli._slash("/approve", False, agent, context)

        self.assertIs(returned_agent, agent)
        self.assertIs(returned_context, context)
        ask.assert_called_once_with(
            agent,
            context,
            cli._approval_followup_prompt(),
            False,
            approval_result={"approved": True, "result": {"exit_code": 0}},
            user_label="/approve",
            continuation=True,
        )

    def test_permission_flags_configure_environment(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            with patch("friday.cli.run_tui"):
                cli.main(["--permission-allow", "--allowed-tools", "Bash(git log *)", "--disallowed-tools", "Bash(rm *)"])

            self.assertEqual(os.environ["FRIDAY_PERMISSION_MODE"], "bypass")
            self.assertEqual(os.environ["FRIDAY_ALLOWED_TOOLS"], '["Bash(git log *)"]')
            self.assertEqual(os.environ["FRIDAY_DISALLOWED_TOOLS"], '["Bash(rm *)"]')

    def test_permission_mode_flag_configures_environment(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            with patch("friday.cli.run_tui"):
                cli.main(["--permission-mode", "dont-ask"])

            self.assertEqual(os.environ["FRIDAY_PERMISSION_MODE"], "dont-ask")

    def test_ask_can_read_long_request_from_stdin(self) -> None:
        agent = object()
        context = RunContext()
        with patch.object(sys, "stdin", StringIO("long request\nwith context")):
            with patch("friday.cli.build_friday", return_value=(agent, context)):
                with patch("friday.cli._ask", return_value=(agent, context, "done")) as ask:
                    cli.main(["--no-stream", "ask", "--stdin"])

        ask.assert_called_once_with(agent, context, "long request\nwith context", False)

    def test_top_level_goal_uses_the_shared_goal_turn(self) -> None:
        agent = object()
        context = RunContext()
        with patch("friday.cli.build_friday", return_value=(agent, context)):
            with patch("friday.cli._goal") as goal:
                cli.main(["--no-stream", "goal", "finish", "the", "task"])

        goal.assert_called_once_with(agent, context, "finish the task", False)

    def test_top_level_compact_targets_a_saved_session(self) -> None:
        agent = object()
        context = RunContext(metadata={"session_id": "session-1"})
        with patch("friday.cli.resume_friday", return_value=(agent, context, 3)) as resume:
            with patch("friday.cli.compact_friday", return_value=(agent, context, "summary")) as compact:
                with patch("builtins.print"):
                    cli.main(["--no-stream", "compact", "--session", "session-1"])

        resume.assert_called_once_with(stream=False, resume_id="session-1")
        compact.assert_called_once_with(agent, context, stream=False)

    def test_skill_list_json_does_not_build_agent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "workspace"
            home = Path(tmp) / "home"
            skill_dir = root / ".friday" / "FridaySkills" / "review"
            skill_dir.mkdir(parents=True)
            (skill_dir / "SKILL.md").write_text(
                "---\nname: review\ndescription: Review code changes.\n---\n",
                encoding="utf-8",
            )
            output = StringIO()
            with patch("friday.cli.Path.cwd", return_value=root), patch("friday.cli.Path.home", return_value=home):
                with patch.object(sys, "stdout", output), patch("friday.cli.build_friday") as build_friday:
                    cli.main(["skill", "list", "--json"])

            data = json.loads(output.getvalue())
            review = next(item for item in data["skills"] if item["name"] == "review")
            self.assertEqual(review["scope"], "project")
            self.assertEqual(Path(review["path"]), skill_dir / "SKILL.md")
            build_friday.assert_not_called()

    def test_memory_cli_manages_markdown_without_building_agent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "workspace"
            home = Path(tmp) / "home"
            root.mkdir()
            output = StringIO()
            with patch("friday.cli.Path.cwd", return_value=root), patch("friday.memory.Path.home", return_value=home):
                with patch.object(sys, "stdout", output), patch("friday.cli.build_friday") as build_friday:
                    cli.main(["memory", "add", "--scope", "user", "Preferred language is Chinese.", "--json"])

            saved = json.loads(output.getvalue())
            self.assertEqual(saved["scope"], "user")
            self.assertIn("Preferred language is Chinese.", (home / ".friday" / "USER.md").read_text(encoding="utf-8"))
            build_friday.assert_not_called()

    def test_memory_cli_consolidates_recent_episodes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            result = {"reviewed": 2, "merged": 1, "promoted": 0, "remaining": 1}
            with patch("friday.cli.Path.cwd", return_value=root), patch("friday.cli.consolidate_memory", return_value=result) as consolidate:
                with patch.object(sys, "stdout", StringIO()):
                    cli.main(["memory", "consolidate", "--days", "3", "--json"])

            consolidate.assert_called_once_with(root.resolve(), days=3)


if __name__ == "__main__":
    unittest.main()
