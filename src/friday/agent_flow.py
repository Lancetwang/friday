from __future__ import annotations

import base64
import hashlib
import json
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from agent_core import CallableNode, Flow, ModelNode, RunContext, Tool, ToolCallNode, ToolExecutor, ToolRouterNode, get_current_context
from agent_core.llm import ChatModel

from friday.compaction import CompactionRecord, announce_compaction, compact_in_place
from friday.context import (
    TOOL_COMPACT_AT,
    compact_tool_results,
    context_ratio,
    context_window,
    should_compact_tools,
    token_estimate,
)
from friday.tools import IMAGE_MIME_TYPES, MAX_IMAGE_BYTES

GUARD_STATE = "friday.loop_guard"
GUARD_STOP_REASON = "friday.guard_stop_reason"
RUN_USAGE_BASELINE = "friday.run_usage_baseline"


def build_guarded_flow(
    model: ChatModel,
    tools: Sequence[Tool],
    *,
    chat_kwargs: Mapping[str, Any],
) -> Flow:
    model_node = ModelNode(model=model, tools=tools, action="observe", chat_kwargs=chat_kwargs)
    router_node = ToolRouterNode(tool_action="tool_call", done_action="final")
    tool_node = ToolCallNode(executor=ToolExecutor(tools), next_action="guard")
    guard_node = CallableNode(_guard_after_tools)
    suspend_node = CallableNode(_suspend_for_approval)

    model_node - "observe" >> router_node
    router_node - "tool_call" >> tool_node
    tool_node - "guard" >> guard_node
    guard_node - "chat" >> model_node
    # Terminal edges: an action with no successor ends an agent-core flow. The
    # router's "final" answer exits that way, and the suspend node makes the
    # approval exit an explicit part of the graph instead of an unwired action.
    guard_node - "suspend" >> suspend_node
    return Flow(model_node)


def begin_guarded_run(context: RunContext, usage_start: Any) -> None:
    context.metadata[RUN_USAGE_BASELINE] = {
        "requests": int(getattr(usage_start, "requests", 0)),
        "usage_requests": int(getattr(usage_start, "usage_requests", 0)),
        "input_tokens": int(getattr(usage_start, "input_tokens", 0)),
        "output_tokens": int(getattr(usage_start, "output_tokens", 0)),
    }
    context.metadata[GUARD_STATE] = {"event_index": len(context.events), "seen": {}}
    context.metadata.pop(GUARD_STOP_REASON, None)


def inherit_guarded_run(target: RunContext, source: RunContext) -> None:
    baseline = source.metadata.get(RUN_USAGE_BASELINE)
    if isinstance(baseline, dict):
        target.metadata[RUN_USAGE_BASELINE] = dict(baseline)
    config = source.metadata.get("friday.model_config")
    if isinstance(config, dict):
        target.metadata["friday.model_config"] = dict(config)
    if isinstance(source.metadata.get("friday.thinking_effort"), str):
        target.metadata["friday.thinking_effort"] = source.metadata["friday.thinking_effort"]
    target.metadata[GUARD_STATE] = {"event_index": len(target.events), "seen": {}}
    target.metadata.pop(GUARD_STOP_REASON, None)


def _guard_after_tools(payload: Any):
    state = dict(payload or {})
    context = get_current_context()
    if context is None:
        return "chat", state

    _attach_tool_images(context, state)
    approval = _approval_required(context)
    if approval:
        context.emit("approval.pending", category="tool", action="suspend", data=approval)
        return "suspend", state

    # A run is not bounded by how long it takes or what it costs: it ends when
    # the work is done, when it stops making progress, or when the window can no
    # longer be made to fit. Compaction is what keeps the last one rare.
    reason = _no_progress(context) or _context_window(context)
    if reason:
        context.metadata[GUARD_STOP_REASON] = reason
        context.emit("loop.guard", category="flow", action="finalize", data={"reason": reason})
        context.add_message("system", _finalize_message(reason))
        state["chat_kwargs"] = {**dict(state.get("chat_kwargs", {}) or {}), "tool_choice": "none"}
    return "chat", state


def _attach_tool_images(context: RunContext, state: dict[str, Any]) -> None:
    parts: list[dict[str, Any]] = []
    workspace = Path(str(context.metadata.get("workspace") or ".")).resolve()
    for result in state.get("tool_results", [])[:4]:
        try:
            value = json.loads(result.content)
        except (AttributeError, json.JSONDecodeError):
            continue
        if not isinstance(value, dict) or value.get("image") is not True:
            continue
        path = Path(str(value.get("path") or "")).resolve()
        mime_type = IMAGE_MIME_TYPES.get(path.suffix.lower())
        if not mime_type or not path.is_file() or (path != workspace and workspace not in path.parents):
            continue
        if path.stat().st_size > MAX_IMAGE_BYTES:
            continue
        parts.extend(
            [
                {"type": "text", "text": f"Image loaded from {path.relative_to(workspace).as_posix()} for visual inspection."},
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:{mime_type};base64,{base64.b64encode(path.read_bytes()).decode('ascii')}"},
                },
            ]
        )
    if parts:
        context.add_message("user", parts, friday_internal=True)


def _suspend_for_approval(payload: Any):
    state = dict(payload or {})
    # The run ends without an answer; the pending-approval file carries the
    # command, and the harness resumes with a continuation turn after a decision.
    state["answer"] = ""
    return "halt", state


def _approval_required(context: RunContext) -> dict[str, Any] | None:
    guard = context.metadata.setdefault(GUARD_STATE, {"event_index": 0, "seen": {}})
    start = int(guard.get("event_index", 0))
    for event in reversed(context.events[start:]):
        if event.type != "tool.result":
            continue
        content = event.data.get("content")
        try:
            value = json.loads(content) if isinstance(content, str) else content
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and value.get("approval_required"):
            return value
    return None


def _no_progress(context: RunContext) -> str | None:
    guard = context.metadata.setdefault(GUARD_STATE, {"event_index": 0, "seen": {}})
    start = int(guard.get("event_index", 0))
    guard["event_index"] = len(context.events)
    rows = []
    for event in context.events[start:]:
        if event.type == "tool.call":
            rows.append({"type": event.type, "name": event.data.get("name"), "arguments": event.data.get("arguments")})
        elif event.type == "tool.result":
            rows.append({"type": event.type, "content": event.data.get("content"), "is_error": event.data.get("is_error")})
    if not rows:
        return None
    signature = hashlib.sha256(json.dumps(rows, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")).hexdigest()
    seen = guard.setdefault("seen", {})
    seen[signature] = int(seen.get(signature, 0)) + 1
    return "no_progress" if seen[signature] >= 2 else None


def _context_window(context: RunContext) -> str | None:
    """Make room and keep running; the window is the only thing that bounds a run.

    Tool results are probed first because reclaiming them is lossless -- the full
    output stays on disk and nothing a user wrote is touched. That pass only runs
    when it is worth the damage, which is what ``should_compact_tools`` measures:
    a few percent would leave the window nearly as full and the tool detail gone
    for nothing. Otherwise the conversation itself is rewritten in place, which
    keeps the agent the flow is executing untouched.

    Stopping is the last resort, for a window that neither pass can bring back
    under the trigger. Returning while still above it would compact again on the
    next pass and spend a model call each time for nothing.
    """
    if context_ratio(context) < TOOL_COMPACT_AT:
        return None
    if should_compact_tools(context):
        before = token_estimate(context)
        count = compact_tool_results(context)
        announce_compaction(
            context,
            CompactionRecord(
                kind="tool_results",
                before_tokens=before,
                after_tokens=token_estimate(context),
                window=context_window(context),
                tool_results=count,
            ),
        )
        if context_ratio(context) < TOOL_COMPACT_AT:
            return None
    announce_compaction(context, compact_in_place(context))
    return "context_window" if context_ratio(context) >= TOOL_COMPACT_AT else None


def _finalize_message(reason: str) -> str:
    if reason == "no_progress":
        return "Loop guard: the same tool cycle produced the same result again. Do not call more tools. Return the best supported answer, state unresolved items, and stop."
    return "Loop guard: the context window is full and compaction could not free enough of it. Do not call more tools. Return the best supported answer, state unresolved items, and stop."
