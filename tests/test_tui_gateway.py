from __future__ import annotations

import io
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from typing import Any, cast
from unittest.mock import patch

from agent_core import AgentEvent, RunContext

from friday.session import FridaySession
from friday.app_server import (
    Gateway,
    _install_cli_shim,
    _request_lines,
    artifact_detail,
    fork_points,
    session_history,
    verification_status,
)
from friday.app_server import main as app_server_main
from friday.im.supervisor import BridgeSupervisor
from friday.state import (
    ARCHIVED_MESSAGES,
    delete_session_tree,
    fork_session,
    read_session,
    resume_choices,
    save_turn,
    session_path,
    session_tree,
)
from friday.turn import TurnResult
from friday.turn import TurnCancelled


class _StdoutWithBuffer:
    """`main` writes bytes through `sys.stdout.buffer`, which StringIO lacks."""

    def __init__(self) -> None:
        self.buffer = io.BytesIO()

    def write(self, _text: str) -> int:
        return 0

    def flush(self) -> None:
        return None


def _turn_result(answer: str, verifications: list[dict] | None = None) -> TurnResult:
    return TurnResult(
        agent=object(),
        context=RunContext(metadata={"workspace": str(Path.cwd())}),
        answer=answer,
        verifications=verifications or [],
        metrics={},
        progress={},
    )


class TuiGatewayTests(unittest.TestCase):
    def test_gateway_request_reader_does_not_block_workers_and_preserves_utf8(self) -> None:
        read_fd, write_fd = os.pipe()
        try:
            os.write(write_fd, b'{"text":"\xe4\xbd\xa0\xe5\xa5\xbd"}\n{"ok":true}\n')
            os.close(write_fd)
            write_fd = -1

            self.assertEqual(list(_request_lines(read_fd)), ['{"text":"\u4f60\u597d"}', '{"ok":true}'])
        finally:
            os.close(read_fd)
            if write_fd >= 0:
                os.close(write_fd)

    def test_gateway_passes_valid_image_data_to_the_session(self) -> None:
        gateway = Gateway()
        image = "data:image/png;base64,aW1hZ2U="

        with patch.object(gateway.session, "chat", return_value=_turn_result("seen")) as chat:
            with patch.object(gateway, "ok"):
                gateway.handle(
                    {
                        "id": "1",
                        "method": "chat.send",
                        "params": {"text": "describe it", "images": [image]},
                    }
                )

        chat.assert_called_once_with("describe it", images=[image])

    def test_gateway_rejects_non_image_data_urls(self) -> None:
        gateway = Gateway()

        with patch.object(gateway, "err") as error:
            gateway.handle(
                {
                    "id": "1",
                    "method": "chat.send",
                    "params": {"text": "describe it", "images": ["data:text/plain;base64,bm8="]},
                }
            )

        error.assert_called_once_with("1", "Images must be PNG, JPEG, WebP, or GIF data URLs no larger than 10 MB.")

    def setUp(self) -> None:
        self.state_tmp = tempfile.TemporaryDirectory()
        self.state_env = patch.dict(os.environ, {"FRIDAY_HOME": str(Path(self.state_tmp.name) / ".friday")})
        self.state_env.start()

    def tearDown(self) -> None:
        self.state_env.stop()
        self.state_tmp.cleanup()

    def test_gateway_installs_process_local_friday_cli(self) -> None:
        with patch.dict(os.environ, {"PATH": "existing"}), patch(
            "friday.app_server.sys.executable", "C:/Friday/friday-app-server.exe"
        ), patch("friday.app_server.sys.frozen", True, create=True):
            path = _install_cli_shim()

            self.assertTrue(path.exists())
            self.assertIn("--cli", path.read_text(encoding="utf-8"))
            self.assertEqual(os.environ["PATH"].split(os.pathsep)[0], str(path.parent))

    def test_gateway_writes_unicode_json_without_escaping(self) -> None:
        output = io.StringIO()

        Gateway(output=output).event("message.delta", {"text": "你好，Friday"})

        self.assertIn("你好，Friday", output.getvalue())

    def test_gateway_does_not_expose_effective_prompt(self) -> None:
        gateway = Gateway()

        with patch.object(gateway, "err") as error:
            gateway.handle({"id": "1", "method": "prompt.get"})

        error.assert_called_once_with("1", "unknown method: prompt.get")

    def test_gateway_settings_return_status_without_credentials(self) -> None:
        gateway = Gateway()

        with patch("friday.app_server.load_web_search_settings", return_value={"tavily_configured": True}), patch(
            "friday.app_server.load_user_profile_settings",
            return_value={"preferred_name": "Kai", "preferred_language": "Chinese", "habits": ""},
        ), patch(
            "friday.app_server.load_feishu_settings",
            return_value={
                "app_id": "cli_x",
                "app_secret_configured": True,
                "allowed_users": ["ou_a"],
                "allow_group": False,
            },
        ), patch.object(gateway, "ok") as ok:
            gateway.handle({"id": "1", "method": "settings.get"})

        result = ok.call_args.args[1]
        self.assertEqual(result["web_search"], {"tavily_configured": True})
        self.assertTrue(result["feishu"]["app_secret_configured"])
        self.assertFalse(result["bridge"]["running"])
        self.assertNotIn("api_key", json.dumps(result))
        self.assertNotIn("app_secret\"", json.dumps(result))

    def test_gateway_saves_feishu_settings_and_reports_the_bridge(self) -> None:
        gateway = Gateway()
        view = {"app_id": "cli_x", "app_secret_configured": True, "allowed_users": [], "allow_group": False}

        with patch("friday.app_server.save_feishu_settings", return_value=view) as save:
            with patch.object(gateway, "ok") as ok:
                gateway.handle(
                    {
                        "id": "1",
                        "method": "settings.feishu.save",
                        "params": {"app_id": "cli_x", "app_secret": "s3cret", "allowed_users": "ou_a\nou_b"},
                    }
                )

        self.assertEqual(save.call_args.kwargs["app_id"], "cli_x")
        self.assertEqual(save.call_args.kwargs["app_secret"], "s3cret")
        self.assertEqual(save.call_args.kwargs["allowed_users"], "ou_a\nou_b")
        self.assertIsNone(save.call_args.kwargs["allow_group"])
        self.assertEqual(ok.call_args.args[1]["feishu"], view)
        self.assertFalse(ok.call_args.args[1]["bridge"]["running"])

    def test_gateway_reveals_feishu_secret_only_on_explicit_request(self) -> None:
        gateway = Gateway()

        with patch("friday.app_server.read_feishu_credential", return_value="s3cret") as read:
            with patch.object(gateway, "ok") as ok:
                gateway.handle({"id": "1", "method": "settings.feishu.key.get"})

        read.assert_called_once_with()
        self.assertEqual(ok.call_args.args[1], {"app_secret": "s3cret"})

    def test_gateway_switches_the_bridge_on_and_off(self) -> None:
        gateway = Gateway()
        running = {"running": True, "pid": 7, "workspace": str(Path.cwd()), "exit_code": None, "log": []}

        with patch.object(gateway.bridge, "start", return_value=running) as start:
            with patch.object(gateway.bridge, "stop", return_value={**running, "running": False, "pid": None}) as stop:
                with patch.object(gateway, "ok") as ok:
                    gateway.handle({"id": "1", "method": "bridge.start"})
                    self.assertTrue(ok.call_args.args[1]["running"])
                    gateway.handle({"id": "2", "method": "bridge.stop"})

        start.assert_called_once_with(Path.cwd().resolve())
        stop.assert_called_once_with()
        self.assertFalse(ok.call_args.args[1]["running"])

    def test_gateway_lists_phone_conversations_for_the_sidebar(self) -> None:
        gateway = Gateway()
        choices = [{"id": "s1", "title": "from the phone", "time": "", "turns": "1"}]

        with patch("friday.app_server.phone_sessions", return_value=choices) as listing:
            with patch.object(gateway, "ok") as ok:
                gateway.handle({"id": "1", "method": "bridge.sessions"})

        listing.assert_called_once_with(Path.cwd().resolve())
        self.assertEqual(ok.call_args.args[1], {"choices": choices})

    def test_a_closing_gateway_takes_the_bridge_offline(self) -> None:
        read_fd, write_fd = os.pipe()
        os.close(write_fd)
        try:
            with patch("friday.app_server._install_cli_shim"), patch("sys.stdin") as stdin:
                stdin.fileno.return_value = read_fd
                with patch.object(BridgeSupervisor, "stop", return_value={}) as stop:
                    with patch("sys.stdout", new=_StdoutWithBuffer()):
                        app_server_main()
        finally:
            os.close(read_fd)

        stop.assert_called_once_with()

    def test_verification_status_keeps_feedback_but_omits_trace_details(self) -> None:
        result = verification_status(
            {
                "evidence": ["test passed"],
                "feedback": "done",
                "passed": True,
                "verdict": "pass",
            }
        )

        # Evidence is trace material; feedback is what the UI shows when a
        # verification does not pass, so it travels with the status.
        self.assertEqual(result, {"feedback": "done", "passed": True, "verdict": "pass"})

    def test_gateway_exposes_verification_as_status_event(self) -> None:
        gateway = Gateway()

        with patch.object(gateway, "event") as event:
            gateway.on_agent_event(AgentEvent("verification.start", category="verification"))

        payload = event.call_args.args[1]
        self.assertEqual(event.call_args.args[0], "verification.start")
        self.assertEqual(payload["session_id"], gateway.session.session_id)

    def test_gateway_exposes_reasoning_as_grouped_stream_events(self) -> None:
        gateway = Gateway()

        with patch.object(gateway, "event") as event:
            gateway.on_agent_event(
                AgentEvent(
                    "model.reasoning.delta",
                    category="model",
                    run_id="run-1",
                    step=3,
                    data={"content": "think"},
                )
            )
            gateway.on_agent_event(
                AgentEvent(
                    "model.response",
                    category="model",
                    run_id="run-1",
                    step=3,
                    data={"has_reasoning": True},
                )
            )
            gateway.on_agent_event(
                AgentEvent(
                    "model.reasoning.delta",
                    category="model",
                    run_id="run-1",
                    step=3,
                    data={"content": "again"},
                )
            )
            gateway.on_agent_event(
                AgentEvent(
                    "model.response",
                    category="model",
                    run_id="run-1",
                    step=3,
                    data={"has_reasoning": True},
                )
            )

        self.assertEqual([call.args[0] for call in event.call_args_list], [
            "reasoning.delta", "reasoning.complete", "reasoning.delta", "reasoning.complete"
        ])
        self.assertEqual([call.args[1]["id"] for call in event.call_args_list], [
            "reasoning-1", "reasoning-1", "reasoning-2", "reasoning-2"
        ])
        self.assertTrue(all(call.args[1]["session_id"] == gateway.session.session_id for call in event.call_args_list))

    def test_message_complete_includes_final_verification(self) -> None:
        gateway = Gateway()
        callback = gateway.session.on_turn_complete
        assert callback is not None

        with patch.object(gateway, "event") as event:
            callback(_turn_result("done", [{"passed": True, "verdict": "pass"}]))

        payload = event.call_args.args[1]
        self.assertEqual(payload["verification"], {"passed": True, "verdict": "pass"})

    def test_message_complete_reports_why_a_guard_ended_the_turn(self) -> None:
        """A stopped turn otherwise arrives looking exactly like a finished one."""
        gateway = Gateway()
        callback = gateway.session.on_turn_complete
        assert callback is not None
        result = _turn_result("what I have so far")
        result.context.metadata["friday.loop_status"] = "context_window"

        with patch.object(gateway, "event") as event:
            callback(result)

        self.assertEqual(event.call_args.args[1]["status"], "context_window")

        with patch.object(gateway, "event") as event:
            callback(_turn_result("done"))

        self.assertEqual(event.call_args.args[1]["status"], "done")

    def test_message_complete_includes_artifacts(self) -> None:
        gateway = Gateway()
        callback = gateway.session.on_turn_complete
        assert callback is not None
        result = _turn_result("done")
        result.artifacts = [{"kind": "markdown", "name": "report.md", "path": "report.md", "size": 8}]

        with patch.object(gateway, "event") as event:
            callback(result)

        self.assertEqual(event.call_args.args[1]["artifacts"], result.artifacts)

    def test_pending_approval_suspends_without_completing_the_message(self) -> None:
        gateway = Gateway()
        callback = gateway.session.on_turn_complete
        assert callback is not None
        result = _turn_result("")
        result.progress = {"status": "waiting"}

        with patch.object(gateway, "event") as event:
            callback(result)

        self.assertEqual(event.call_args.args[0], "message.suspended")
        self.assertEqual(event.call_args.args[1]["fork_points"], [])

    def test_artifact_preview_stays_inside_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "report.md").write_text("# Result", encoding="utf-8")

            detail = artifact_detail(root, "report.md")

            self.assertEqual(detail["kind"], "markdown")
            self.assertEqual(detail["content"], "# Result")
            with self.assertRaisesRegex(ValueError, "relative"):
                artifact_detail(root, str((root / "report.md").resolve()))
            with self.assertRaisesRegex(ValueError, "outside"):
                artifact_detail(root, "../secret.md")

    def test_gateway_exposes_progress_updates(self) -> None:
        gateway = Gateway()
        progress = {"objective": "finish report", "status": "working"}

        with patch.object(gateway, "event") as event:
            gateway.on_agent_event(AgentEvent("progress.updated", category="progress", data=progress))

        event.assert_called_once_with("progress.update", {**progress, "session_id": gateway.session.session_id})

    def test_background_gateway_can_switch_sessions_while_a_turn_runs(self) -> None:
        gateway = Gateway(output=io.StringIO(), background=True)
        first = gateway.session
        started = threading.Event()
        release = threading.Event()

        def chat(*_args, **_kwargs):
            started.set()
            release.wait(2)
            return _turn_result("done")

        with patch.object(first, "chat", side_effect=chat):
            gateway.handle({"id": "chat", "method": "chat.send", "params": {"text": "wait"}})
            self.assertTrue(started.wait(1))
            gateway.handle({"id": "new", "method": "session.new"})
            self.assertNotEqual(gateway.session.session_id, first.session_id)
            self.assertIn(first.session_id, [choice["id"] for choice in gateway.session_choices()])
            thread = gateway.runs[first.session_id]
            release.set()
            thread.join(2)

    def test_background_gateway_cancels_the_selected_turn(self) -> None:
        output = io.StringIO()
        gateway = Gateway(output=output, background=True)
        session = gateway.session
        started = threading.Event()

        def chat(*_args, **_kwargs):
            started.set()
            while True:
                session.raise_if_cancelled()
                time.sleep(0.01)

        with patch.object(session, "chat", side_effect=chat):
            gateway.handle({"id": "chat", "method": "chat.send", "params": {"text": "wait"}})
            self.assertTrue(started.wait(1))
            thread = gateway.runs[session.session_id]
            gateway.handle({"id": "cancel", "method": "chat.cancel"})
            thread.join(2)

        self.assertIn('"method": "event"', output.getvalue())
        self.assertIn('"type": "message.cancelled"', output.getvalue())
        self.assertIn('"type": "session.updated"', output.getvalue())

    def test_cancelled_turn_restores_the_previous_conversation(self) -> None:
        session = FridaySession(session_id="s1")
        session.agent = object()
        session.context = RunContext(metadata={"workspace": str(Path.cwd()), "session_id": "s1"})
        session.context.add_message("system", "prefix")
        session.context.add_message("user", "kept")
        fresh = RunContext(metadata={"workspace": str(Path.cwd()), "session_id": "s1"})
        fresh.add_message("system", "fresh prefix")

        def cancelled(_agent, context, _text, **_kwargs):
            self.assertIs(context.metadata["friday.cancel_event"], session._cancel_event)
            session.cancel()
            raise TurnCancelled("stop")

        with patch("friday.session.run_turn", side_effect=cancelled):
            with patch("friday.session.build_friday", return_value=(object(), fresh)):
                with self.assertRaises(TurnCancelled):
                    session.chat("discarded")

        self.assertEqual([message["content"] for message in session.context.get_messages()], ["fresh prefix", "kept"])
        self.assertFalse(session._cancel_event.is_set())

    def test_a_cancel_with_nothing_running_does_not_cancel_the_next_turn(self) -> None:
        session = FridaySession(session_id="s1")
        session.agent = object()
        session.context = RunContext(metadata={"workspace": str(Path.cwd()), "session_id": "s1"})

        session.cancel()

        def answer(_agent, context, _text, **_kwargs):
            self.assertFalse(context.metadata["friday.cancel_event"].is_set())
            return TurnResult(session.agent, context, "done", [], {}, {})

        with patch("friday.session.run_turn", side_effect=answer):
            with patch("friday.session.pending_approval", return_value={"pending": False}):
                self.assertEqual(session.chat("next request").answer, "done")

    def test_forks_are_hidden_from_recent_sessions_and_delete_as_a_subtree(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            messages = [
                {"role": "user", "content": "one"},
                {"role": "assistant", "content": "first"},
                {"role": "user", "content": "two"},
                {"role": "assistant", "content": "second"},
            ]
            save_turn(root, "one", "second", "root", messages)
            with self.assertRaisesRegex(ValueError, "assistant response"):
                fork_session(root, "root", 0)
            fork = fork_session(root, "root", 1)
            save_turn(root, "branch", "done", fork["session_id"], fork["messages"])

            self.assertEqual([choice["id"] for choice in resume_choices(root)], ["root"])
            self.assertEqual(len(session_tree(root, fork["session_id"])["nodes"]), 2)
            self.assertEqual(read_session(session_path(root, fork["session_id"]))["fork_parent"], "root")
            self.assertCountEqual(delete_session_tree(root, "root"), ["root", fork["session_id"]])

    def test_gateway_forks_from_latest_assistant_and_can_return_to_parent(self) -> None:
        gateway = Gateway()
        gateway.session.context = RunContext(metadata={"workspace": str(Path.cwd())})
        gateway.session.context.add_message("user", "one")
        gateway.session.context.add_message("assistant", "first")
        gateway.session.context.add_message("user", "two")
        gateway.session.context.add_message("assistant", "second")
        source_id = gateway.session.session_id

        with patch("friday.app_server.fork_session", return_value={"session_id": "forked"}) as fork:
            with patch.object(gateway, "_resume_session", return_value=2), patch.object(
                gateway, "session_info", return_value={"session_id": "forked"}
            ), patch("friday.app_server.session_tree", return_value={"root": source_id, "nodes": []}), patch.object(
                gateway, "ok"
            ):
                gateway.handle({"id": "fork", "method": "session.fork"})

        self.assertEqual(fork.call_args.args[2], 3)

        tree = {
            "root": source_id,
            "nodes": [{"id": "forked", "parent": source_id}, {"id": source_id, "parent": ""}],
        }
        gateway.session.session_id = "forked"
        with patch("friday.app_server.session_tree", return_value=tree), patch.object(
            gateway, "_resume_session", return_value=2
        ) as resume, patch.object(gateway, "session_info", return_value={"session_id": source_id}), patch(
            "friday.app_server.session_history", return_value=[]
        ), patch.object(gateway, "ok"):
            gateway.handle({"id": "back", "method": "session.backward"})

        resume.assert_called_once_with(source_id)

    def test_gateway_correlates_tool_events_by_call_id(self) -> None:
        gateway = Gateway()

        with patch.object(gateway, "event") as event:
            gateway.on_agent_event(
                AgentEvent(
                    "tool.call",
                    category="tool",
                    data={"tool_call_id": "call-1", "name": "Read", "arguments": {"path": "README.md"}},
                )
            )
            gateway.on_agent_event(
                AgentEvent(
                    "tool.progress",
                    category="tool",
                    data={"tool_call_id": "call-1", "name": "Read", "content": "working"},
                )
            )
            gateway.on_agent_event(
                AgentEvent(
                    "tool.result",
                    category="tool",
                    data={"tool_call_id": "call-1", "content": "Friday", "is_error": False},
                )
            )

        self.assertEqual(event.call_args_list[0].args[1]["tool_call_id"], "call-1")
        self.assertEqual(event.call_args_list[1].args[1]["tool_call_id"], "call-1")
        self.assertEqual(event.call_args_list[1].args[0], "tool.update")
        self.assertEqual(event.call_args_list[2].args[1]["tool_call_id"], "call-1")

    def test_gateway_routes_memory_commands_without_building_an_agent(self) -> None:
        gateway = Gateway()
        with patch("friday.app_server.run_memory_command", return_value={"counts": {scope: 0 for scope in ("user", "global", "project", "episode")}, "chars": {scope: 0 for scope in ("user", "global", "project", "episode")}}):
            with patch.object(gateway, "ok") as ok, patch.object(FridaySession, "ensure") as ensure:
                gateway.handle({"id": "1", "method": "memory.command", "params": {"command": "status"}})

        ensure.assert_not_called()
        self.assertIn("Memory status", ok.call_args.args[1]["text"])

    def test_gateway_undo_replaces_the_active_session(self) -> None:
        gateway = Gateway()
        context = RunContext(metadata={"session_id": "s1", "workspace": str(Path.cwd())})
        restored = {"id": "cp-1", "user": "change file", "changed_paths": ["file.txt"]}

        with patch("friday.session.undo_friday", return_value=(object(), context, restored)):
            with patch("friday.session.current_progress", return_value={"objective": "previous"}):
                with patch.object(gateway, "session_info", return_value={"session_id": "s1"}):
                    with patch.object(gateway, "ok") as ok:
                        gateway.handle({"id": "1", "method": "checkpoint.undo"})

        self.assertIs(gateway.session.context, context)
        self.assertEqual(ok.call_args.args[1]["changed_paths"], ["file.txt"])
        self.assertEqual(ok.call_args.args[1]["history"], [])
        self.assertEqual(ok.call_args.args[1]["info"], {"session_id": "s1"})

    def test_gateway_exposes_shared_skill_and_checkpoint_catalogs(self) -> None:
        gateway = Gateway()
        skills = [{"name": "friday-cli", "description": "Friday commands", "path": "SKILL.md", "scope": "user"}]
        checkpoints = [{"id": "cp-1", "session_id": "s1", "user": "hello"}]

        with patch("friday.app_server.discover_skills", return_value=skills):
            with patch("friday.app_server.checkpoint_choices", return_value=checkpoints):
                with patch.object(gateway, "ok") as ok:
                    gateway.handle({"id": "1", "method": "skill.list"})
                    self.assertEqual(ok.call_args.args[1], {"skills": skills})
                    gateway.handle({"id": "2", "method": "checkpoint.list"})

        self.assertEqual(ok.call_args.args[1], {"checkpoints": checkpoints})

    def test_fresh_gateway_provisions_the_default_skill_on_first_list(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / "workspace"
            workspace.mkdir()
            cwd = Path.cwd()
            os.chdir(workspace)
            try:
                with patch.dict(os.environ, {"FRIDAY_HOME": str(root / "home")}):
                    gateway = Gateway()
                    with patch.object(gateway, "ok") as ok:
                        gateway.handle({"id": "1", "method": "skill.list"})
            finally:
                os.chdir(cwd)

        skills = ok.call_args.args[1]["skills"]
        self.assertEqual([skill["name"] for skill in skills], ["friday-cli"])

    def test_gateway_opens_trace_server_on_an_available_port(self) -> None:
        gateway = Gateway()
        server = object()
        with patch("friday.app_server.start_trace_server", return_value=(server, "http://127.0.0.1:3210")) as start:
            with patch.object(gateway, "ok") as ok:
                gateway.handle({"id": "1", "method": "trace.serve"})

        start.assert_called_once_with(port=0, open_browser=False)
        ok.assert_called_once_with("1", {"url": "http://127.0.0.1:3210"})

    def test_gateway_stops_the_background_trace_server(self) -> None:
        gateway = Gateway()
        with patch("friday.app_server.stop_trace_server", return_value=True) as stop:
            with patch.object(gateway, "ok") as ok:
                gateway.handle({"id": "1", "method": "trace.stop"})

        stop.assert_called_once_with()
        ok.assert_called_once_with("1", {"stopped": True})

    def test_gateway_reads_only_catalogued_skill_files(self) -> None:
        gateway = Gateway()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "SKILL.md"
            path.write_text(
                "---\nname: demo\ndescription: Demo skill\n---\n\n# Skill\n\nReal instructions.",
                encoding="utf-8",
            )
            skill = {"name": "demo", "description": "Demo skill", "path": str(path), "scope": "user"}
            with patch("friday.app_server.discover_skills", return_value=[skill]):
                with patch.object(gateway, "ok") as ok:
                    gateway.handle({"id": "1", "method": "skill.get", "params": {"path": str(path)}})
                self.assertEqual(ok.call_args.args[1]["content"], "# Skill\n\nReal instructions.")
                with patch.object(gateway, "err") as err:
                    gateway.handle({"id": "2", "method": "skill.get", "params": {"path": str(path.parent / "other.md")}})

        self.assertIn("not available", err.call_args.args[1])

    def test_session_info_does_not_require_llm_key(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(os.environ, {"LLM_API_KEY": "", "OPENAI_API_KEY": "", "DEEPSEEK_API_KEY": ""}, clear=False):
                cwd = Path.cwd()
                try:
                    os.chdir(tmp)
                    info = Gateway().session_info()
                finally:
                    os.chdir(cwd)

        self.assertEqual(info["cwd"], str(Path(tmp).resolve()))
        self.assertIn("Read", info["tools"])

    def test_gateway_scopes_permission_mode_to_one_session(self) -> None:
        with patch.dict(os.environ, {"FRIDAY_PERMISSION_MODE": "manual"}, clear=False):
            gateway = Gateway()
            first = gateway.session
            other = gateway._new_session()

            with patch.object(gateway, "ok") as ok:
                gateway.handle({"id": "1", "method": "permission.set", "params": {"mode": "bypass"}})

            ok.assert_called_once_with("1", {"permission_mode": "bypass", "session_id": first.session_id})
            self.assertEqual(first.effective_permission_mode(), "bypass")
            # A session that already existed keeps its own policy, and the process
            # default is untouched so other workspaces are unaffected.
            self.assertEqual(other.effective_permission_mode(), "manual")
            self.assertEqual(os.environ["FRIDAY_PERMISSION_MODE"], "manual")
            # A conversation started afterwards inherits the choice the user just made.
            self.assertEqual(gateway._new_session().effective_permission_mode(), "bypass")

    def test_gateway_sets_thinking_effort_on_the_shared_session(self) -> None:
        gateway = Gateway()
        info = {"thinking_effort": "max", "thinking_supported": True}

        with patch.object(gateway.session, "select_thinking", return_value="max") as select:
            with patch.object(gateway, "session_info", return_value=info):
                with patch.object(gateway, "ok") as ok:
                    gateway.handle({"id": "1", "method": "thinking.set", "params": {"effort": "max"}})

        select.assert_called_once_with("max")
        ok.assert_called_once_with("1", {"thinking_effort": "max", "info": info})

    def test_gateway_saves_model_key_without_returning_it(self) -> None:
        gateway = Gateway()
        with patch("friday.config.fetch_provider_models", return_value=["mimo-v2.5"]):
            with patch.object(gateway, "ok") as ok:
                gateway.handle(
                    {
                        "id": "1",
                        "method": "model.save",
                        "params": {
                            "api_key": "private-key",
                            "profile": {
                                "name": "MiMo",
                                "provider": "mimo",
                                "model": "mimo-v2.5",
                                "base_url": "https://api.xiaomimimo.com/v1",
                            },
                        },
                    }
                )

        result = ok.call_args.args[1]
        self.assertNotIn("private-key", str(result))
        self.assertTrue(result["info"]["model_configured"])
        self.assertTrue(result["info"]["model_vision"])

    def test_gateway_reveals_a_model_key_only_on_the_explicit_settings_action(self) -> None:
        gateway = Gateway()
        with patch("friday.app_server.read_model_credential", return_value="private-key"):
            with patch.object(gateway, "ok") as ok:
                gateway.handle(
                    {
                        "id": "1",
                        "method": "model.key.get",
                        "params": {"provider": "deepseek"},
                    }
                )

        ok.assert_called_once_with("1", {"api_key": "private-key"})

    def test_model_catalog_includes_each_models_real_thinking_choices(self) -> None:
        gateway = Gateway()
        catalog = {
            "active": "deepseek-v4-flash",
            "profiles": [
                {
                    "id": "deepseek-v4-flash",
                    "model": "deepseek-v4-flash",
                    "provider": "deepseek",
                }
            ],
            "providers": [],
        }
        with patch("friday.app_server.load_model_catalog", return_value=catalog):
            with patch.object(gateway, "ok") as ok:
                gateway.handle({"id": "1", "method": "model.list"})

        self.assertEqual(ok.call_args.args[1]["profiles"][0]["thinking_options"], ["off", "high", "max"])

    def test_gateway_renames_and_deletes_saved_sessions(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            save_turn(root, "hello", "hi", "s1", [])
            cwd = Path.cwd()
            try:
                os.chdir(root)
                gateway = Gateway()
                with patch.object(gateway, "ok") as ok:
                    gateway.handle({"id": "1", "method": "session.rename", "params": {"id": "s1", "title": "First chat"}})
                    self.assertEqual(ok.call_args.args[1]["title"], "First chat")
                    gateway.handle({"id": "2", "method": "session.delete", "params": {"id": "s1"}})
            finally:
                os.chdir(cwd)
            self.assertEqual(list((Path(os.environ["FRIDAY_HOME"]) / "projects").glob("*/sessions/s1.json")), [])

    def test_gateway_reset_is_project_only_by_default(self) -> None:
        gateway = Gateway()

        with patch.object(gateway.session, "reset", return_value=[]) as reset, patch.object(gateway, "ok"):
            gateway.handle({"id": "1", "method": "session.reset"})

        reset.assert_called_once_with(include_user=False)

    def test_session_history_restores_conversation_and_tools_only(self) -> None:
        gateway = Gateway()
        context = RunContext(
            metadata={
                "workspace": str(Path.cwd()),
                "friday.user_message_times": [{"text": "Inspect skills", "time": "2026-07-28T16:00:00+08:00"}],
            }
        )
        context.add_message("system", "hidden prefix")
        image = "data:image/png;base64,aW1hZ2U="
        context.add_message(
            "user",
            [
                {"type": "text", "text": "Inspect skills"},
                {"type": "image_url", "image_url": {"url": image}},
            ],
        )
        context.add_message(
            "assistant",
            "I will inspect.",
            tool_calls=[
                {
                    "id": "call-1",
                    "type": "function",
                    "function": {"name": "Bash", "arguments": '{"command":"friday skill list --json"}'},
                }
            ],
        )
        context.add_message("tool", '{"skills":[]}', tool_call_id="call-1")
        context.add_message("assistant", "No extra skills are installed.")
        gateway.session.context = context

        history = session_history(gateway.session)

        self.assertEqual([item["kind"] for item in history], ["user", "tool", "assistant"])
        self.assertEqual(history[1]["name"], "Bash")
        self.assertEqual(history[1]["status"], "done")
        self.assertEqual(history[1]["arguments"]["command"], "friday skill list --json")
        self.assertIn("No extra skills", history[2]["text"])
        self.assertEqual(history[0]["timestamp"], "2026-07-28T16:00:00+08:00")
        self.assertEqual(history[0]["images"], [image])
        self.assertNotIn("hidden prefix", str(history))
        self.assertEqual(fork_points(gateway.session), [{"kind": "assistant", "message_index": 3}])

    def test_session_history_restores_persisted_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cwd = Path.cwd()
            os.chdir(root)
            try:
                gateway = Gateway()
                context = RunContext(metadata={"workspace": str(root)})
                context.add_message("user", "write a report")
                context.add_message("assistant", "Done.")
                gateway.session.context = context
                artifact = {"kind": "markdown", "name": "report.md", "path": "report.md", "size": 8}
                save_turn(
                    root,
                    "write a report",
                    "Done.",
                    gateway.session.session_id,
                    context.get_messages(),
                    artifacts=[artifact],
                )
                rebased = RunContext(metadata={"workspace": str(root)})
                rebased.add_message("user", "earlier")
                rebased.add_message("assistant", "Earlier answer.")
                rebased.add_message("user", "write a report")
                rebased.add_message("assistant", "Done.")
                gateway.session.context = rebased
                save_turn(
                    root,
                    "next",
                    "No new artifact.",
                    gateway.session.session_id,
                    rebased.get_messages(),
                )
                history = session_history(gateway.session)
            finally:
                os.chdir(cwd)

            restored = next(item for item in history if item.get("text") == "Done.")
            self.assertEqual(restored["artifacts"], [artifact])

    def test_every_reply_keeps_the_figures_it_was_answered_with(self) -> None:
        # A single `last_usage` described only the newest turn, so reopening a
        # conversation left every earlier reply with no metrics line at all.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cwd = Path.cwd()
            os.chdir(root)
            try:
                gateway = Gateway()
                first = {"cached_tokens": 0, "elapsed_ms": 1200, "input_tokens": 900, "output_tokens": 40}
                second = {"cached_tokens": 800, "elapsed_ms": 3400, "input_tokens": 2100, "output_tokens": 60}
                context = RunContext(metadata={"workspace": str(root)})
                context.add_message("user", "first question")
                context.add_message("assistant", "First answer.")
                gateway.session.context = context
                save_turn(root, "first question", "First answer.", gateway.session.session_id, context.get_messages(), metrics=first)

                context.add_message("user", "second question")
                context.add_message("assistant", "Second answer.")
                save_turn(root, "second question", "Second answer.", gateway.session.session_id, context.get_messages(), metrics=second)
                history = session_history(gateway.session)
            finally:
                os.chdir(cwd)

            replies = {item["text"]: item.get("metrics") for item in history if item["kind"] == "assistant"}
            self.assertEqual(replies["First answer."], first)
            self.assertEqual(replies["Second answer."], second)

    def test_metrics_survive_the_compaction_that_rewrites_the_prompt(self) -> None:
        # Records are written against the prompt and read back against the
        # transcript, and compaction moves one without moving the other.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cwd = Path.cwd()
            os.chdir(root)
            try:
                gateway = Gateway()
                metrics = {"cached_tokens": 12, "elapsed_ms": 900, "input_tokens": 500, "output_tokens": 30}
                context = RunContext(metadata={"workspace": str(root)})
                context.add_message("user", "early question")
                context.add_message("assistant", "Early answer.")
                gateway.session.context = context
                save_turn(root, "early question", "Early answer.", gateway.session.session_id, context.get_messages(), metrics=metrics)

                # Compaction moved the pair into the archive, behind turns the
                # prompt no longer holds, so the reply the record was written
                # against at index 1 now sits at index 3 of the transcript.
                compacted = RunContext(metadata={"workspace": str(root)})
                compacted.add_message("user", "later question")
                compacted.add_message("assistant", "Later answer.")
                compacted.metadata[ARCHIVED_MESSAGES] = [
                    {"role": "user", "content": "older question"},
                    {"role": "assistant", "content": "Older answer."},
                    {"role": "user", "content": "early question"},
                    {"role": "assistant", "content": "Early answer."},
                ]
                gateway.session.context = compacted
                history = session_history(gateway.session)
            finally:
                os.chdir(cwd)

            texts = [item["text"] for item in history if item["kind"] == "assistant"]
            self.assertEqual(texts, ["Older answer.", "Early answer.", "Later answer."])
            restored = next(item for item in history if item.get("text") == "Early answer.")
            self.assertEqual(restored["metrics"], metrics)
            # The figures belong to one reply, not to whatever sits at that index.
            self.assertIsNone(next(item for item in history if item["text"] == "Older answer.").get("metrics"))

    def test_a_started_run_puts_its_conversation_in_the_list_before_the_reply(self) -> None:
        # A session reaches the list by being saved, and it is saved when the turn
        # ends, so a conversation just started showed no trace of itself.
        gateway = Gateway()
        announced: list[tuple[str, dict[str, Any]]] = []

        with (
            patch.object(gateway.session, "chat", return_value=_turn_result("done")),
            patch.object(gateway, "ok"),
            patch.object(gateway, "event", side_effect=lambda name, payload: announced.append((name, payload))),
        ):
            gateway.run_chat("1", "look into this")

        # The start is what the sidebar was missing; the end it already had.
        self.assertEqual(
            [payload.get("running") for name, payload in announced if name == "session.updated"],
            [True, False],
        )

    def test_a_running_conversation_is_listed_even_with_nothing_on_disk(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cwd = Path.cwd()
            os.chdir(tmp)
            try:
                gateway = Gateway()
                session_id = gateway.session.session_id
                with gateway._state:
                    gateway.runs[session_id] = cast(Any, object())
                    gateway.run_labels[session_id] = "look into this"

                choices = gateway.session_choices()
            finally:
                os.chdir(cwd)

        self.assertEqual([choice["id"] for choice in choices], [session_id])
        self.assertTrue(choices[0]["running"])
        self.assertEqual(choices[0]["user"], "look into this")

    def test_gateway_continues_pending_goal_after_approval(self) -> None:
        gateway = Gateway()
        gateway.session.suspended = {"text": "delete file", "goal": True}

        with patch("friday.session.approve_pending", return_value={"approved": True}):
            with patch("friday.session.finish_pending_checkpoint"):
                with patch.object(FridaySession, "chat", return_value=_turn_result("continued")) as chat:
                    with patch.object(gateway, "write"):
                        gateway.handle({"id": "1", "method": "approval.approve"})

        chat.assert_called_once_with(
            "delete file",
            goal=True,
            approval_result={"approved": True},
            continuation=True,
        )
        self.assertIsNone(gateway.session.suspended)

    def test_gateway_continues_normal_chat_after_approval(self) -> None:
        gateway = Gateway()
        gateway.session.suspended = {"text": "delete file", "goal": False}
        result = {
            "approved": True,
            "result": {"exit_code": 0, "output": ""},
        }

        with patch("friday.session.approve_pending", return_value=result):
            with patch("friday.session.finish_pending_checkpoint"):
                with patch.object(FridaySession, "chat", return_value=_turn_result("deleted")) as chat:
                    with patch.object(gateway, "write"):
                        gateway.handle({"id": "1", "method": "approval.approve"})

        self.assertEqual(chat.call_args.args[0], "delete file")
        self.assertFalse(chat.call_args.kwargs["goal"])
        self.assertEqual(chat.call_args.kwargs["approval_result"], result)
        self.assertTrue(chat.call_args.kwargs["continuation"])
        self.assertIsNone(gateway.session.suspended)

    def test_gateway_can_allow_permissions_for_active_session(self) -> None:
        gateway = Gateway()
        gateway.session.suspended = {"text": "delete file", "goal": False}
        context = object()

        with patch("friday.session.approve_pending", return_value={"approved": True}):
            with patch("friday.session.finish_pending_checkpoint"):
                with patch.object(FridaySession, "ensure", return_value=(object(), context)):
                    with patch("friday.session.allow_permissions_for_session") as allow:
                        with patch.object(FridaySession, "chat", return_value=_turn_result("continued")):
                            with patch.object(gateway, "write"):
                                gateway.handle({"id": "1", "method": "approval.approve", "params": {"session": True}})

        allow.assert_called_once_with(context)

    def test_gateway_rejects_command_and_continues_with_human_guidance(self) -> None:
        gateway = Gateway()
        gateway.session.suspended = {"text": "delete file", "goal": True}

        with patch("friday.session.approve_pending", return_value={"approved": False, "rejected": True, "command": "rm file"}):
            with patch("friday.session.finish_pending_checkpoint"):
                with patch.object(FridaySession, "chat", return_value=_turn_result("used another approach")) as chat:
                    with patch.object(gateway, "write"):
                        gateway.handle({"id": "1", "method": "approval.instruct", "params": {"text": "keep the file and edit it instead"}})

        self.assertEqual(chat.call_args.args[0], "delete file")
        self.assertTrue(chat.call_args.kwargs["goal"])
        self.assertTrue(chat.call_args.kwargs["continuation"])
        self.assertEqual(chat.call_args.kwargs["approval_result"]["instruction"], "keep the file and edit it instead")
        self.assertIsNone(gateway.session.suspended)


if __name__ == "__main__":
    unittest.main()
