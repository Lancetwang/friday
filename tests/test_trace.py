from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from agent_core import RunContext

from friday.trace import write_trace


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


if __name__ == "__main__":
    unittest.main()
