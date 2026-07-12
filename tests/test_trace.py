from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from agent_core import RunContext

from friday.trace import begin_live_trace, finish_live_trace, write_live_event, write_trace


class TraceTests(unittest.TestCase):
    def test_write_trace_records_turn_events_and_prompt_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            context = RunContext()
            context.metadata["workspace"] = str(root)
            context.metadata["session_id"] = "s1"
            context.metadata["friday.loop_status"] = "done"
            context.add_message("system", "prefix")
            prompt_messages = [dict(message) for message in context.get_messages()]
            start_event = len(context.events)
            context.emit("tool.call", category="tool", data={"name": "Bash", "arguments": {"command": "echo ok"}})
            context.emit("tool.result", category="tool", data={"name": "Bash", "content": "ok", "is_error": False})
            context.add_message("assistant", "done")

            path = write_trace(
                root,
                mode="chat",
                user="run echo",
                assistant="done",
                context=context,
                start_event=start_event,
                prompt_messages=prompt_messages,
                metrics={"elapsed_ms": 12},
            )

            row = json.loads(path.read_text(encoding="utf-8").splitlines()[0])
            self.assertEqual(row["session_id"], "s1")
            self.assertEqual(row["mode"], "chat")
            self.assertEqual(row["prompt"]["message_count"], 1)
            self.assertEqual(row["prompt"]["messages"][0]["role"], "system")
            self.assertEqual(row["prompt"]["messages"][0]["chars"], 6)
            self.assertEqual([item["type"] for item in row["tools"]], ["call", "result"])
            self.assertEqual(row["metrics"]["elapsed_ms"], 12)
            self.assertNotIn("messages_after", row)
            self.assertNotIn("events", row)

    def test_write_trace_records_provider_usage(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            context = RunContext()
            prompt_messages = []
            start_event = len(context.events)
            context.emit("model.request", category="model", data={"message_count": 1})
            context.emit(
                "model.response",
                category="model",
                data={"usage": {"prompt_tokens": 11, "completion_tokens": 5}},
            )

            path = write_trace(
                root,
                mode="chat",
                user="hi",
                assistant="hello",
                context=context,
                start_event=start_event,
                prompt_messages=prompt_messages,
            )

            row = json.loads(path.read_text(encoding="utf-8").splitlines()[0])
            self.assertEqual(row["performance"]["totals"]["input_tokens"], 11)
            self.assertEqual(row["performance"]["totals"]["output_tokens"], 5)

    def test_live_trace_survives_before_turn_summary(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            context = RunContext()
            context.metadata["session_id"] = "s1"
            path, turn_id = begin_live_trace(root, context=context, mode="chat", user="search", prompt_messages=[])
            event = context.emit("model.request", category="model", data={"message_count": 1})
            write_live_event(path, turn_id, event)
            finish_live_trace(path, turn_id, status="error")

            rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
            self.assertEqual([row["kind"] for row in rows], ["start", "event", "finish"])
            self.assertEqual(rows[1]["event"]["type"], "model.request")
            self.assertEqual({row["turn_id"] for row in rows}, {turn_id})


if __name__ == "__main__":
    unittest.main()
