from __future__ import annotations

import os
import tempfile
import threading
import unittest
import json
from pathlib import Path
from unittest.mock import patch
from urllib.request import Request, urlopen
from http.server import ThreadingHTTPServer

from agent_core import RunContext

from friday.trace import begin_live_trace, finish_live_trace
from friday.trace_web import TraceRequestHandler, analyze_trace, list_analyses


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


class TraceWebTests(unittest.TestCase):
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
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"FRIDAY_OBSERVABILITY_DIR": tmp}):
            workspace = Path(tmp) / "workspace"
            context = RunContext(metadata={"workspace": str(workspace), "session_id": "s2"})
            path, turn_id = begin_live_trace(workspace, context=context, mode="chat", user="hello", prompt_messages=[])
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


if __name__ == "__main__":
    unittest.main()
