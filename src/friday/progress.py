from __future__ import annotations

from copy import deepcopy
from datetime import datetime
from pathlib import Path
from typing import Any

from agent_core import RunContext

PROGRESS_ARTIFACT = "friday.progress"
PROGRESS_HEADING = "## Current Session Progress"
STEP_STATUSES = {"pending", "in_progress", "completed", "blocked"}


def current_progress(context: RunContext) -> dict[str, Any]:
    value = context.artifacts.get(PROGRESS_ARTIFACT, {})
    return deepcopy(value) if isinstance(value, dict) else {}


def begin_progress(context: RunContext, request: str, *, mode: str, continuation: bool = False) -> dict[str, Any]:
    previous = current_progress(context)
    if not continuation or not previous:
        state = {
            "objective": request.strip(),
            "latest_request": request.strip(),
            "mode": mode,
            "status": "working",
            "steps": [],
            "next_action": "",
            "verification": {},
        }
    else:
        state = previous
        state["status"] = "working"
        state["next_action"] = ""
    return _store(context, state)


def update_plan(
    context: RunContext,
    plan: list[dict[str, Any]],
    *,
    objective: str = "",
    explanation: str = "",
    next_action: str = "",
) -> dict[str, Any]:
    steps = _validate_plan(plan)
    state = current_progress(context)
    if not state:
        raise RuntimeError("No active Friday progress state.")
    if objective.strip():
        state["objective"] = objective.strip()
    state["steps"] = steps
    state["status"] = "working"
    state["next_action"] = next_action.strip()
    return _store(context, state, explanation=explanation.strip())


def finish_progress(context: RunContext, loop_status: str, verifications: list[dict[str, Any]]) -> dict[str, Any]:
    state = current_progress(context)
    if not state:
        return {}
    last = verifications[-1] if verifications else {}
    state["verification"] = {
        key: last[key]
        for key in ("attempt", "stop_reason", "verdict")
        if key in last
    }
    if loop_status == "done":
        state["status"] = "done"
        state["next_action"] = ""
        state["steps"] = [{**step, "status": "completed"} for step in state.get("steps", [])]
    elif loop_status == "needs_approval":
        state["status"] = "waiting"
        state["next_action"] = "Choose whether to approve, allow for this session, reject, or provide guidance."
    else:
        state["status"] = "blocked"
        state["next_action"] = str(last.get("next_check") or last.get("feedback") or loop_status).strip()
    return _store(context, state)


def restore_progress(context: RunContext, value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or not str(value.get("objective") or "").strip():
        return {}
    try:
        steps = _validate_plan(value.get("steps") if isinstance(value.get("steps"), list) else [])
    except ValueError:
        steps = []
    status = str(value.get("status") or "working")
    if status not in {"blocked", "done", "waiting", "working"}:
        status = "working"
    state = {
        "objective": str(value.get("objective") or "").strip(),
        "latest_request": str(value.get("latest_request") or "").strip(),
        "mode": "goal" if value.get("mode") == "goal" else "normal",
        "status": status,
        "steps": steps,
        "next_action": str(value.get("next_action") or "").strip(),
        "verification": dict(value.get("verification") or {}) if isinstance(value.get("verification"), dict) else {},
        "updated": str(value.get("updated") or ""),
    }
    context.artifacts[PROGRESS_ARTIFACT] = state
    return current_progress(context)


def append_progress_checkpoint(context: RunContext) -> None:
    state = current_progress(context)
    if state:
        collections = [context.messages]
        scoped = context.get_messages()
        if scoped is not context.messages:
            collections.append(scoped)
        for messages in collections:
            if messages and is_progress_checkpoint(messages[-1]):
                messages.pop()
        context.add_message("assistant", progress_checkpoint(state), friday_progress=True)


def is_progress_checkpoint(message: dict[str, Any]) -> bool:
    if message.get("friday_progress"):
        return True
    # Sessions saved before the metadata flag existed carry only the heading.
    return str(message.get("content") or "").startswith(PROGRESS_HEADING)


def progress_checkpoint(state: dict[str, Any]) -> str:
    lines = [
        PROGRESS_HEADING,
        f"Objective: {_clip(str(state.get('objective') or ''), 1000)}",
        f"Mode: {state.get('mode', 'normal')}",
        f"Status: {state.get('status', 'working')}",
    ]
    latest = str(state.get("latest_request") or "").strip()
    if latest and latest != state.get("objective"):
        lines.append(f"Latest user update: {_clip(latest, 1000)}")
    steps = state.get("steps", [])
    if steps:
        lines.append("Plan:")
        marks = {"pending": "[ ]", "in_progress": "[>]", "completed": "[x]", "blocked": "[!]"}
        lines.extend(f"- {marks[step['status']]} {_clip(step['step'], 500)}" for step in steps)
    if state.get("next_action"):
        lines.append(f"Next action: {_clip(str(state['next_action']), 1000)}")
    return "\n".join(lines)


def progress_line(state: dict[str, Any]) -> str:
    if not state:
        return "No active session progress."
    steps = state.get("steps", [])
    completed = sum(step.get("status") == "completed" for step in steps)
    count = f" | {completed}/{len(steps)} steps" if steps else ""
    next_action = f" | next: {state['next_action']}" if state.get("next_action") else ""
    return f"[{state.get('status', 'working')}] {state.get('objective', '')}{count}{next_action}"


def _validate_plan(plan: list[dict[str, Any]]) -> list[dict[str, str]]:
    if len(plan) > 12:
        raise ValueError("Plan supports at most 12 steps.")
    steps: list[dict[str, str]] = []
    for item in plan:
        if not isinstance(item, dict):
            raise ValueError("Each plan item must be an object.")
        step = str(item.get("step") or "").strip()
        status = str(item.get("status") or "").strip()
        if not step or status not in STEP_STATUSES:
            raise ValueError("Plan items require step and status=pending|in_progress|completed|blocked.")
        steps.append({"step": step, "status": status})
    if sum(step["status"] == "in_progress" for step in steps) > 1:
        raise ValueError("At most one plan step can be in_progress.")
    return steps


def _store(context: RunContext, state: dict[str, Any], *, explanation: str = "") -> dict[str, Any]:
    state = deepcopy(state)
    state["updated"] = datetime.now().isoformat(timespec="seconds")
    context.set_artifact(PROGRESS_ARTIFACT, state)
    context.emit("progress.updated", category="progress", data={**state, "explanation": explanation})
    workspace = context.metadata.get("workspace")
    session_id = context.metadata.get("session_id")
    if workspace and session_id:
        from friday.state import save_progress

        save_progress(Path(str(workspace)), str(session_id), state)
    return current_progress(context)


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 3] + "..."
