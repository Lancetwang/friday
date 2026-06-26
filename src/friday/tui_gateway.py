from __future__ import annotations

import json
import sys
import threading
from pathlib import Path
from typing import Any

from agent_core import Agent, AgentEvent, RunContext

from friday.app import build_friday, build_instructions, reset_friday, save_turn
from friday.tools import build_tools

_real_stdout = sys.stdout
sys.stdout = sys.stderr
_write_lock = threading.Lock()


def main() -> None:
    gateway = Gateway()
    gateway.event("gateway.ready", {"cwd": str(Path.cwd().resolve())})
    for line in sys.stdin:
        if line.strip():
            gateway.handle(json.loads(line))


class Gateway:
    def __init__(self) -> None:
        self.agent: Agent | None = None
        self.context: RunContext | None = None

    def handle(self, msg: dict[str, Any]) -> None:
        rid = msg.get("id")
        method = msg.get("method")
        params = msg.get("params") or {}
        try:
            if method == "session.info":
                self.ok(rid, self.session_info())
            elif method == "chat.send":
                self.ok(rid, self.chat(str(params.get("text") or "")))
            elif method == "prompt.get":
                self.ok(rid, {"text": build_instructions(Path.cwd().resolve(), Path.cwd().resolve() / ".friday")})
            elif method == "session.reset":
                removed = reset_friday(include_user=True)
                self.agent = None
                self.context = None
                self.ok(rid, {"removed": [str(path) for path in removed], "info": self.session_info()})
            else:
                self.err(rid, f"unknown method: {method}")
        except Exception as exc:
            self.err(rid, str(exc))

    def session_info(self) -> dict[str, Any]:
        return {
            "cwd": str(Path.cwd().resolve()),
            "model": "model from .env",
            "tools": [tool.name for tool in build_tools(Path.cwd().resolve(), Path.cwd().resolve() / ".friday")],
        }

    def chat(self, text: str) -> dict[str, str]:
        agent, context = self.ensure_agent()
        self.event("message.start", {"text": text})

        def delta(chunk: str) -> None:
            self.event("message.delta", {"text": chunk})

        answer = agent.chat(text, context=context, max_steps=20, on_delta=delta)
        self.event("message.complete", {"text": answer})
        save_turn(
            Path(context.metadata["workspace"]),
            text,
            answer,
            [event.to_dict() for event in context.events[-20:]],
        )
        return {"text": answer}

    def ensure_agent(self) -> tuple[Agent, RunContext]:
        if self.agent is None or self.context is None:
            self.agent, self.context = build_friday(stream=True)
            self.context.on_event = self.on_agent_event
        return self.agent, self.context

    def on_agent_event(self, event: AgentEvent) -> None:
        if event.type == "tool.call":
            self.event(
                "tool.start",
                {
                    "name": event.data.get("name", ""),
                    "arguments": event.data.get("arguments", {}),
                },
            )
        elif event.type == "tool.result":
            self.event(
                "tool.complete",
                {
                    "name": event.data.get("name", ""),
                    "error": bool(event.data.get("is_error")),
                    "content": event.data.get("content", ""),
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
