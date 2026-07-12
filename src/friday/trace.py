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
    turn_id: str | None = None,
) -> Path:
    events = [_event_dict(event) for event in context.events[start_event:]]
    row = {
        "schema_version": 2,
        "time": datetime.now().isoformat(timespec="seconds"),
        "turn_id": turn_id or uuid4().hex,
        "session_id": str(context.metadata.get("session_id") or ""),
        "mode": mode,
        "status": str(context.metadata.get("friday.loop_status") or "done"),
        "user": user,
        "assistant": assistant,
        "context_notice": context_notice,
        "metrics": metrics or {},
        "performance": _performance(events),
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


def begin_live_trace(
    workspace: Path,
    *,
    context: RunContext,
    mode: str,
    user: str,
    prompt_messages: list[dict[str, Any]],
) -> tuple[Path, str]:
    turn_id = uuid4().hex
    path = workspace / ".friday" / "traces" / "events" / f"{context.metadata.get('session_id') or 'session'}.jsonl"
    _append_live(
        path,
        {
            "schema_version": 1,
            "kind": "start",
            "time": datetime.now().isoformat(timespec="milliseconds"),
            "session_id": str(context.metadata.get("session_id") or ""),
            "turn_id": turn_id,
            "mode": mode,
            "user_tail": user[-1000:],
            "user_chars": len(user),
            "prompt": _prompt_summary(prompt_messages),
        },
    )
    return path, turn_id


def write_live_event(path: Path, turn_id: str, event: Any) -> None:
    value = _event_dict(event)
    event_type = str(value.get("type") or "")
    if event_type not in {"model.request", "model.response", "tool.call", "tool.result", "tool.observe", "verification.start", "verification.result", "loop.guard", "flow.end"}:
        return
    data = value.get("data", {})
    if not isinstance(data, dict):
        data = {}
    if event_type == "tool.result":
        content = str(data.get("content", ""))
        data = {**data, "content": content[:4000], "content_chars": len(content)}
    _append_live(
        path,
        {
            "schema_version": 1,
            "kind": "event",
            "time": datetime.now().isoformat(timespec="milliseconds"),
            "turn_id": turn_id,
            "event": {
                "type": event_type,
                "timestamp": value.get("timestamp"),
                "category": value.get("category"),
                "step": value.get("step"),
                "node": value.get("node"),
                "data": data,
            },
        },
    )


def finish_live_trace(path: Path, turn_id: str, *, status: str, metrics: dict[str, Any] | None = None) -> None:
    _append_live(
        path,
        {
            "schema_version": 1,
            "kind": "finish",
            "time": datetime.now().isoformat(timespec="milliseconds"),
            "turn_id": turn_id,
            "status": status,
            "metrics": metrics or {},
        },
    )


def _append_live(path: Path, row: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as file:
        file.write(json.dumps(row, ensure_ascii=False, default=str) + "\n")


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
            tools.append({"type": "result", "name": data.get("name"), "error": bool(data.get("is_error")), "content": str(data.get("content", ""))})
    return tools


def _performance(events: list[dict[str, Any]]) -> dict[str, Any]:
    model_calls: list[dict[str, Any]] = []
    tool_calls: list[dict[str, Any]] = []
    request_ts: float | None = None
    pending: list[tuple[float | None, Any, str]] = []
    for event in events:
        event_type = event.get("type")
        timestamp = event.get("timestamp")
        data = event.get("data", {})
        if not isinstance(data, dict):
            data = {}
        if event_type == "model.request":
            request_ts = _as_float(timestamp)
        elif event_type == "model.response":
            usage = data.get("usage", {}) if isinstance(data.get("usage"), dict) else {}
            model_calls.append(
                {
                    "duration_ms": _duration_ms(request_ts, timestamp),
                    "input_tokens": _usage_int(usage, "input_tokens", "prompt_tokens"),
                    "output_tokens": _usage_int(usage, "output_tokens", "completion_tokens"),
                    "content_length": data.get("content_length"),
                    "has_tool_calls": bool(data.get("has_tool_calls")),
                }
            )
            request_ts = None
        elif event_type == "tool.call":
            pending.append((_as_float(timestamp), data.get("name"), str(data.get("tool_call_id") or "")))
        elif event_type == "tool.result":
            start_ts, name, call_id = pending.pop(0) if pending else (None, data.get("name"), "")
            tool_calls.append(
                {
                    "name": name or data.get("name"),
                    "tool_call_id": call_id or str(data.get("tool_call_id") or ""),
                    "duration_ms": _duration_ms(start_ts, timestamp),
                    "is_error": bool(data.get("is_error")),
                    "content_chars": len(str(data.get("content", ""))),
                }
            )
    return {
        "model_calls": model_calls,
        "tool_calls": tool_calls,
        "totals": {
            "model_call_count": len(model_calls),
            "tool_call_count": len(tool_calls),
            "model_ms": _sum_ms(model_calls),
            "tool_ms": _sum_ms(tool_calls),
            "input_tokens": _sum_tokens(model_calls, "input_tokens"),
            "output_tokens": _sum_tokens(model_calls, "output_tokens"),
        },
    }


def _timeline(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    timeline = []
    for event in events:
        data = event.get("data", {})
        if not isinstance(data, dict):
            data = {}
        event_type = event.get("type")
        timestamp = event.get("timestamp")
        if event_type == "model.request":
            timeline.append({"type": event_type, "timestamp": timestamp, "message_count": data.get("message_count"), "tool_names": data.get("tool_names")})
        elif event_type == "model.response":
            timeline.append({"type": event_type, "timestamp": timestamp, "has_tool_calls": data.get("has_tool_calls"), "content_length": data.get("content_length"), "usage": data.get("usage")})
        elif event_type == "tool.observe":
            timeline.append({"type": event_type, "timestamp": timestamp, "tool_call_count": data.get("tool_call_count")})
        elif event_type == "flow.end":
            timeline.append({"type": event_type, "timestamp": timestamp})
    return timeline


def _prompt_summary(messages: list[dict[str, Any]]) -> dict[str, Any]:
    items = []
    for message in messages:
        role = str(message.get("role", ""))
        content = str(message.get("content", ""))
        item: dict[str, Any] = {"role": role, "chars": len(content)}
        if role == "system":
            item["sections"] = _sections(content)
        items.append(item)
    return {
        "message_count": len(messages),
        "chars": sum(item["chars"] for item in items),
        "messages": items,
    }


def _sections(text: str) -> list[str]:
    return [line[3:].strip() for line in text.splitlines() if line.startswith("## ")]


def _as_float(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) else None


def _duration_ms(start: Any, end: Any) -> float | None:
    start_value = _as_float(start)
    end_value = _as_float(end)
    if start_value is None or end_value is None:
        return None
    return round((end_value - start_value) * 1000, 1)


def _usage_int(usage: dict[str, Any], *names: str) -> int | None:
    for name in names:
        value = usage.get(name)
        if isinstance(value, int):
            return value
    return None


def _sum_ms(calls: list[dict[str, Any]]) -> float:
    return round(sum(call["duration_ms"] for call in calls if isinstance(call.get("duration_ms"), (int, float))), 1)


def _sum_tokens(calls: list[dict[str, Any]], key: str) -> int | None:
    values = [call.get(key) for call in calls]
    return sum(values) if values and all(isinstance(value, int) for value in values) else None
