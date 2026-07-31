from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
import threading
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from agent_core import RunContext

from friday.progress import current_progress
from friday.storage import friday_home, project_state_dir

SCHEMA_VERSION = 3
_WRITE_LOCK = threading.Lock()


def trace_root() -> Path:
    override = os.getenv("FRIDAY_OBSERVABILITY_DIR")
    return Path(override).expanduser().resolve() if override else friday_home() / "observability"


def begin_live_trace(
    workspace: Path,
    *,
    context: RunContext,
    mode: str,
    user: str,
    prompt_messages: list[dict[str, Any]],
) -> tuple[Path, str]:
    session_id = str(context.metadata.get("session_id") or "session")
    session_dir = trace_root() / "sessions" / session_id
    events_path = session_dir / "events.jsonl"
    turn_id = uuid4().hex
    now = _now()
    manifest = _read_json(session_dir / "manifest.json") or {
        "schema_version": SCHEMA_VERSION,
        "session_id": session_id,
        "workspace": str(workspace.resolve()),
        "created_at": now,
        "turns": 0,
        "status": "running",
        "model": context.metadata.get("friday.model_config", {}),
        "prefix_refs": [],
    }
    manifest.update(updated_at=now, status="running", last_mode=mode)
    if not manifest.get("first_user"):
        manifest["first_user"] = _preview(user, 160)
    _write_json(session_dir / "manifest.json", manifest)
    _append_event(
        events_path,
        {
            "type": "turn.start",
            "category": "turn",
            "turn_id": turn_id,
            "run_id": context.run_id,
            "data": {
                "mode": mode,
                "user": user,
                "initial_messages": _store_messages(session_dir, prompt_messages),
            },
        },
    )
    return events_path, turn_id


def write_live_event(path: Path, turn_id: str, event: Any) -> None:
    value = _event_dict(event)
    event_type = str(value.get("type") or "")
    if event_type in {"model.delta", "model.reasoning.delta", "model.request", "model.response", "message.add"}:
        return
    data = value.get("data", {})
    data = dict(data) if isinstance(data, dict) else {}
    session_dir = path.parent

    if event_type == "model.request.payload":
        messages = data.pop("messages", [])
        tools = data.pop("tools", [])
        message_refs = _store_messages(session_dir, messages if isinstance(messages, list) else [])
        tools_ref = {"ref": _store_object(session_dir, tools)}
        prefix_ref = next((item["ref"] for item in message_refs if item.get("role") == "system"), "")
        data.update(messages=message_refs, tools_ref=tools_ref, tool_count=len(tools) if isinstance(tools, list) else 0)
        event_type = "model.request"
        if prefix_ref:
            data["prefix_ref"] = prefix_ref
            _remember_prefix(session_dir, prefix_ref)
    elif event_type == "model.response.payload":
        message = data.pop("message", {})
        descriptor = _store_message(session_dir, message if isinstance(message, dict) else {"content": str(message)})
        usage = message.get("usage", {}) if isinstance(message, dict) and isinstance(message.get("usage"), dict) else {}
        data.update(message=descriptor, usage=usage, has_tool_calls=bool(message.get("tool_calls")) if isinstance(message, dict) else False)
        event_type = "model.response"
    elif event_type == "tool.result" and "content" in data:
        content = data.pop("content")
        data.update(content=_store_value(session_dir, content))
        full_output = _tool_full_output(session_dir, content)
        if full_output is not None:
            data["full_output"] = _store_value(session_dir, full_output)

    _append_event(
        path,
        {
            "type": event_type,
            "category": value.get("category"),
            "turn_id": turn_id,
            "run_id": value.get("run_id"),
            "step": value.get("step"),
            "node": value.get("node"),
            "action": value.get("action"),
            "timestamp": value.get("timestamp"),
            "data": data,
        },
    )


def record_context_transition(path: Path, turn_id: str, notice: str, messages: list[dict[str, Any]]) -> None:
    if not notice:
        return
    kind = "tool" if notice.startswith("tool results compacted") else "conversation"
    _append_event(
        path,
        {
            "type": "context.compacted",
            "category": "context",
            "turn_id": turn_id,
            "data": {
                "kind": kind,
                "notice": notice,
                "messages_after": _store_messages(path.parent, messages),
            },
        },
    )


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
    del workspace, start_event, prompt_messages
    session_id = str(context.metadata.get("session_id") or "session")
    session_dir = trace_root() / "sessions" / session_id
    path = session_dir / "events.jsonl"
    _append_event(
        path,
        {
            "type": "turn.result",
            "category": "turn",
            "turn_id": turn_id or uuid4().hex,
            "run_id": context.run_id,
            "data": {
                "mode": mode,
                "user": user,
                "assistant": _store_value(session_dir, assistant),
                "context_notice": context_notice,
                "metrics": metrics or {},
                "progress": current_progress(context),
                "verifications": verifications or [],
            },
        },
    )
    manifest = _read_json(session_dir / "manifest.json") or {}
    manifest.update(
        updated_at=_now(),
        status=str(context.metadata.get("friday.loop_status") or "done"),
        turns=int(manifest.get("turns", 0) or 0) + 1,
        last_user=_preview(user, 160),
        last_assistant=_preview(assistant, 200),
    )
    _write_json(session_dir / "manifest.json", manifest)
    return path


def finish_live_trace(path: Path, turn_id: str, *, status: str, metrics: dict[str, Any] | None = None) -> None:
    _append_event(
        path,
        {
            "type": "turn.finish",
            "category": "turn",
            "turn_id": turn_id,
            "data": {"status": status, "metrics": metrics or {}},
        },
    )
    manifest = _read_json(path.parent / "manifest.json") or {}
    manifest.update(updated_at=_now(), status=status)
    _write_json(path.parent / "manifest.json", manifest)


def record_checkpoint_restore(session_id: str, checkpoint_id: str, changed_paths: list[str]) -> None:
    session_dir = _session_dir(session_id)
    _append_event(
        session_dir / "events.jsonl",
        {
            "type": "checkpoint.restored",
            "category": "turn",
            "turn_id": uuid4().hex,
            "data": {
                "checkpoint_id": checkpoint_id,
                "changed_paths": changed_paths,
            },
        },
    )


def list_traces() -> list[dict[str, Any]]:
    _prune_orphan_traces()
    sessions = trace_root() / "sessions"
    if not sessions.exists():
        return []
    items = [_read_json(path) for path in sessions.glob("*/manifest.json")]
    return sorted((item for item in items if isinstance(item, dict)), key=lambda item: str(item.get("updated_at", "")), reverse=True)


def _prune_orphan_traces() -> int:
    sessions = trace_root() / "sessions"
    if not sessions.exists():
        return 0
    removed = 0
    for manifest_path in sessions.glob("*/manifest.json"):
        manifest = _read_json(manifest_path)
        if not manifest or manifest.get("status") == "running":
            continue
        workspace = Path(str(manifest.get("workspace") or "")).resolve()
        session_id = str(manifest.get("session_id") or "")
        session_name = f"{session_id}.json"
        if (
            (project_state_dir(workspace) / "sessions" / session_name).exists()
            or (workspace / ".friday" / "sessions" / session_name).exists()
        ):
            continue
        shutil.rmtree(manifest_path.parent)
        removed += 1
    return removed


def load_trace(session_id: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    session_dir = _session_dir(session_id)
    manifest = _read_json(session_dir / "manifest.json")
    if manifest is None:
        raise FileNotFoundError(f"Trace session not found: {session_id}")
    path = session_dir / "events.jsonl"
    rows = []
    if path.exists():
        with path.open(encoding="utf-8") as file:
            for seq, line in enumerate(file, start=1):
                if not line.strip():
                    continue
                row = json.loads(line)
                row["seq"] = seq
                rows.append(row)
    return manifest, rows


def delete_trace(session_id: str, workspace: Path | None = None) -> bool:
    session_dir = _session_dir(session_id)
    if not session_dir.exists():
        return False
    if workspace is not None:
        manifest = _read_json(session_dir / "manifest.json")
        if not manifest or Path(str(manifest.get("workspace") or "")).resolve() != workspace.resolve():
            return False
    shutil.rmtree(session_dir)
    return True


def delete_workspace_traces(workspace: Path) -> int:
    root = workspace.resolve()
    removed = 0
    for manifest_path in (trace_root() / "sessions").glob("*/manifest.json"):
        manifest = _read_json(manifest_path)
        if manifest and Path(str(manifest.get("workspace") or "")).resolve() == root:
            shutil.rmtree(manifest_path.parent)
            removed += 1
    return removed


def load_trace_object(session_id: str, ref: str) -> Any:
    session_dir = _session_dir(session_id)
    path = (session_dir / ref).resolve()
    objects = (session_dir / "objects").resolve()
    if path.parent != objects or not path.exists():
        raise FileNotFoundError(f"Trace object not found: {ref}")
    return json.loads(path.read_text(encoding="utf-8"))


def trace_stats(events: list[dict[str, Any]]) -> dict[str, Any]:
    event_counts = Counter(str(event.get("type") or "") for event in events)
    tool_counts = Counter()
    input_tokens = output_tokens = 0
    exact_usage = True
    for event in events:
        data = event.get("data", {})
        if not isinstance(data, dict):
            continue
        if event.get("type") == "tool.call":
            tool_counts[str(data.get("name") or "unknown")] += 1
        if event.get("type") == "model.response":
            usage = data.get("usage", {})
            prompt = _usage_int(usage, "prompt_tokens", "input_tokens")
            completion = _usage_int(usage, "completion_tokens", "output_tokens")
            if prompt is None or completion is None:
                exact_usage = False
            else:
                input_tokens += prompt
                output_tokens += completion
    return {
        "events": len(events),
        "event_counts": dict(event_counts),
        "tool_calls": dict(tool_counts),
        "usage": {
            "input_tokens": input_tokens if exact_usage else None,
            "output_tokens": output_tokens if exact_usage else None,
        },
    }


def behavior_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Project lossless trace events into the user-visible agent behavior."""
    results_by_call: dict[str, dict[str, Any]] = {}
    assistant_turns: set[str] = set()
    for event in events:
        data = event.get("data", {})
        if not isinstance(data, dict) or data.get("agent_role") == "verifier":
            continue
        if event.get("type") == "tool.result":
            call_id = str(data.get("tool_call_id") or "")
            if call_id:
                results_by_call[call_id] = event
        elif event.get("type") == "model.response":
            message = data.get("message", {})
            if isinstance(message, dict) and str(message.get("preview") or "").strip():
                assistant_turns.add(str(event.get("turn_id") or ""))

    behaviors: list[dict[str, Any]] = []
    for event in events:
        data = event.get("data", {})
        if not isinstance(data, dict) or data.get("agent_role") == "verifier":
            continue
        event_type = str(event.get("type") or "")
        seq = int(event.get("seq") or 0)
        common = {"time": event.get("time"), "turn_id": event.get("turn_id")}
        if event_type == "turn.start":
            text = str(data.get("user") or "").strip()
            if text:
                behaviors.append({**common, "kind": "user", "label": "YOU", "text": text, "seqs": [seq]})
        elif event_type == "tool.call":
            call_id = str(data.get("tool_call_id") or "")
            result = results_by_call.get(call_id)
            result_data = result.get("data", {}) if isinstance(result, dict) else {}
            result_data = result_data if isinstance(result_data, dict) else {}
            content = result_data.get("content", {})
            preview = str(content.get("preview") or "") if isinstance(content, dict) else str(content or "")
            seqs = [seq]
            if result is not None:
                seqs.append(int(result.get("seq") or 0))
            behaviors.append(
                {
                    **common,
                    "kind": "tool",
                    "label": "TOOL",
                    "name": str(data.get("name") or "Tool"),
                    "arguments": data.get("arguments", {}),
                    "result": preview,
                    "is_error": _tool_result_failed(result_data),
                    "pending": result is None,
                    "seqs": seqs,
                }
            )
        elif event_type == "model.response":
            message = data.get("message", {})
            text = str(message.get("preview") or "").strip() if isinstance(message, dict) else ""
            if text:
                behaviors.append({**common, "kind": "assistant", "label": "FRI", "text": text, "seqs": [seq]})
        elif event_type == "turn.result" and str(event.get("turn_id") or "") not in assistant_turns:
            assistant = data.get("assistant", {})
            text = str(assistant.get("preview") or "").strip() if isinstance(assistant, dict) else str(assistant or "").strip()
            if text:
                behaviors.append({**common, "kind": "assistant", "label": "FRI", "text": text, "seqs": [seq]})
    return behaviors


def trace_turns(session_id: str, events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Group lossless trace events into user turns and inspectable agent activity."""
    grouped: dict[str, list[dict[str, Any]]] = {}
    for event in events:
        turn_id = str(event.get("turn_id") or "")
        if turn_id:
            grouped.setdefault(turn_id, []).append(event)

    turns = []
    for turn_id, rows in grouped.items():
        start = next((row for row in rows if row.get("type") == "turn.start"), None)
        if start is None:
            continue
        result = next((row for row in reversed(rows) if row.get("type") == "turn.result"), None)
        finish = next((row for row in reversed(rows) if row.get("type") == "turn.finish"), None)
        start_data = start.get("data", {})
        result_data = result.get("data", {}) if result else {}
        finish_data = finish.get("data", {}) if finish else {}
        start_data = start_data if isinstance(start_data, dict) else {}
        result_data = result_data if isinstance(result_data, dict) else {}
        finish_data = finish_data if isinstance(finish_data, dict) else {}

        requests: dict[tuple[Any, Any], dict[str, Any]] = {}
        tool_results: dict[str, dict[str, Any]] = {}
        for row in rows:
            data = row.get("data", {})
            data = data if isinstance(data, dict) else {}
            if row.get("type") == "model.request":
                requests[(row.get("run_id"), row.get("step"))] = row
            elif row.get("type") == "tool.result":
                tool_results[str(data.get("tool_call_id") or "")] = row

        activities = []
        for row in rows:
            data = row.get("data", {})
            data = data if isinstance(data, dict) else {}
            event_type = str(row.get("type") or "")
            if event_type == "model.response":
                request = requests.get((row.get("run_id"), row.get("step")))
                message = _resolve_descriptor(session_id, data.get("message"))
                message = message if isinstance(message, dict) else {"content": str(message or "")}
                usage = data.get("usage", {})
                tool_calls = message.get("tool_calls", [])
                content = str(message.get("content") or "").strip()
                tool_names = [
                    str((call.get("function") or {}).get("name") or "")
                    for call in tool_calls
                    if isinstance(call, dict)
                ] if isinstance(tool_calls, list) else []
                activities.append(
                    {
                        "kind": "model",
                        "label": "Model response",
                        "summary": _preview(content, 240) if content else (
                            f"Requested {', '.join(name for name in tool_names if name)}" if tool_names else "Empty response"
                        ),
                        "content": content,
                        "status": "done",
                        "time": row.get("time"),
                        "duration_ms": _elapsed_ms(request, row),
                        "input_tokens": _usage_int(usage, "prompt_tokens", "input_tokens"),
                        "output_tokens": _usage_int(usage, "completion_tokens", "output_tokens"),
                        "cached_tokens": _cached_tokens(usage),
                        "agent_role": str(data.get("agent_role") or "agent"),
                        "seqs": [item["seq"] for item in (request, row) if item and item.get("seq")],
                    }
                )
            elif event_type == "tool.call":
                call_id = str(data.get("tool_call_id") or "")
                tool_result = tool_results.get(call_id)
                tool_data = tool_result.get("data", {}) if tool_result else {}
                tool_data = tool_data if isinstance(tool_data, dict) else {}
                content = tool_data.get("content", {})
                preview = str(content.get("preview") or "") if isinstance(content, dict) else str(content or "")
                activities.append(
                    {
                        "kind": "tool",
                        "label": str(data.get("name") or "Tool"),
                        "summary": _preview(preview, 240) if preview else "Waiting for result",
                        "arguments": data.get("arguments", {}),
                        "result": preview,
                        "status": "failed" if _tool_result_failed(tool_data) else ("done" if tool_result else "running"),
                        "time": row.get("time"),
                        "duration_ms": _elapsed_ms(row, tool_result),
                        "input_tokens": None,
                        "output_tokens": None,
                        "cached_tokens": None,
                        "agent_role": str(data.get("agent_role") or "agent"),
                        "seqs": [item["seq"] for item in (row, tool_result) if item and item.get("seq")],
                    }
                )
            elif event_type in {"verification.result", "context.compacted"} or event_type.startswith("approval."):
                activities.append(
                    {
                        "kind": "verification" if event_type == "verification.result" else (
                            "context" if event_type == "context.compacted" else "approval"
                        ),
                        "label": event_type.replace(".", " ").title(),
                        "summary": _preview(event_summary(row), 240),
                        "details": data,
                        "status": str(data.get("verdict") or data.get("status") or "done").lower(),
                        "time": row.get("time"),
                        "duration_ms": None,
                        "input_tokens": None,
                        "output_tokens": None,
                        "cached_tokens": None,
                        "agent_role": str(data.get("agent_role") or "agent"),
                        "seqs": [row["seq"]] if row.get("seq") else [],
                    }
                )

        metrics = result_data.get("metrics") or finish_data.get("metrics") or {}
        metrics = metrics if isinstance(metrics, dict) else {}
        assistant = _resolve_descriptor(session_id, result_data.get("assistant"))
        if not isinstance(assistant, str):
            assistant = str(assistant.get("content") or "") if isinstance(assistant, dict) else ""
        if not assistant:
            assistant = next(
                (str(activity.get("content") or "") for activity in reversed(activities) if activity["kind"] == "model"),
                "",
            )
        turns.append(
            {
                "turn_id": turn_id,
                "mode": str(start_data.get("mode") or result_data.get("mode") or "chat"),
                "status": str(finish_data.get("status") or "running"),
                "time": start.get("time"),
                "user": str(start_data.get("user") or result_data.get("user") or ""),
                "assistant": assistant,
                "duration_ms": metrics.get("elapsed_ms") if isinstance(metrics.get("elapsed_ms"), int) else _elapsed_ms(start, finish),
                "input_tokens": metrics.get("input_tokens"),
                "output_tokens": metrics.get("output_tokens"),
                "estimated_tokens": bool(metrics.get("estimated_tokens")),
                "activities": activities,
            }
        )
    return turns


def _tool_result_failed(data: dict[str, Any]) -> bool:
    if data.get("is_error"):
        return True
    content = data.get("content", {})
    value: Any = content.get("preview", "") if isinstance(content, dict) else content
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return value.lstrip().lower().startswith(("error", "failed"))
    if not isinstance(value, dict):
        return False
    exit_code = value.get("exit_code")
    return (
        (isinstance(exit_code, int) and exit_code != 0)
        or value.get("timed_out") is True
        or value.get("ok") is False
        or bool(value.get("error"))
    )


def event_summary(event: dict[str, Any]) -> str:
    data = event.get("data", {})
    data = data if isinstance(data, dict) else {}
    event_type = str(event.get("type") or "")
    if event_type == "turn.start":
        detail = str(data.get("user") or "")
    elif event_type == "model.request":
        messages = data.get("messages", [])
        detail = f"{len(messages) if isinstance(messages, list) else 0} messages · {data.get('tool_count', 0)} tools"
    elif event_type == "model.response":
        detail = str((data.get("message") or {}).get("preview") or "")
    elif event_type == "tool.call":
        detail = f"{data.get('name', '')} {json.dumps(data.get('arguments', {}), ensure_ascii=False, default=str)}"
    elif event_type == "tool.result":
        content = data.get("content", {})
        detail = f"{data.get('name', '')} {(content or {}).get('preview', '') if isinstance(content, dict) else content}"
    elif event_type == "verification.result":
        detail = f"{data.get('verdict', '')} {data.get('feedback', '')}"
    elif event_type == "turn.result":
        detail = str((data.get("assistant") or {}).get("preview") or "")
    elif event_type == "turn.finish":
        detail = str(data.get("status") or "")
    elif event_type == "context.compacted":
        detail = f"{data.get('kind', '')} {data.get('notice', '')}"
    else:
        detail = json.dumps(data, ensure_ascii=False, default=str)
    return f"[event:{event.get('seq', '?')}] {event_type} {_preview(detail, 300)}".strip()


def expand_event(session_id: str, event: dict[str, Any], *, max_chars: int = 30000) -> dict[str, Any]:
    expanded = json.loads(json.dumps(event, ensure_ascii=False, default=str))

    def resolve(value: Any) -> Any:
        if isinstance(value, dict):
            if isinstance(value.get("ref"), str):
                try:
                    content = load_trace_object(session_id, value["ref"])
                except (FileNotFoundError, json.JSONDecodeError):
                    return value
                text = json.dumps(content, ensure_ascii=False, default=str)
                return content if len(text) <= max_chars else {**value, "content": text[:max_chars], "truncated": True}
            return {key: resolve(item) for key, item in value.items()}
        if isinstance(value, list):
            return [resolve(item) for item in value]
        return value

    return resolve(expanded)


def _append_event(path: Path, row: dict[str, Any]) -> None:
    value = {
        "schema_version": SCHEMA_VERSION,
        "time": _now(),
        **row,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    with _WRITE_LOCK, path.open("a", encoding="utf-8") as file:
        file.write(json.dumps(value, ensure_ascii=False, default=str) + "\n")


def _store_messages(session_dir: Path, messages: list[Any]) -> list[dict[str, Any]]:
    return [_store_message(session_dir, message) for message in messages if isinstance(message, dict)]


def _store_message(session_dir: Path, message: dict[str, Any]) -> dict[str, Any]:
    content = str(message.get("content", ""))
    return {
        "ref": _store_object(session_dir, message),
        "role": str(message.get("role", "")),
        "chars": len(content),
        "preview": _preview(content, 240),
    }


def _store_value(session_dir: Path, value: Any) -> dict[str, Any]:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    return {
        "ref": _store_object(session_dir, value),
        "chars": len(text),
        "preview": _preview(text, 500),
    }


def _store_object(session_dir: Path, value: Any) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    path = session_dir / "objects" / f"{digest}.json"
    if not path.exists():
        _write_text_atomic(path, raw)
    return f"objects/{path.name}"


def _tool_full_output(session_dir: Path, content: Any) -> str | None:
    try:
        value = json.loads(content) if isinstance(content, str) else content
    except json.JSONDecodeError:
        return None
    if not isinstance(value, dict) or not isinstance(value.get("full_output_path"), str):
        return None
    manifest = _read_json(session_dir / "manifest.json") or {}
    workspace = Path(str(manifest.get("workspace") or "")).resolve()
    raw = Path(value["full_output_path"])
    state_dir = project_state_dir(workspace)
    if not raw.is_absolute() and raw.parts[:2] == (".friday", "tool-results"):
        migrated = state_dir.joinpath(*raw.parts[1:])
        raw = migrated if migrated.exists() else workspace / raw
    path = (workspace / raw).resolve()
    if (
        path != workspace
        and workspace not in path.parents
        and path != state_dir
        and state_dir not in path.parents
    ):
        return None
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


def _remember_prefix(session_dir: Path, prefix_ref: str) -> None:
    path = session_dir / "manifest.json"
    manifest = _read_json(path) or {}
    refs = list(manifest.get("prefix_refs") or [])
    if prefix_ref not in refs:
        refs.append(prefix_ref)
        manifest["prefix_refs"] = refs
        manifest["updated_at"] = _now()
        _write_json(path, manifest)


def _session_dir(session_id: str) -> Path:
    if not session_id or any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for char in session_id):
        raise ValueError("Invalid trace session id.")
    return trace_root() / "sessions" / session_id


def _event_dict(event: Any) -> dict[str, Any]:
    return event.to_dict() if hasattr(event, "to_dict") else dict(event)


def _read_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    return value if isinstance(value, dict) else None


def _write_json(path: Path, value: dict[str, Any]) -> None:
    _write_text_atomic(path, json.dumps(value, ensure_ascii=False, indent=2, default=str))


def _write_text_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with _WRITE_LOCK, tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, dir=path.parent) as file:
        file.write(text)
        temp_path = Path(file.name)
    temp_path.replace(path)


def _usage_int(usage: Any, *names: str) -> int | None:
    if not isinstance(usage, dict):
        return None
    for name in names:
        value = usage.get(name)
        if isinstance(value, int):
            return value
    return None


def _cached_tokens(usage: Any) -> int | None:
    direct = _usage_int(usage, "prompt_cache_hit_tokens")
    if direct is not None:
        return direct
    details = usage.get("prompt_tokens_details", {}) if isinstance(usage, dict) else {}
    return _usage_int(details, "cached_tokens")


def _resolve_descriptor(session_id: str, value: Any) -> Any:
    if not isinstance(value, dict) or not isinstance(value.get("ref"), str):
        return value
    try:
        return load_trace_object(session_id, value["ref"])
    except (FileNotFoundError, json.JSONDecodeError):
        return value.get("preview", "")


def _elapsed_ms(start: dict[str, Any] | None, end: dict[str, Any] | None) -> int | None:
    if not start or not end:
        return None
    start_stamp = start.get("timestamp")
    end_stamp = end.get("timestamp")
    if isinstance(start_stamp, (int, float)) and isinstance(end_stamp, (int, float)):
        return max(0, round((end_stamp - start_stamp) * 1000))
    try:
        return max(0, round((datetime.fromisoformat(str(end["time"])) - datetime.fromisoformat(str(start["time"]))).total_seconds() * 1000))
    except (KeyError, TypeError, ValueError):
        return None


def _preview(text: str, limit: int) -> str:
    clean = " ".join(str(text).split())
    return clean if len(clean) <= limit else clean[: limit - 3] + "..."


def _now() -> str:
    return datetime.now().isoformat(timespec="milliseconds")
