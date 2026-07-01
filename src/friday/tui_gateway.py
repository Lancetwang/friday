from __future__ import annotations

import json
import sys
import threading
import time
from pathlib import Path
from typing import Any

from agent_core import Agent, AgentEvent, RunContext

from friday.app import build_friday, build_instructions, compact_friday, reset_friday, resume_choices, resume_friday, save_turn
from friday.tools import approve_pending, build_tools

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
            elif method == "session.compact":
                agent, context = self.ensure_agent()
                self.agent, self.context, summary = compact_friday(agent, context, stream=True)
                self.context.on_event = self.on_agent_event
                self.ok(rid, {"text": summary})
            elif method == "session.resume":
                self.agent, self.context, count = resume_friday(stream=True, resume_id=params.get("id"))
                self.context.on_event = self.on_agent_event
                self.ok(rid, {"count": count})
            elif method == "session.resume_choices":
                self.ok(rid, {"choices": resume_choices()})
            elif method == "approval.approve":
                self.ok(rid, approve_pending())
            elif method == "approval.reject":
                self.ok(rid, approve_pending(reject=True))
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

    def chat(self, text: str) -> dict[str, Any]:
        agent, context = self.ensure_agent()
        self.event("message.start", {"text": text})
        start = time.perf_counter()

        def delta(chunk: str) -> None:
            self.event("message.delta", {"text": chunk})

        answer = agent.chat(text, context=context, max_steps=20, on_delta=delta)
        usage = _usage_from_events([event.to_dict() for event in context.events])
        estimated = usage["input_tokens"] is None or usage["output_tokens"] is None
        metrics = {
            "elapsed_ms": int((time.perf_counter() - start) * 1000),
            "estimated_tokens": estimated,
            "input_tokens": usage["input_tokens"] or _estimate_tokens(_input_text(context, answer)),
            "output_tokens": usage["output_tokens"] or _estimate_tokens(answer),
        }
        self.event("message.complete", {"text": answer, "metrics": metrics})
        save_turn(
            Path(context.metadata["workspace"]),
            text,
            answer,
            [event.to_dict() for event in context.events[-20:]],
            str(context.metadata.get("session_id") or ""),
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


def _usage_from_events(events: list[dict[str, Any]]) -> dict[str, int | None]:
    for event in reversed(events):
        usage = _find_usage(event)
        if usage:
            return {
                "input_tokens": _int_value(usage, "input_tokens", "prompt_tokens"),
                "output_tokens": _int_value(usage, "output_tokens", "completion_tokens"),
            }
    return {"input_tokens": None, "output_tokens": None}


def _find_usage(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        usage = value.get("usage")
        if isinstance(usage, dict):
            return usage
        for child in value.values():
            found = _find_usage(child)
            if found:
                return found
    elif isinstance(value, list):
        for child in value:
            found = _find_usage(child)
            if found:
                return found
    return None


def _int_value(value: dict[str, Any], *names: str) -> int | None:
    for name in names:
        item = value.get(name)
        if isinstance(item, int):
            return item
    return None


def _input_text(context: RunContext, answer: str) -> str:
    # Include system instructions so estimated input tokens count the harness prefix.
    parts = []
    for message in context.get_messages():
        content = str(message.get("content", ""))
        if message.get("role") == "assistant" and content == answer:
            continue
        parts.append(content)
    return "\n".join(parts)


def _estimate_tokens(text: str) -> int:
    # ponytail: rough display fallback; replace with provider usage when available.
    return max(1, (len(text) + 3) // 4)


if __name__ == "__main__":
    main()
