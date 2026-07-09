from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from agent_core import RunContext


def write_trace(
    workspace: Path,
    *,
    mode: str,
    user: str,
    assistant: str,
    context: RunContext,
    start_event: int,
    prompt_messages: list[dict[str, Any]],
    metrics: dict[str, Any] | None = None,
    verifications: list[dict[str, Any]] | None = None,
    context_notice: str = "",
) -> Path:
    events = [_event_dict(event) for event in context.events[start_event:]]
    row = {
        "schema_version": 1,
        "time": datetime.now().isoformat(timespec="seconds"),
        "turn_id": uuid4().hex,
        "session_id": str(context.metadata.get("session_id") or ""),
        "mode": mode,
        "status": str(context.metadata.get("friday.loop_status") or "done"),
        "user": user,
        "assistant": assistant,
        "context_notice": context_notice,
        "metrics": metrics or {},
        "prompt": _prompt_summary(prompt_messages),
        "timeline": _timeline(events),
        "tools": _tool_events(events),
        "verifications": verifications or [],
    }
    path = workspace / ".friday" / "traces" / f"{datetime.now().strftime('%Y%m%d')}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as file:
        file.write(json.dumps(row, ensure_ascii=False, default=str) + "\n")
    return path


def _event_dict(event: Any) -> dict[str, Any]:
    return event.to_dict() if hasattr(event, "to_dict") else dict(event)


def _tool_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    tools = []
    for event in events:
        data = event.get("data", {})
        if not isinstance(data, dict):
            continue
        if event.get("type") == "tool.call":
            tools.append({"type": "call", "name": data.get("name"), "arguments": data.get("arguments")})
        elif event.get("type") == "tool.result":
            content = data.get("content", "")
            tools.append({"type": "result", "name": data.get("name"), "error": bool(data.get("is_error")), "content": _clip(str(content))})
    return tools


def _timeline(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    timeline = []
    for event in events:
        data = event.get("data", {})
        if not isinstance(data, dict):
            data = {}
        event_type = event.get("type")
        if event_type == "model.request":
            timeline.append({"type": event_type, "message_count": data.get("message_count"), "tool_names": data.get("tool_names")})
        elif event_type == "model.response":
            timeline.append({"type": event_type, "has_tool_calls": data.get("has_tool_calls"), "content_length": data.get("content_length"), "usage": data.get("usage")})
        elif event_type == "tool.observe":
            timeline.append({"type": event_type, "tool_call_count": data.get("tool_call_count")})
        elif event_type == "flow.end":
            timeline.append({"type": event_type})
    return timeline


def _prompt_summary(messages: list[dict[str, Any]]) -> dict[str, Any]:
    items = []
    for message in messages:
        role = str(message.get("role", ""))
        content = str(message.get("content", ""))
        item: dict[str, Any] = {"role": role, "chars": len(content)}
        if role == "system":
            item["sections"] = _sections(content)
        else:
            item["preview"] = _clip(content, 200)
        items.append(item)
    return {
        "message_count": len(messages),
        "chars": sum(item["chars"] for item in items),
        "messages": items,
    }


def _sections(text: str) -> list[str]:
    return [line[3:].strip() for line in text.splitlines() if line.startswith("## ")]


def _clip(text: str, limit: int = 1000) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 3] + "..."
