from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agent_core import Agent, RunContext

from friday.loop import LoopResult
from friday.trace import expand_event, load_trace
from friday.turn import _replace_pending_tool_result, _with_local_attachments, run_turn


class TurnTests(unittest.TestCase):
    def setUp(self) -> None:
        self.trace_tmp = tempfile.TemporaryDirectory()
        self.trace_env = patch.dict(
            os.environ,
            {
                "FRIDAY_OBSERVABILITY_DIR": self.trace_tmp.name,
                "FRIDAY_CHECKPOINT_DIR": str(Path(self.trace_tmp.name) / "checkpoints"),
                "FRIDAY_HOME": str(Path(self.trace_tmp.name) / "friday-home"),
            },
        )
        self.trace_env.start()

    def tearDown(self) -> None:
        self.trace_env.stop()
        self.trace_tmp.cleanup()

    def test_run_turn_aggregates_runtime_usage_and_persists_once(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            context = RunContext(metadata={"workspace": tmp, "session_id": "s1"})
            agent = type("Agent", (), {"instructions": "test"})()

            def chat(*args, **kwargs):
                context.record_model_usage({"prompt_tokens": 10, "completion_tokens": 3})
                context.record_model_usage({"input_tokens": 12, "output_tokens": 4})
                return LoopResult(answer="done")

            with patch("friday.turn.prepare_context_for_chat", return_value=(agent, context, "")):
                with patch("friday.turn.build_tools", return_value=[]):
                    with patch("friday.turn.run_loop", side_effect=chat):
                        with patch("friday.turn.write_trace") as write_trace:
                            with patch("friday.turn.save_turn") as save_turn:
                                result = run_turn(agent, context, "hello", stream=False)

        self.assertEqual(result.metrics["requests"], 2)
        self.assertEqual(result.metrics["input_tokens"], 22)
        self.assertEqual(result.metrics["output_tokens"], 7)
        self.assertFalse(result.metrics["estimated_tokens"])
        write_trace.assert_called_once()
        save_turn.assert_called_once()
        self.assertEqual(save_turn.call_args.kwargs["user_message_times"][0]["text"], "hello")
        self.assertEqual(result.context.events, [])

    def test_run_turn_persists_reasoning_and_tool_durations(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            context = RunContext(metadata={"workspace": tmp, "session_id": "timed"})
            agent = type("Agent", (), {"instructions": "test"})()

            def chat(*args, **kwargs):
                context.observe("model.request.payload", category="model", data={"messages": []})
                context.emit("model.reasoning.delta", category="model", data={"content": "thinking"})
                context.observe(
                    "model.response.payload",
                    category="model",
                    data={"message": {"content": "", "reasoning_content": "consider the files"}},
                )
                context.emit(
                    "tool.result",
                    category="tool",
                    data={"tool_call_id": "call-1", "content": "done", "elapsed_ms": 125.4},
                )
                context.add_message("assistant", "done")
                return LoopResult(answer="done")

            with patch("friday.turn.prepare_context_for_chat", return_value=(agent, context, "")):
                with patch("friday.turn.build_tools", return_value=[]):
                    with patch("friday.turn.run_loop", side_effect=chat):
                        with patch("friday.turn.write_trace"):
                            with patch("friday.turn.save_turn") as save_turn:
                                run_turn(agent, context, "hello", stream=False)

        activities = save_turn.call_args.kwargs["activities"]
        self.assertEqual([item["kind"] for item in activities], ["reasoning", "tool"])
        self.assertEqual(activities[0]["text"], "consider the files")
        self.assertGreaterEqual(activities[0]["elapsed_ms"], 0)
        self.assertEqual(activities[1]["elapsed_ms"], 125)

    def test_local_attachments_are_indexed_without_loading_their_contents(self) -> None:
        request = _with_local_attachments(
            "Review this",
            [
                {"kind": "file", "path": "E:\\reports\\brief.pdf"},
                {"kind": "folder", "path": "E:\\reports\\references"},
            ],
        )

        self.assertIn('file: "E:\\\\reports\\\\brief.pdf"', request)
        self.assertIn('folder: "E:\\\\reports\\\\references"', request)
        self.assertNotIn("%PDF", request)

    def test_run_turn_persists_attachment_display_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            context = RunContext(metadata={"workspace": tmp, "session_id": "attachments"})
            agent = type("Agent", (), {"instructions": "test"})()
            attachment = {"kind": "file", "name": "brief.pdf", "path": str(Path(tmp) / "brief.pdf"), "size": 3}

            with patch("friday.turn.prepare_context_for_chat", return_value=(agent, context, "")):
                with patch("friday.turn.build_tools", return_value=[]):
                    with patch("friday.turn.run_loop", return_value=LoopResult(answer="done")) as run_loop:
                        with patch("friday.turn.write_trace"), patch("friday.turn.save_turn") as save_turn:
                            run_turn(agent, context, "Review this", stream=False, attachments=[attachment])

        request = run_loop.call_args.args[2]
        self.assertIn(json.dumps(str(Path(tmp) / "brief.pdf")), request)
        record = save_turn.call_args.kwargs["user_message_times"][0]
        self.assertEqual(record["display_text"], "Review this")
        self.assertEqual(record["attachments"], [attachment])
        self.assertFalse(record["goal"])

    def test_metrics_separate_window_occupancy_from_what_the_turn_cost(self) -> None:
        """Occupancy is a level; cost is a total. They must not be read as one number.

        Because an append-only conversation is re-sent on every step, cumulative
        usage runs far ahead of how full the window actually is. Reporting only
        the total is what makes a mostly-empty window look full.
        """
        with tempfile.TemporaryDirectory() as tmp:
            context = RunContext(
                metadata={"workspace": tmp, "session_id": "s1", "friday.model_config": {"context_window": 300000}}
            )
            agent = type("Agent", (), {"instructions": "test"})()

            def chat(*args, **kwargs):
                for _ in range(3):
                    usage = {
                        "prompt_tokens": 250000,
                        "completion_tokens": 100,
                        "prompt_cache_hit_tokens": 200000,
                    }
                    context.observe(
                        "model.request.payload",
                        category="model",
                        data={"messages": list(context.get_messages()), "tools": [], "chat_kwargs": {}},
                    )
                    context.record_model_usage(usage)
                    context.observe(
                        "model.response.payload",
                        category="model",
                        data={"message": {"usage": usage}},
                    )
                return LoopResult(answer="done")

            with patch("friday.turn.prepare_context_for_chat", return_value=(agent, context, "")):
                with patch("friday.turn.build_tools", return_value=[]):
                    with patch("friday.turn.run_loop", side_effect=chat):
                        with patch("friday.turn.write_trace"):
                            with patch("friday.turn.save_turn"):
                                result = run_turn(agent, context, "hello", stream=False)

        metrics = result.metrics
        self.assertEqual(metrics["input_tokens"], 750000)
        self.assertEqual(metrics["cached_tokens"], 600000)
        self.assertEqual(metrics["window"], 300000)
        self.assertEqual(metrics["window_tokens"], 250000)
        self.assertEqual(metrics["window_provider_tokens"], 250000)
        self.assertEqual(metrics["window_delta_tokens"], 0)
        self.assertEqual(metrics["window_token_source"], "provider")
        self.assertLess(metrics["window_tokens"], metrics["input_tokens"])

    def test_rejection_guidance_is_a_user_message_not_tool_data(self) -> None:
        context = RunContext()
        context.add_message(
            "tool",
            '{"approval_required": true, "id": "a1"}',
            tool_call_id="call-1",
        )

        _replace_pending_tool_result(
            context,
            {
                "rejected": True,
                "approval": {"id": "a1"},
                "instruction": "keep the file and edit it instead",
            },
        )

        messages = context.get_messages()
        self.assertNotIn("instruction", json.loads(messages[-2]["content"]))
        self.assertEqual(messages[-1]["role"], "user")
        self.assertEqual(messages[-1]["content"], "keep the file and edit it instead")
        self.assertTrue(messages[-1]["friday_human_guidance"])

    def test_run_turn_reports_each_progress_transition_once(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            context = RunContext(metadata={"workspace": tmp, "session_id": "progress"})
            agent = type("Agent", (), {"instructions": "test"})()
            updates = []

            with patch("friday.turn.prepare_context_for_chat", return_value=(agent, context, "")):
                with patch("friday.turn.build_tools", return_value=[]):
                    with patch("friday.turn.run_loop", return_value=LoopResult(answer="done")):
                        with patch("friday.turn.write_trace"), patch("friday.turn.save_turn"):
                            run_turn(agent, context, "hello", stream=False, on_progress=updates.append)

        self.assertEqual([update["status"] for update in updates], ["working", "done"])

    def test_trace_manifest_keeps_the_actual_loop_stop_status(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            context = RunContext(metadata={"workspace": tmp, "session_id": "stopped"})
            agent = type("Agent", (), {"instructions": "test"})()

            def stop(*args, **kwargs):
                context.metadata["friday.loop_status"] = "no_progress"
                return LoopResult(answer="stopped", status="no_progress", agent=agent, context=context)

            with patch("friday.turn.prepare_context_for_chat", return_value=(agent, context, "")):
                with patch("friday.turn.build_tools", return_value=[]), patch("friday.turn.run_loop", side_effect=stop):
                    with patch("friday.turn.capture_user_memory"), patch("friday.turn.relevant_memory", return_value=""):
                        run_turn(agent, context, "repeat", stream=False)

        manifest, _events = load_trace("stopped")
        self.assertEqual(manifest["status"], "no_progress")

    def test_run_turn_records_actual_model_request(self) -> None:
        class Model:
            def chat_message(self, messages, **kwargs):
                return {"role": "assistant", "content": "hello", "usage": {"prompt_tokens": 4, "completion_tokens": 1}}

        with tempfile.TemporaryDirectory() as tmp:
            agent = Agent(model=Model(), instructions="prefix", stream=False)
            context = agent.new_context()
            context.metadata.update(workspace=tmp, session_id="observed")
            with patch("friday.turn.prepare_context_for_chat", return_value=(agent, context, "")):
                with patch("friday.turn.build_tools", return_value=[]), patch("friday.turn.capture_user_memory"), patch("friday.turn.relevant_memory", return_value=""):
                    run_turn(agent, context, "hello", stream=False)

        _, events = load_trace("observed")
        request = expand_event("observed", next(event for event in events if event["type"] == "model.request"))
        self.assertEqual(request["data"]["messages"][-1]["content"], "hello")
        self.assertFalse(any("## Current Session Progress" in message["content"] for message in request["data"]["messages"]))

    def test_run_turn_keeps_event_handler_after_context_rebuild(self) -> None:
        old_context = RunContext(metadata={"workspace": str(Path.cwd())})
        new_context = RunContext(metadata={"workspace": str(Path.cwd())})
        handler = lambda event: None
        old_context.on_event = handler
        agent = type("Agent", (), {"instructions": "test"})()

        with patch("friday.turn.prepare_context_for_chat", return_value=(agent, new_context, "compacted")):
            with patch("friday.turn.build_tools", return_value=[]):
                with patch("friday.turn.run_loop", return_value=LoopResult(answer="done")):
                    with patch("friday.turn.write_trace"):
                        with patch("friday.turn.save_turn"):
                            result = run_turn(agent, old_context, "hello", stream=False)

        self.assertIs(result.context.on_event, handler)

    def test_run_turn_injects_recalled_memory_and_captures_user_signal(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            context = RunContext(metadata={"workspace": tmp, "session_id": "s1"})
            agent = type("Agent", (), {"instructions": "test"})()

            def chat(*args, **kwargs):
                memory_messages = [message for message in context.get_messages() if message.get("friday_memory_recall")]
                self.assertEqual(memory_messages[0]["content"], "## Relevant Memory\n- prior preference")
                return LoopResult(answer="done")

            with patch("friday.turn.prepare_context_for_chat", return_value=(agent, context, "")):
                with patch("friday.turn.relevant_memory", return_value="## Relevant Memory\n- prior preference"):
                    with patch("friday.turn.capture_user_memory") as capture:
                        with patch("friday.turn.build_tools", return_value=[]), patch("friday.turn.run_loop", side_effect=chat):
                            with patch("friday.turn.write_trace"), patch("friday.turn.save_turn"):
                                run_turn(agent, context, "以后请用中文", stream=False)

            capture.assert_called_once_with(Path(tmp), "以后请用中文", session_id="s1")


if __name__ == "__main__":
    unittest.main()
