from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agent_core import RunContext

from friday.turn import run_turn


class TurnTests(unittest.TestCase):
    def test_run_turn_aggregates_runtime_usage_and_persists_once(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            context = RunContext(metadata={"workspace": tmp, "session_id": "s1"})
            agent = type("Agent", (), {"instructions": "test"})()

            def chat(*args, **kwargs):
                context.record_model_usage({"prompt_tokens": 10, "completion_tokens": 3})
                context.record_model_usage({"input_tokens": 12, "output_tokens": 4})
                return "done", []

            with patch("friday.turn.prepare_context_for_chat", return_value=(agent, context, "")):
                with patch("friday.turn.build_tools", return_value=[]):
                    with patch("friday.turn.verified_chat", side_effect=chat):
                        with patch("friday.turn.write_trace") as write_trace:
                            with patch("friday.turn.save_turn") as save_turn:
                                result = run_turn(agent, context, "hello", stream=False)

        self.assertEqual(result.metrics["requests"], 2)
        self.assertEqual(result.metrics["input_tokens"], 22)
        self.assertEqual(result.metrics["output_tokens"], 7)
        self.assertFalse(result.metrics["estimated_tokens"])
        write_trace.assert_called_once()
        save_turn.assert_called_once()

    def test_run_turn_keeps_event_handler_after_context_rebuild(self) -> None:
        old_context = RunContext(metadata={"workspace": str(Path.cwd())})
        new_context = RunContext(metadata={"workspace": str(Path.cwd())})
        handler = lambda event: None
        old_context.on_event = handler
        agent = type("Agent", (), {"instructions": "test"})()

        with patch("friday.turn.prepare_context_for_chat", return_value=(agent, new_context, "compacted")):
            with patch("friday.turn.build_tools", return_value=[]):
                with patch("friday.turn.verified_chat", return_value=("done", [])):
                    with patch("friday.turn.write_trace"):
                        with patch("friday.turn.save_turn"):
                            result = run_turn(agent, old_context, "hello", stream=False)

        self.assertIs(result.context.on_event, handler)


if __name__ == "__main__":
    unittest.main()
