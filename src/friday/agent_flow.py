from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from typing import Any

from agent_core import CallableNode, Flow, ModelNode, RunContext, Tool, ToolCallNode, ToolExecutor, ToolRouterNode, get_current_context
from agent_core.llm import ChatModel

from friday.config import DEFAULT_MODEL_CONFIG
from friday.context import TOOL_COMPACT_AT, compact_tool_results, context_ratio

GUARD_STATE = "friday.loop_guard"
GUARD_STOP_REASON = "friday.guard_stop_reason"
RUN_USAGE_BASELINE = "friday.run_usage_baseline"
TOKEN_BUDGET_SOFT_LIMIT = 0.85
CONTEXT_WINDOW_HARD_LIMIT = 0.95


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
    target.metadata[GUARD_STATE] = {"event_index": len(target.events), "seen": {}}
    target.metadata.pop(GUARD_STOP_REASON, None)


def _guard_after_tools(payload: Any):
    state = dict(payload or {})
    context = get_current_context()
    if context is None:
        return "chat", state

    approval = _approval_required(context)
    if approval:
        context.emit("approval.pending", category="tool", action="suspend", data=approval)
        return "suspend", state

    reason = _no_progress(context) or _token_budget(context) or _context_window(context)
    if reason:
        context.metadata[GUARD_STOP_REASON] = reason
        context.emit("loop.guard", category="flow", action="finalize", data={"reason": reason})
        context.add_message("system", _finalize_message(reason))
        state["chat_kwargs"] = {**dict(state.get("chat_kwargs", {}) or {}), "tool_choice": "none"}
    return "chat", state


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


def _token_budget(context: RunContext) -> str | None:
    baseline = context.metadata.get(RUN_USAGE_BASELINE)
    if not isinstance(baseline, dict):
        return None
    requests = context.usage.requests - int(baseline.get("requests", 0))
    usage_requests = context.usage.usage_requests - int(baseline.get("usage_requests", 0))
    if requests != usage_requests:
        return None
    used = (
        context.usage.input_tokens
        - int(baseline.get("input_tokens", 0))
        + context.usage.output_tokens
        - int(baseline.get("output_tokens", 0))
    )
    config = context.metadata.get("friday.model_config", {})
    budget = config.get("run_token_budget") if isinstance(config, dict) else None
    budget = budget if isinstance(budget, int) and budget > 0 else DEFAULT_MODEL_CONFIG.run_token_budget
    return "token_budget" if used >= int(budget * TOKEN_BUDGET_SOFT_LIMIT) else None


def _context_window(context: RunContext) -> str | None:
    """Mid-run context pressure relief.

    First reclaim tool results losslessly (full outputs stay on disk); only if
    the window is still nearly full force a final answer. Conversation-level
    compaction needs an agent rebuild and happens between attempts and turns.
    """
    if context_ratio(context) < TOOL_COMPACT_AT:
        return None
    count = compact_tool_results(context)
    if count:
        context.emit("context.compacted", category="context", action="tool_results", data={"count": count})
    return "context_window" if context_ratio(context) >= CONTEXT_WINDOW_HARD_LIMIT else None


def _finalize_message(reason: str) -> str:
    if reason == "no_progress":
        return "Loop guard: the same tool cycle produced the same result again. Do not call more tools. Return the best supported answer, state unresolved items, and stop."
    if reason == "context_window":
        return "Loop guard: the context window is nearly full. Do not call more tools. Return the best supported answer, state unresolved items, and stop."
    return "Loop guard: the run reached its Token Budget reserve. Do not call more tools. Return the best supported answer, state unresolved items, and stop."
