from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agent_core import RunContext

from friday.tui_gateway import Gateway, _estimate_tokens, _input_text, _usage_from_events


class TuiGatewayTests(unittest.TestCase):
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

    def test_usage_from_events_accepts_openai_and_anthropic_names(self) -> None:
        events = [
            {"data": {"usage": {"prompt_tokens": 10, "completion_tokens": 3}}},
            {"data": {"nested": {"usage": {"input_tokens": 12, "output_tokens": 4}}}},
        ]

        self.assertEqual(_usage_from_events(events), {"input_tokens": 12, "output_tokens": 4})

    def test_estimate_tokens_is_nonzero(self) -> None:
        self.assertEqual(_estimate_tokens(""), 1)
        self.assertEqual(_estimate_tokens("abcd"), 1)
        self.assertEqual(_estimate_tokens("abcde"), 2)

    def test_input_text_includes_harness_prompt(self) -> None:
        context = RunContext()
        context.add_message("system", "Harness prompt")
        context.add_message("user", "hello")
        context.add_message("assistant", "answer")

        text = _input_text(context, "answer")

        self.assertIn("Harness prompt", text)
        self.assertIn("hello", text)
        self.assertNotIn("answer", text)

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
