from __future__ import annotations

import json
import sys
import threading
from pathlib import Path
from typing import Any

from agent_core import AgentEvent

from friday.app import build_instructions, resume_choices
from friday.config import load_model_config
from friday.context import context_report
from friday.memory import format_memory_result, run_memory_command
from friday.session import FridaySession
from friday.tools import build_tools, pending_approval
from friday.trace_web import start_trace_server

_real_stdout = sys.stdout
sys.stdout = sys.stderr
_write_lock = threading.Lock()


def main() -> None:
    gateway = Gateway()
    gateway.event("gateway.ready", {"cwd": str(Path.cwd().resolve())})
    for line in sys.stdin:
        # Tolerate a UTF-8 BOM from Windows shells piping into the gateway.
        line = line.lstrip("\ufeff")
        if line.strip():
            gateway.handle(json.loads(line))


def verification_status(result: dict[str, Any]) -> dict[str, Any]:
    return {
        key: result[key]
        for key in ("approval_required", "error", "passed", "verdict")
        if key in result
    }


class Gateway:
    """JSON-RPC view over one FridaySession: renders events, owns no agent state."""

    def __init__(self) -> None:
        self.session = FridaySession(
            stream=True,
            on_delta=lambda chunk: self.event("message.delta", {"text": chunk}),
            on_verify=lambda verification: self.event("verification.complete", verification_status(verification)),
            on_context_notice=lambda notice: self.event("gateway.stderr", {"line": f"context {notice.split(':', 1)[0]}"}),
            on_event=self.on_agent_event,
            on_turn_start=lambda text: self.event("message.start", {"text": text}),
            on_turn_complete=lambda result: self.event(
                "message.complete",
                {"text": result.answer, "metrics": result.metrics, "progress": result.progress},
            ),
        )

    def handle(self, msg: dict[str, Any]) -> None:
        rid = msg.get("id")
        method = msg.get("method")
        params = msg.get("params") or {}
        try:
            if method == "session.info":
                self.ok(rid, self.session_info())
            elif method == "chat.send":
                self.ok(rid, {"text": self.session.chat(str(params.get("text") or "")).answer})
            elif method == "goal.run":
                self.ok(rid, {"text": self.session.chat(str(params.get("text") or ""), goal=True).answer})
            elif method == "prompt.get":
                self.ok(rid, {"text": build_instructions(Path.cwd().resolve(), Path.cwd().resolve() / ".friday")})
            elif method == "memory.command":
                result = run_memory_command(str(params.get("command") or ""), Path.cwd().resolve())
                self.ok(rid, {"text": format_memory_result(result)})
            elif method == "context.get":
                _agent, context = self.session.ensure()
                self.ok(rid, {"text": context_report(context, build_tools(Path.cwd().resolve(), Path.cwd().resolve() / ".friday"))})
            elif method == "progress.get":
                self.session.ensure()
                self.ok(rid, {"progress": self.session.progress()})
            elif method == "trace.serve":
                _server, url = start_trace_server()
                self.ok(rid, {"url": url})
            elif method == "session.reset":
                removed = self.session.reset()
                self.ok(rid, {"removed": [str(path) for path in removed], "info": self.session_info()})
            elif method == "session.compact":
                self.ok(rid, {"text": self.session.compact()})
            elif method == "session.resume":
                count = self.session.resume(params.get("id"))
                self.ok(rid, {"count": count, "progress": self.session.progress()})
            elif method == "session.resume_choices":
                self.ok(rid, {"choices": resume_choices()})
            elif method == "checkpoint.undo":
                restored = self.session.undo(params.get("id"), force=bool(params.get("force")))
                self.ok(
                    rid,
                    {
                        "id": restored["id"],
                        "user": restored.get("user", ""),
                        "changed_paths": restored.get("changed_paths", []),
                        "progress": self.session.progress(),
                    },
                )
            elif method == "approval.pending":
                self.ok(rid, pending_approval())
            elif method == "approval.approve":
                outcome = self.session.approve(for_session=bool(params.get("session")))
                if outcome["continued"]:
                    self.ok(
                        rid,
                        {
                            "approval": outcome["approval"],
                            "approved": True,
                            "continued": True,
                            "message": {"text": outcome["turn"].answer},
                        },
                    )
                else:
                    self.ok(rid, outcome["approval"])
            elif method == "approval.instruct":
                instruction = str(params.get("text") or "").strip()
                if not instruction:
                    raise ValueError("Tell Friday what to do before continuing.")
                outcome = self.session.reject(instruction)
                if outcome["continued"]:
                    self.ok(
                        rid,
                        {
                            "approval": outcome["approval"],
                            "continued": True,
                            "message": {"text": outcome["turn"].answer},
                        },
                    )
                else:
                    self.ok(rid, outcome["approval"])
            elif method == "approval.reject":
                self.ok(rid, self.session.reject()["approval"])
            else:
                self.err(rid, f"unknown method: {method}")
        except Exception as exc:
            self.err(rid, str(exc))

    def session_info(self) -> dict[str, Any]:
        config = load_model_config(Path.cwd().resolve())
        return {
            "cwd": str(Path.cwd().resolve()),
            "model": f"{config.provider}/{config.model}",
            "progress": self.session.progress(),
            "tools": [tool.name for tool in build_tools(Path.cwd().resolve(), Path.cwd().resolve() / ".friday")],
        }

    def on_agent_event(self, event: AgentEvent) -> None:
        if event.type == "verification.start":
            self.event("verification.start", {})
        elif event.type == "progress.updated":
            self.event("progress.update", dict(event.data))
        elif event.type == "tool.call":
            self.event(
                "tool.start",
                {
                    "name": event.data.get("name", ""),
                    "arguments": event.data.get("arguments", {}),
                },
            )
        elif event.type == "tool.result":
            content = event.data.get("content", "")
            if not isinstance(content, str):
                content = json.dumps(content, ensure_ascii=False)
            self.event(
                "tool.complete",
                {
                    "name": event.data.get("name", ""),
                    "error": bool(event.data.get("is_error")),
                    "content": content,
                },
            )

    def event(self, event_type: str, payload: dict[str, Any]) -> None:
        self.write({"jsonrpc": "2.0", "method": "event", "params": {"type": event_type, "payload": payload}})

    def ok(self, rid: str, result: Any) -> None:
        self.write({"jsonrpc": "2.0", "id": rid, "result": result})

    def err(self, rid: str, message: str) -> None:
        self.write({"jsonrpc": "2.0", "id": rid, "error": {"message": message}})

    def write(self, msg: dict[str, Any]) -> None:
        with _write_lock:
            _real_stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
            _real_stdout.flush()


if __name__ == "__main__":
    main()
