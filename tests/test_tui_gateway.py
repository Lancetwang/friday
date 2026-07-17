from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agent_core import AgentEvent

from friday.tui_gateway import Gateway, verification_status


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
            with patch.object(gateway, "ok") as ok, patch.object(gateway, "ensure_agent") as ensure_agent:
                gateway.handle({"id": "1", "method": "memory.command", "params": {"command": "status"}})

        ensure_agent.assert_not_called()
        self.assertIn("Memory status", ok.call_args.args[1]["text"])

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
        gateway.pending_after_approval = {"text": "delete file", "goal": True}
        calls = []

        def chat(text, *, goal=False, approval_result=None, save_user=None):
            calls.append((text, goal, approval_result, save_user))
            return {"text": "continued"}

        with patch("friday.tui_gateway.approve_pending", return_value={"approved": True}):
            with patch.object(gateway, "chat", side_effect=chat):
                with patch.object(gateway, "write"):
                    gateway.handle({"id": "1", "method": "approval.approve"})

        self.assertEqual(calls, [("delete file", True, {"approved": True}, "/approve")])
        self.assertIsNone(gateway.pending_after_approval)

    def test_gateway_continues_normal_chat_after_approval(self) -> None:
        gateway = Gateway()
        gateway.pending_after_approval = {"text": "delete file", "goal": False}
        calls = []

        def chat(text, *, goal=False, approval_result=None, save_user=None):
            calls.append((text, goal, approval_result, save_user))
            return {"text": "deleted"}

        result = {
            "approved": True,
            "result": {"exit_code": 0, "output": ""},
        }
        with patch("friday.tui_gateway.approve_pending", return_value=result):
            with patch.object(gateway, "chat", side_effect=chat):
                with patch.object(gateway, "write"):
                    gateway.handle({"id": "1", "method": "approval.approve"})

        self.assertIn("approved the pending command", calls[0][0])
        self.assertFalse(calls[0][1])
        self.assertEqual(calls[0][2], result)
        self.assertEqual(calls[0][3], "/approve")
        self.assertIsNone(gateway.pending_after_approval)


if __name__ == "__main__":
    unittest.main()
