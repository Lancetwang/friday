from __future__ import annotations

import os
import tempfile
import threading
import time
import unittest
import json
from pathlib import Path
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from http.server import ThreadingHTTPServer

from agent_core import RunContext

import friday.trace_web as trace_web
from friday.state import save_turn
from friday.trace import begin_live_trace, finish_live_trace, load_trace, trace_turns
from friday.trace_web import TraceRequestHandler, analyze_trace, list_analyses, serve_trace_ui, start_trace_server


class FakeModel:
    def __init__(self) -> None:
        self.messages = []

    def chat_message(self, messages, **kwargs):
        self.messages = messages
        answer = "The answer follows from [event:1]."
        if on_delta := kwargs.get("on_delta"):
            on_delta("The answer follows ")
            on_delta("from [event:1].")
        return {"content": answer}


class TraceSecurityTests(unittest.TestCase):
    def test_model_request_projection_omits_hidden_messages(self) -> None:
        event = {
            "seq": 1,
            "type": "model.request",
            "data": {
                "messages": [{"role": "system", "content": "private control context"}],
                "tool_count": 9,
            },
        }

        projected = trace_web._analysis_event(event)

        self.assertEqual(projected["data"], {"message_count": 1, "tool_count": 9})
        self.assertNotIn("private control context", json.dumps(projected))


class TraceWebTests(unittest.TestCase):
    def test_approval_resume_stays_in_one_trace_turn_and_updates_model(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"FRIDAY_OBSERVABILITY_DIR": tmp}):
            workspace = Path(tmp) / "workspace"
            context = RunContext(
                metadata={
                    "workspace": str(workspace),
                    "session_id": "approval",
                    "friday.model_config": {"profile_id": "deepseek", "provider": "deepseek", "model": "deepseek-v4-flash"},
                }
            )
            path, turn_id = begin_live_trace(workspace, context=context, mode="chat", user="delete it", prompt_messages=[])
            finish_live_trace(path, turn_id, status="needs_approval")
            context.metadata["friday.model_config"] = {
                "profile_id": "mimo",
                "provider": "mimo",
                "model": "mimo-v2.5",
            }
            path, resumed_id = begin_live_trace(
                workspace,
                context=context,
                mode="chat",
                user="delete it",
                prompt_messages=[],
                turn_id=turn_id,
                continuation=True,
            )
            finish_live_trace(path, resumed_id, status="done")

            manifest, events = load_trace("approval")

            self.assertEqual(resumed_id, turn_id)
            self.assertEqual([event["type"] for event in events if event["type"].startswith("turn.")], [
                "turn.start", "turn.finish", "turn.resume", "turn.finish"
            ])
            self.assertEqual(len(trace_turns("approval", events)), 1)
            self.assertEqual(manifest["model"]["provider"], "mimo")

    def test_serve_trace_ui_stops_on_keyboard_interrupt(self) -> None:
        # The wait loop must sleep in short interruptible slices; an untimed
        # Event.wait() here would swallow Ctrl+C on Windows forever.
        server = MagicMock()
        with patch("friday.trace_web.start_trace_server", return_value=(server, "http://127.0.0.1:1")):
            with patch("friday.trace_web._trace_server_active", return_value=True):
                with patch("friday.trace_web.time.sleep", side_effect=KeyboardInterrupt):
                    with patch("friday.trace_web._close_trace_server") as close:
                        with patch("builtins.print"):
                            serve_trace_ui(open_browser=False)

        close.assert_called_once_with(server)

    def test_trace_server_releases_its_port_after_browser_heartbeat_stops(self) -> None:
        with patch("friday.trace_web._SERVER_IDLE_SECONDS", 0.02), patch("friday.trace_web._SERVER_POLL_SECONDS", 0.01):
            server, _url = start_trace_server(port=0, open_browser=False)
            deadline = time.time() + 1
            while trace_web._trace_server_active(server) and time.time() < deadline:
                time.sleep(0.01)

        self.assertFalse(trace_web._trace_server_active(server))

    def test_analysis_chat_is_persisted_separately(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"FRIDAY_OBSERVABILITY_DIR": tmp}):
            workspace = Path(tmp) / "workspace"
            context = RunContext(metadata={"workspace": str(workspace), "session_id": "s1"})
            path, turn_id = begin_live_trace(workspace, context=context, mode="chat", user="hello", prompt_messages=[])
            finish_live_trace(path, turn_id, status="done")
            model = FakeModel()

            with patch("friday.trace_web.build_model", return_value=model):
                result = analyze_trace("s1", "Why did it stop?")

            self.assertIn("[event:1]", result["answer"])
            self.assertIn("Session evidence:", model.messages[-1]["content"])
            self.assertIn("Why did it stop?", model.messages[-1]["content"])
            analyses = list_analyses("s1")
            self.assertEqual(analyses[0]["analysis_id"], result["analysis_id"])
            self.assertEqual([item["role"] for item in analyses[0]["messages"]], ["user", "assistant"])

    def test_web_api_lists_recorded_sessions(self) -> None:
        # save_turn writes under FRIDAY_HOME, so this has to redirect the home as
        # well as the trace directory or the run leaves a session in the real one.
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ, {"FRIDAY_HOME": str(Path(tmp) / "home" / ".friday"), "FRIDAY_OBSERVABILITY_DIR": tmp}
        ):
            workspace = Path(tmp) / "workspace"
            context = RunContext(metadata={"workspace": str(workspace), "session_id": "s2"})
            path, turn_id = begin_live_trace(workspace, context=context, mode="chat", user="hello", prompt_messages=[])
            save_turn(workspace, "hello", "hi", "s2", [])
            finish_live_trace(path, turn_id, status="done")
            server = ThreadingHTTPServer(("127.0.0.1", 0), TraceRequestHandler)
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            try:
                with urlopen(f"http://127.0.0.1:{server.server_port}/api/sessions") as response:
                    body = response.read().decode("utf-8")
            finally:
                server.shutdown()
                thread.join()
                server.server_close()

            self.assertIn('"session_id": "s2"', body)

    def test_event_api_returns_behavior_view_without_node_events(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"FRIDAY_OBSERVABILITY_DIR": tmp}):
            workspace = Path(tmp) / "workspace"
            context = RunContext(metadata={"workspace": str(workspace), "session_id": "s3"})
            path, turn_id = begin_live_trace(workspace, context=context, mode="chat", user="hello", prompt_messages=[])
            finish_live_trace(path, turn_id, status="done")
            server = ThreadingHTTPServer(("127.0.0.1", 0), TraceRequestHandler)
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            try:
                with urlopen(f"http://127.0.0.1:{server.server_port}/api/sessions/s3/events") as response:
                    body = json.loads(response.read().decode("utf-8"))
            finally:
                server.shutdown()
                thread.join()
                server.server_close()

            self.assertEqual([event["kind"] for event in body["events"]], ["user"])
            self.assertNotIn("node", body["events"][0])

    def test_turn_api_groups_session_history(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"FRIDAY_OBSERVABILITY_DIR": tmp}):
            workspace = Path(tmp) / "workspace"
            context = RunContext(metadata={"workspace": str(workspace), "session_id": "turns"})
            path, turn_id = begin_live_trace(workspace, context=context, mode="chat", user="hello", prompt_messages=[])
            finish_live_trace(path, turn_id, status="done", metrics={"elapsed_ms": 10})
            server = ThreadingHTTPServer(("127.0.0.1", 0), TraceRequestHandler)
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            try:
                with urlopen(f"http://127.0.0.1:{server.server_port}/api/sessions/turns/turns") as response:
                    body = json.loads(response.read().decode("utf-8"))
            finally:
                server.shutdown()
                thread.join()
                server.server_close()

            self.assertEqual(body["turns"][0]["user"], "hello")
            self.assertEqual(body["turns"][0]["status"], "done")

    def test_analysis_endpoint_streams_deltas_and_final_answer(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"FRIDAY_OBSERVABILITY_DIR": tmp}):
            workspace = Path(tmp) / "workspace"
            context = RunContext(metadata={"workspace": str(workspace), "session_id": "s4"})
            path, turn_id = begin_live_trace(workspace, context=context, mode="chat", user="hello", prompt_messages=[])
            finish_live_trace(path, turn_id, status="done")
            server = ThreadingHTTPServer(("127.0.0.1", 0), TraceRequestHandler)
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            request = Request(
                f"http://127.0.0.1:{server.server_port}/api/sessions/s4/analyze/stream",
                data=json.dumps({"question": "Why?"}).encode(),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            try:
                with patch("friday.trace_web.build_model", return_value=FakeModel()), urlopen(request) as response:
                    rows = [json.loads(line) for line in response.read().decode().splitlines()]
            finally:
                server.shutdown()
                thread.join()
                server.server_close()

            self.assertEqual([row["type"] for row in rows], ["delta", "delta", "final"])
            self.assertEqual(rows[-1]["answer"], "The answer follows from [event:1].")

    def test_analysis_endpoint_rejects_simple_cross_origin_posts(self) -> None:
        server = ThreadingHTTPServer(("127.0.0.1", 0), TraceRequestHandler)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        request = Request(
            f"http://127.0.0.1:{server.server_port}/api/sessions/missing/analyze",
            data=b'{"question":"spend tokens"}',
            headers={"Content-Type": "text/plain"},
            method="POST",
        )
        try:
            with patch("friday.trace_web.analyze_trace") as analyze:
                with self.assertRaises(HTTPError) as error:
                    urlopen(request)
        finally:
            server.shutdown()
            thread.join()
            server.server_close()

        self.assertEqual(error.exception.code, 400)
        analyze.assert_not_called()


if __name__ == "__main__":
    unittest.main()
