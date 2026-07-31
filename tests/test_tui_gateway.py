from __future__ import annotations

import io
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from agent_core import AgentEvent, RunContext

from friday.session import FridaySession
from friday.app_server import Gateway, _request_lines, session_history, verification_status
from friday.state import delete_session_tree, fork_session, read_session, resume_choices, save_turn, session_path, session_tree
from friday.turn import TurnResult
from friday.turn import TurnCancelled


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

    def test_gateway_writes_unicode_json_without_escaping(self) -> None:
        output = io.StringIO()

        Gateway(output=output).event("message.delta", {"text": "你好，Friday"})

        self.assertIn("你好，Friday", output.getvalue())

    def test_gateway_does_not_expose_effective_prompt(self) -> None:
        gateway = Gateway()

        with patch.object(gateway, "err") as error:
            gateway.handle({"id": "1", "method": "prompt.get"})

        error.assert_called_once_with("1", "unknown method: prompt.get")

    def test_verification_status_omits_trace_details(self) -> None:
        result = verification_status(
            {
                "evidence": ["test passed"],
                "feedback": "done",
                "passed": True,
                "verdict": "pass",
            }
        )

        self.assertEqual(result, {"passed": True, "verdict": "pass"})

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

        session.cancel()

        def cancelled(_agent, context, _text, **_kwargs):
            self.assertTrue(context.metadata["friday.cancel_event"].is_set())
            raise TurnCancelled("stop")

        with patch("friday.session.run_turn", side_effect=cancelled):
            with patch("friday.session.build_friday", return_value=(object(), fresh)):
                with self.assertRaises(TurnCancelled):
                    session.chat("discarded")

        self.assertEqual([message["content"] for message in session.context.get_messages()], ["fresh prefix", "kept"])
        self.assertFalse(session._cancel_event.is_set())

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
            fork = fork_session(root, "root", 1)
            save_turn(root, "branch", "done", fork["session_id"], fork["messages"])

            self.assertEqual([choice["id"] for choice in resume_choices(root)], ["root"])
            self.assertEqual(len(session_tree(root, fork["session_id"])["nodes"]), 2)
            self.assertEqual(read_session(session_path(root, fork["session_id"]))["fork_parent"], "root")
            self.assertCountEqual(delete_session_tree(root, "root"), ["root", fork["session_id"]])

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
                    "tool.result",
                    category="tool",
                    data={"tool_call_id": "call-1", "content": "Friday", "is_error": False},
                )
            )

        self.assertEqual(event.call_args_list[0].args[1]["tool_call_id"], "call-1")
        self.assertEqual(event.call_args_list[1].args[1]["tool_call_id"], "call-1")

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

    def test_gateway_opens_trace_server_on_an_available_port(self) -> None:
        gateway = Gateway()
        server = object()
        with patch("friday.app_server.start_trace_server", return_value=(server, "http://127.0.0.1:3210")) as start:
            with patch.object(gateway, "ok") as ok:
                gateway.handle({"id": "1", "method": "trace.serve"})

        start.assert_called_once_with(port=0)
        ok.assert_called_once_with("1", {"url": "http://127.0.0.1:3210"})

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

    def test_gateway_sets_permission_mode_for_the_live_process(self) -> None:
        gateway = Gateway()

        with patch.dict(os.environ, {"FRIDAY_PERMISSION_MODE": "manual"}, clear=False):
            with patch.object(gateway, "ok") as ok:
                gateway.handle({"id": "1", "method": "permission.set", "params": {"mode": "bypass"}})

            self.assertEqual(os.environ["FRIDAY_PERMISSION_MODE"], "bypass")
            ok.assert_called_once_with("1", {"permission_mode": "bypass"})

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
            user_label="/approve",
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

        prompt = chat.call_args.args[0]
        self.assertIn("approved the pending command", prompt)
        self.assertFalse(chat.call_args.kwargs["goal"])
        self.assertEqual(chat.call_args.kwargs["approval_result"], result)
        self.assertEqual(chat.call_args.kwargs["user_label"], "/approve")
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

        prompt = chat.call_args.args[0]
        self.assertIn("delete file", prompt)
        self.assertIn("keep the file", prompt)
        self.assertTrue(chat.call_args.kwargs["goal"])
        self.assertTrue(chat.call_args.kwargs["continuation"])
        self.assertEqual(chat.call_args.kwargs["user_label"], "keep the file and edit it instead")
        self.assertIsNone(gateway.session.suspended)


if __name__ == "__main__":
    unittest.main()
