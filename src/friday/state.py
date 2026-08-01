"""Session state kernel: Friday's single source of truth for a conversation.

The runtime (``agent_core``) owns execution: flows, nodes, model and tool
calls, and the per-run ``RunContext``. Friday owns the session: what the
conversation body is, what progress looks like, and how both survive turns,
compaction, resume, and undo. The boundary is deliberate: Friday talks to a
``RunContext`` only through its public API (``add_message``, ``get_messages``,
``metadata``, ``artifacts``), never by rewriting its internal bookkeeping.

Every rebuild is the same two steps, regardless of why it happens:

    agent, context = build_friday(workspace)   # fresh prefix from disk
    hydrate(context, state)                    # replay the owned session state

so compact, resume, and undo are just different ways to compute ``state``.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import tempfile
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from agent_core import RunContext

from friday.checkpoint import delete_session_checkpoints
from friday.model_options import DEFAULT_THINKING_EFFORT
from friday.progress import append_progress_checkpoint, is_progress_checkpoint, restore_progress
from friday.storage import migrate_legacy_runtime, project_state_dir
from friday.trace import delete_trace

RECENT_CONVERSATION_LIMIT = 10
SESSION_ID_PATTERN = re.compile(r"[A-Za-z0-9_-]+")
USER_MESSAGE_TIMES_KEY = "friday.user_message_times"


def new_session_id() -> str:
    return datetime.now().strftime("%Y%m%d%H%M%S%f") + "-" + uuid4().hex[:8]


@dataclass
class SessionState:
    """Everything Friday must re-own after an agent/context rebuild."""

    session_id: str = ""
    body: list[dict[str, Any]] = field(default_factory=list)
    progress: dict[str, Any] = field(default_factory=dict)
    last_usage: dict[str, Any] | None = None
    user_message_times: list[dict[str, str]] = field(default_factory=list)
    thinking_effort: str = DEFAULT_THINKING_EFFORT
    turns: int = 0


def state_from_snapshot(snapshot: dict[str, Any]) -> SessionState:
    messages = snapshot.get("messages")
    progress = snapshot.get("progress")
    last_usage = snapshot.get("last_usage")
    user_message_times = snapshot.get("user_message_times")
    return SessionState(
        session_id=str(snapshot.get("session_id") or ""),
        body=conversation_body(messages if isinstance(messages, list) else []),
        progress=dict(progress) if isinstance(progress, dict) else {},
        last_usage=dict(last_usage) if isinstance(last_usage, dict) else None,
        user_message_times=[dict(item) for item in user_message_times if isinstance(item, dict)]
        if isinstance(user_message_times, list)
        else [],
        thinking_effort=str(snapshot.get("thinking_effort") or DEFAULT_THINKING_EFFORT),
        turns=int(snapshot.get("turns", 0) or 0),
    )


def conversation_body(messages: list[Any]) -> list[dict[str, Any]]:
    """Saved messages minus the stale system prefix and derived progress checkpoints."""
    body = [dict(message) for message in messages if isinstance(message, dict) and not is_progress_checkpoint(message)]
    start = 0
    while start < len(body) and body[start].get("role") == "system":
        start += 1
    return body[start:]


def recent_turns(messages: list[Any], limit: int = RECENT_CONVERSATION_LIMIT) -> list[dict[str, Any]]:
    """The latest complete user turns, verbatim, including tool calls and results."""
    body = [dict(message) for message in messages if isinstance(message, dict) and not is_progress_checkpoint(message)]
    user_indices = [
        index
        for index, message in enumerate(body)
        if message.get("role") == "user" and not message.get("friday_internal")
    ]
    if not user_indices:
        return []
    return body[user_indices[-limit] :]


def hydrate(context: RunContext, state: SessionState) -> None:
    """Replay owned session state into a freshly built context.

    The fresh system prefix already present in the context is kept; the saved
    body is appended after it through ``add_message`` so the runtime keeps its
    own message bookkeeping consistent.
    """
    if state.session_id:
        context.metadata["session_id"] = state.session_id
    for message in state.body:
        extra = {key: value for key, value in message.items() if key not in {"role", "content", "scope"}}
        context.add_message(str(message.get("role") or "user"), message.get("content") or "", **extra)
    restore_progress(context, state.progress)
    if isinstance(state.last_usage, dict):
        context.metadata["friday.last_usage"] = dict(state.last_usage)
    context.metadata[USER_MESSAGE_TIMES_KEY] = [dict(item) for item in state.user_message_times]
    context.metadata["friday.thinking_effort"] = state.thinking_effort
    append_progress_checkpoint(context)


def save_turn(
    workspace: Path,
    user: str,
    assistant: str,
    session_id: str | None = None,
    messages: list[dict[str, Any]] | None = None,
    progress: dict[str, Any] | None = None,
    last_usage: dict[str, Any] | None = None,
    user_message_times: list[dict[str, str]] | None = None,
    thinking_effort: str = DEFAULT_THINKING_EFFORT,
    artifacts: list[dict[str, Any]] | None = None,
    continuation: bool = False,
) -> Path:
    """Persist one snapshot per session, overwritten in place (atomic).

    The file holds the current full message list plus light index metadata, so
    a session's on-disk size tracks the live context (O(N)) instead of appending
    a full snapshot every turn (O(N^2)).
    """
    sessions = project_state_dir(workspace) / "sessions"
    sessions.mkdir(parents=True, exist_ok=True)
    sid = session_id or new_session_id()
    path = sessions / f"{sid}.json"
    existing = read_session(path) or {}
    now = datetime.now().isoformat(timespec="seconds")
    saved_artifacts = (
        [item for item in existing.get("artifacts", []) if isinstance(item, dict)]
        if isinstance(existing.get("artifacts"), list)
        else []
    )
    body = conversation_body(messages or [])
    assistant_indexes: dict[str, list[int]] = {}
    for index, message in enumerate(body):
        if message.get("role") == "assistant":
            assistant_indexes.setdefault(_message_fingerprint(message), []).append(index)
    artifact_records = []
    for record in saved_artifacts:
        fingerprint = str(record.get("message_hash") or "")
        matches = assistant_indexes.get(fingerprint, [])
        old_index = record.get("message_index")
        if old_index in matches or len(matches) == 1:
            artifact_records.append({**record, "message_index": old_index if old_index in matches else matches[0]})
    if artifacts:
        message_index = next(
            (index for index in range(len(body) - 1, -1, -1) if body[index].get("role") == "assistant"),
            -1,
        )
        if message_index >= 0:
            artifact_records = [item for item in artifact_records if item.get("message_index") != message_index]
            artifact_records.append(
                {
                    "items": artifacts,
                    "message_hash": _message_fingerprint(body[message_index]),
                    "message_index": message_index,
                }
            )
    snapshot = {
        **{
            key: existing[key]
            for key in ("fork_parent", "fork_root", "fork_message_index")
            if key in existing
        },
        "session_id": sid,
        "created": existing.get("created") or now,
        "updated": now,
        "title": existing.get("title") or "",
        "turns": int(existing.get("turns", 0) or 0) + (0 if continuation else 1),
        "user": existing.get("user") or preview(user, 180),
        "assistant": preview(assistant, 220),
        "messages": messages or [],
        "progress": progress if isinstance(progress, dict) else existing.get("progress", {}),
        "last_usage": last_usage if isinstance(last_usage, dict) else existing.get("last_usage", {}),
        "user_message_times": user_message_times
        if isinstance(user_message_times, list)
        else existing.get("user_message_times", []),
        "thinking_effort": thinking_effort,
        "artifacts": artifact_records,
    }
    write_session(path, snapshot)
    return path


def save_progress(workspace: Path, session_id: str, progress: dict[str, Any]) -> Path:
    sessions = project_state_dir(workspace) / "sessions"
    sessions.mkdir(parents=True, exist_ok=True)
    path = sessions / f"{session_id}.json"
    existing = read_session(path) or {}
    now = datetime.now().isoformat(timespec="seconds")
    snapshot = {
        **existing,
        "session_id": session_id,
        "created": existing.get("created") or now,
        "updated": now,
        "turns": int(existing.get("turns", 0) or 0),
        "user": existing.get("user") or preview(str(progress.get("objective") or ""), 180),
        "assistant": existing.get("assistant") or "",
        "messages": existing.get("messages") or [],
        "progress": progress,
    }
    write_session(path, snapshot)
    return path


def save_session_state(
    workspace: Path,
    session_id: str,
    messages: list[dict[str, Any]],
    progress: dict[str, Any],
    *,
    thinking_effort: str = DEFAULT_THINKING_EFFORT,
) -> Path | None:
    path = project_state_dir(workspace) / "sessions" / f"{session_id}.json"
    existing = read_session(path)
    if not existing:
        return None
    existing.update(
        updated=datetime.now().isoformat(timespec="seconds"),
        messages=messages,
        progress=progress,
        thinking_effort=thinking_effort,
    )
    write_session(path, existing)
    return path


def load_session(workspace: Path, resume_id: str | None = None) -> dict[str, Any] | None:
    files = session_files(workspace)
    if not files:
        return None
    if resume_id:
        return read_session(session_path(workspace, resume_id))
    return read_session(files[-1])


def resume_choices(workspace: Path | None = None, *, limit: int = 8) -> list[dict[str, str]]:
    root = (workspace or Path.cwd()).resolve()
    choices: list[dict[str, str]] = []
    for path in reversed(session_files(root)[-limit:]):
        data = read_session(path)
        if not data or data.get("fork_parent"):
            continue
        progress = data.get("progress") if isinstance(data.get("progress"), dict) else {}
        choices.append(
            {
                "assistant": preview(str(data.get("assistant", ""))),
                "id": str(data.get("session_id") or path.stem),
                "objective": preview(str(progress.get("objective", ""))),
                "status": str(progress.get("status", "")),
                "time": str(data.get("updated") or ""),
                "title": preview(str(data.get("title", "")), 120),
                "turns": str(data.get("turns", 0)),
                "user": preview(str(data.get("user", ""))),
            }
        )
    return choices


def rename_session(workspace: Path, session_id: str, title: str) -> dict[str, Any]:
    title = " ".join(title.split())
    if not title:
        raise ValueError("Session title cannot be empty.")
    if len(title) > 120:
        raise ValueError("Session title cannot exceed 120 characters.")
    path = session_path(workspace, session_id)
    data = read_session(path)
    if data is None:
        raise FileNotFoundError(f"Session not found: {session_id}")
    data.update(title=title, updated=datetime.now().isoformat(timespec="seconds"))
    write_session(path, data)
    return data


def delete_session(workspace: Path, session_id: str) -> None:
    path = session_path(workspace, session_id)
    if not path.exists():
        raise FileNotFoundError(f"Session not found: {session_id}")
    delete_session_checkpoints(workspace, session_id)
    delete_trace(session_id, workspace)
    tool_results = project_state_dir(workspace) / "tool-results" / session_id
    if tool_results.exists():
        shutil.rmtree(tool_results)
    path.unlink()


def fork_session(
    workspace: Path,
    source_session_id: str,
    message_index: int,
    *,
    messages: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    source = read_session(session_path(workspace, source_session_id))
    if source is None:
        raise FileNotFoundError(f"Session not found: {source_session_id}")
    body = conversation_body(messages if messages is not None else source.get("messages", []))
    if message_index < 0 or message_index >= len(body):
        raise ValueError("Fork point is outside the conversation.")
    if body[message_index].get("role") != "assistant":
        raise ValueError("Conversations can only fork from an assistant response.")
    copied = body[: message_index + 1]
    session_id = new_session_id()
    now = datetime.now().isoformat(timespec="seconds")
    user_count = sum(message.get("role") == "user" and not message.get("friday_internal") for message in copied)
    snapshot = {
        "session_id": session_id,
        "created": now,
        "updated": now,
        "title": f"Fork of {source.get('title') or source.get('user') or source_session_id}",
        "turns": user_count,
        "user": source.get("user", ""),
        "assistant": "",
        "messages": copied,
        "progress": {},
        "last_usage": {},
        "user_message_times": list(source.get("user_message_times", []))[:user_count],
        "thinking_effort": source.get("thinking_effort", DEFAULT_THINKING_EFFORT),
        "artifacts": [
            record
            for record in (source.get("artifacts", []) if isinstance(source.get("artifacts"), list) else [])
            if isinstance(record, dict) and int(record.get("message_index", -1)) <= message_index
        ],
        "fork_parent": source_session_id,
        "fork_root": source.get("fork_root") or source_session_id,
        "fork_message_index": message_index,
    }
    write_session(session_path(workspace, session_id), snapshot)
    return snapshot


def session_tree(workspace: Path, session_id: str) -> dict[str, Any]:
    sessions = [data for path in session_files(workspace) if (data := read_session(path))]
    current = next((data for data in sessions if data.get("session_id") == session_id), None)
    if current is None:
        return {"root": "", "nodes": []}
    root = str(current.get("fork_root") or current.get("session_id") or "")
    nodes = [
        {
            "id": str(data.get("session_id") or ""),
            "parent": str(data.get("fork_parent") or ""),
            "title": preview(str(data.get("title") or data.get("user") or "Conversation"), 80),
            "time": str(data.get("updated") or ""),
        }
        for data in sessions
        if data.get("session_id") == root or data.get("fork_root") == root
    ]
    return {"root": root, "nodes": nodes}


def delete_session_tree(workspace: Path, session_id: str) -> list[str]:
    deleted = session_subtree_ids(workspace, session_id)
    for current in reversed(deleted):
        path = session_path(workspace, current)
        if path.exists():
            delete_session(workspace, current)
    return deleted


def session_subtree_ids(workspace: Path, session_id: str) -> list[str]:
    sessions = [data for path in session_files(workspace) if (data := read_session(path))]
    children: dict[str, list[str]] = {}
    for data in sessions:
        parent = str(data.get("fork_parent") or "")
        if parent:
            children.setdefault(parent, []).append(str(data.get("session_id") or ""))
    pending = [session_id]
    found: list[str] = []
    while pending:
        current = pending.pop()
        pending.extend(children.get(current, []))
        if session_path(workspace, current).exists():
            found.append(current)
    return found


def session_path(workspace: Path, session_id: str) -> Path:
    if not SESSION_ID_PATTERN.fullmatch(session_id):
        raise ValueError("Invalid session id.")
    return migrate_legacy_runtime(workspace) / "sessions" / f"{session_id}.json"


def session_files(workspace: Path) -> list[Path]:
    sessions = migrate_legacy_runtime(workspace) / "sessions"
    if not sessions.exists():
        return []
    # Session ids are timestamps, so lexical filename order is chronological.
    return sorted(sessions.glob("*.json"))


def read_session(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    return data if isinstance(data, dict) else None


def write_session(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, dir=path.parent) as file:
        json.dump(data, file, ensure_ascii=False)
        temp_path = Path(file.name)
    temp_path.replace(path)


def _message_fingerprint(message: dict[str, Any]) -> str:
    value = json.dumps(message.get("content"), ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:20]


def preview(text: str, limit: int = 80) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit - 3] + "..."
