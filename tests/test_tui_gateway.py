from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agent_core import AgentEvent, RunContext

from friday.session import FridaySession
from friday.tui_gateway import Gateway, verification_status
from friday.turn import TurnResult


def _turn_result(answer: str) -> TurnResult:
    return TurnResult(
        agent=object(),
        context=RunContext(metadata={"workspace": str(Path.cwd())}),
        answer=answer,
        verifications=[],
        metrics={},
        progress={},
    )


class TuiGatewayTests(unittest.TestCase):
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

        event.assert_called_once_with("verification.start", {})

    def test_gateway_exposes_progress_updates(self) -> None:
        gateway = Gateway()
        progress = {"objective": "finish report", "status": "working"}

        with patch.object(gateway, "event") as event:
            gateway.on_agent_event(AgentEvent("progress.updated", category="progress", data=progress))

        event.assert_called_once_with("progress.update", progress)

    def test_gateway_routes_memory_commands_without_building_an_agent(self) -> None:
        gateway = Gateway()
        with patch("friday.tui_gateway.run_memory_command", return_value={"counts": {scope: 0 for scope in ("user", "global", "project", "episode")}, "chars": {scope: 0 for scope in ("user", "global", "project", "episode")}}):
            with patch.object(gateway, "ok") as ok, patch.object(FridaySession, "ensure") as ensure:
                gateway.handle({"id": "1", "method": "memory.command", "params": {"command": "status"}})

        ensure.assert_not_called()
        self.assertIn("Memory status", ok.call_args.args[1]["text"])

    def test_gateway_undo_replaces_the_active_session(self) -> None:
        gateway = Gateway()
        context = type("Context", (), {"on_event": None})()
        restored = {"id": "cp-1", "user": "change file", "changed_paths": ["file.txt"]}

        with patch("friday.session.undo_friday", return_value=(object(), context, restored)):
            with patch("friday.session.current_progress", return_value={"objective": "previous"}):
                with patch.object(gateway, "ok") as ok:
                    gateway.handle({"id": "1", "method": "checkpoint.undo"})

        self.assertIs(gateway.session.context, context)
        self.assertEqual(ok.call_args.args[1]["changed_paths"], ["file.txt"])

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
