from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agent_core import RunContext

from friday.trace import (
    behavior_events,
    begin_live_trace,
    expand_event,
    finish_live_trace,
    list_traces,
    load_trace,
    record_context_transition,
    trace_stats,
    trace_turns,
    write_live_event,
    write_trace,
)


class TraceTests(unittest.TestCase):
    def test_trace_preserves_full_model_payload_by_reference(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"FRIDAY_OBSERVABILITY_DIR": tmp}):
            root = Path(tmp) / "workspace"
            context = RunContext(metadata={"workspace": str(root), "session_id": "s1"})
            messages = [{"role": "system", "content": "stable prefix"}, {"role": "user", "content": "hello"}]
            path, turn_id = begin_live_trace(root, context=context, mode="chat", user="hello", prompt_messages=messages[:1])
            context.on_observation = lambda event: write_live_event(path, turn_id, event)

            context.observe(
                "model.request.payload",
                category="model",
                data={
                    "messages": messages,
                    "tools": [{"type": "function", "function": {"name": "Read"}}],
                    "chat_kwargs": {"temperature": 0.2},
                },
            )
            context.observe(
                "model.response.payload",
                category="model",
                data={"message": {"role": "assistant", "content": "你好", "usage": {"prompt_tokens": 12, "completion_tokens": 2}}},
            )
            finish_live_trace(path, turn_id, status="done")

            manifest, events = load_trace("s1")
            request = expand_event("s1", next(event for event in events if event["type"] == "model.request"))
            response = expand_event("s1", next(event for event in events if event["type"] == "model.response"))

            self.assertEqual(request["data"]["messages"][0]["content"], "stable prefix")
            self.assertEqual(request["data"]["tools_ref"][0]["function"]["name"], "Read")
            self.assertEqual(response["data"]["message"]["content"], "你好")
            self.assertEqual(manifest["prefix_refs"], [events[1]["data"]["prefix_ref"]])
            self.assertEqual(trace_stats(events)["usage"]["input_tokens"], 12)

    def test_context_compaction_keeps_before_and_after_messages(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"FRIDAY_OBSERVABILITY_DIR": tmp}):
            root = Path(tmp) / "workspace"
            context = RunContext(metadata={"workspace": str(root), "session_id": "s2"})
            before = [{"role": "system", "content": "prefix"}, {"role": "tool", "content": "original tool result"}]
            after = [{"role": "system", "content": "prefix"}, {"role": "assistant", "content": "C1"}, {"role": "user", "content": "C2"}]
            path, turn_id = begin_live_trace(root, context=context, mode="chat", user="continue", prompt_messages=before)

            record_context_transition(path, turn_id, "conversation compacted: C1", after)

            _, events = load_trace("s2")
            start = expand_event("s2", events[0])
            compacted = expand_event("s2", events[1])
            self.assertEqual(start["data"]["initial_messages"][1]["content"], "original tool result")
            self.assertEqual(compacted["data"]["messages_after"][1]["content"], "C1")

    def test_trace_copies_truncated_tool_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"FRIDAY_OBSERVABILITY_DIR": tmp}):
            root = Path(tmp) / "workspace"
            artifact = root / ".friday" / "tool-results" / "bash.txt"
            artifact.parent.mkdir(parents=True)
            artifact.write_text("complete output", encoding="utf-8")
            context = RunContext(metadata={"workspace": str(root), "session_id": "s4"})
            path, turn_id = begin_live_trace(root, context=context, mode="chat", user="run", prompt_messages=[])

            event = context.emit(
                "tool.result",
                category="tool",
                data={"name": "Bash", "content": json.dumps({"full_output_path": ".friday/tool-results/bash.txt"})},
            )
            write_live_event(path, turn_id, event)

            _, events = load_trace("s4")
            result = expand_event("s4", next(item for item in events if item["type"] == "tool.result"))
            self.assertEqual(result["data"]["full_output"], "complete output")

    def test_turn_result_updates_manifest_without_copying_context(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"FRIDAY_OBSERVABILITY_DIR": tmp}):
            root = Path(tmp) / "workspace"
            context = RunContext(metadata={"workspace": str(root), "session_id": "s3", "friday.loop_status": "done"})
            path, turn_id = begin_live_trace(root, context=context, mode="chat", user="hi", prompt_messages=[])

            write_trace(
                root,
                mode="chat",
                user="hi",
                assistant="hello",
                context=context,
                start_event=0,
                prompt_messages=[],
                metrics={"input_tokens": 4},
                turn_id=turn_id,
            )

            manifest, events = load_trace("s3")
            result = expand_event("s3", next(event for event in events if event["type"] == "turn.result"))
            self.assertEqual(manifest["turns"], 1)
            self.assertEqual(result["data"]["assistant"], "hello")
            object_files = list((path.parent / "objects").glob("*.json"))
            self.assertEqual(len(object_files), 1)

    def test_trace_listing_prunes_sessions_that_no_longer_exist(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"FRIDAY_OBSERVABILITY_DIR": tmp}):
            root = Path(tmp) / "workspace"
            context = RunContext(metadata={"workspace": str(root), "session_id": "orphan"})
            path, turn_id = begin_live_trace(root, context=context, mode="chat", user="hello", prompt_messages=[])
            finish_live_trace(path, turn_id, status="done")

            self.assertEqual(list_traces(), [])
            self.assertFalse(path.parent.exists())

    def test_behavior_view_only_exposes_user_assistant_and_grouped_tools(self) -> None:
        events = [
            {"seq": 1, "type": "turn.start", "turn_id": "t1", "data": {"user": "inspect"}},
            {"seq": 2, "type": "model.request", "turn_id": "t1", "node": "chat", "data": {"messages": []}},
            {
                "seq": 3,
                "type": "tool.call",
                "turn_id": "t1",
                "node": "tools",
                "data": {"tool_call_id": "call-1", "name": "Read", "arguments": {"path": "a.py"}},
            },
            {
                "seq": 4,
                "type": "tool.result",
                "turn_id": "t1",
                "node": "tools",
                "data": {"tool_call_id": "call-1", "content": {"preview": '{"exit_code": 1}'}, "is_error": False},
            },
            {
                "seq": 5,
                "type": "model.response",
                "turn_id": "t1",
                "node": "chat",
                "data": {"message": {"preview": "The file is valid."}},
            },
            {
                "seq": 6,
                "type": "tool.call",
                "turn_id": "t1",
                "data": {"agent_role": "verifier", "tool_call_id": "verify-1", "name": "Bash", "arguments": {}},
            },
            {"seq": 7, "type": "turn.finish", "turn_id": "t1", "data": {"status": "done"}},
        ]

        projected = behavior_events(events)

        self.assertEqual([item["kind"] for item in projected], ["user", "tool", "assistant"])
        self.assertEqual(projected[1]["seqs"], [3, 4])
        self.assertEqual(projected[1]["result"], '{"exit_code": 1}')
        self.assertTrue(projected[1]["is_error"])
        self.assertTrue(all("node" not in item for item in projected))

    def test_trace_turns_pairs_model_and_tool_activity_with_exact_metrics(self) -> None:
        events = [
            {"seq": 1, "time": "2026-01-01T00:00:00.000", "type": "turn.start", "turn_id": "t1", "data": {"user": "inspect"}},
            {"seq": 2, "time": "2026-01-01T00:00:00.100", "timestamp": 1.0, "type": "model.request", "turn_id": "t1", "run_id": "r1", "step": 1, "data": {}},
            {
                "seq": 3,
                "time": "2026-01-01T00:00:00.300",
                "timestamp": 1.2,
                "type": "model.response",
                "turn_id": "t1",
                "run_id": "r1",
                "step": 1,
                "data": {
                    "message": {"content": ""},
                    "usage": {"prompt_tokens": 120, "completion_tokens": 8, "prompt_cache_hit_tokens": 80},
                },
            },
            {
                "seq": 4,
                "time": "2026-01-01T00:00:00.400",
                "timestamp": 1.3,
                "type": "tool.call",
                "turn_id": "t1",
                "data": {"tool_call_id": "call-1", "name": "Read", "arguments": {"path": "a.py"}},
            },
            {
                "seq": 5,
                "time": "2026-01-01T00:00:00.450",
                "timestamp": 1.35,
                "type": "tool.result",
                "turn_id": "t1",
                "data": {"tool_call_id": "call-1", "content": {"preview": "ok"}},
            },
            {
                "seq": 6,
                "time": "2026-01-01T00:00:00.500",
                "type": "turn.result",
                "turn_id": "t1",
                "data": {"assistant": "done", "metrics": {"elapsed_ms": 500, "input_tokens": 120, "output_tokens": 8}},
            },
            {"seq": 7, "time": "2026-01-01T00:00:00.500", "type": "turn.finish", "turn_id": "t1", "data": {"status": "done"}},
        ]

        turns = trace_turns("s1", events)

        self.assertEqual(turns[0]["user"], "inspect")
        self.assertEqual(turns[0]["assistant"], "done")
        self.assertEqual(turns[0]["input_tokens"], 120)
        self.assertEqual(turns[0]["activities"][0]["duration_ms"], 200)
        self.assertEqual(turns[0]["activities"][0]["cached_tokens"], 80)
        self.assertEqual(turns[0]["activities"][1]["duration_ms"], 50)


if __name__ == "__main__":
    unittest.main()
