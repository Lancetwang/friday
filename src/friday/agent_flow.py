from __future__ import annotations

import base64
import json
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from agent_core import CallableNode, Flow, ModelNode, RunContext, Tool, ToolCallNode, ToolExecutor, ToolResult, ToolRouterNode, get_current_context
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
from friday.tool_hooks import (
    GUARD_STOP_REASON,
    NO_PROGRESS_STATE,
    NoProgressHook,
    PendingApprovalHook,
    ShellPermissionHook,
    PostToolDecision,
    PostToolHook,
    PostToolHookNode,
    PreToolHook,
    PreToolHookNode,
    ToolBatch,
    inherit_no_progress,
    reset_no_progress,
)
from friday.tools import IMAGE_MIME_TYPES, MAX_IMAGE_BYTES, SHELL_PERMISSION_PREFLIGHT

RUN_USAGE_BASELINE = "friday.run_usage_baseline"


def build_guarded_flow(
    model: ChatModel,
    tools: Sequence[Tool],
    *,
    chat_kwargs: Mapping[str, Any],
    pre_tool_hooks: Sequence[PreToolHook] = (),
    post_tool_hooks: Sequence[PostToolHook] = (),
) -> Flow:
    executor = ToolExecutor(tools)
    model_node = ModelNode(model=model, tools=tools, action="observe", chat_kwargs=chat_kwargs)
    router_node = ToolRouterNode(tool_action="tool_call", done_action="final")
    pre_tool_node = PreToolHookNode(executor, [ShellPermissionHook(), *pre_tool_hooks])
    tool_node = ToolCallNode(executor=executor, next_action="post_tool")
    post_tool_node = PostToolHookNode(
        executor,
        [PendingApprovalHook(), _AttachToolImagesHook(), NoProgressHook(), *post_tool_hooks],
    )
    guard_node = CallableNode(_guard_context)
    suspend_node = CallableNode(_suspend_for_approval)

    model_node - "observe" >> router_node
    router_node - "tool_call" >> pre_tool_node
    pre_tool_node - "execute" >> tool_node
    pre_tool_node - "observed" >> post_tool_node
    pre_tool_node - "suspend" >> suspend_node
    tool_node - "post_tool" >> post_tool_node
    post_tool_node - "guard" >> guard_node
    post_tool_node - "chat" >> model_node
    post_tool_node - "suspend" >> suspend_node
    guard_node - "chat" >> model_node
    # Terminal edges: an action with no successor ends an agent-core flow. The
    # router's "final" answer exits that way, and the suspend node makes the
    # approval exit an explicit part of the graph instead of an unwired action.
    return Flow(model_node)


def begin_guarded_run(context: RunContext, usage_start: Any, *, continuation: bool = False) -> None:
    context.metadata[RUN_USAGE_BASELINE] = {
        "requests": int(getattr(usage_start, "requests", 0)),
        "usage_requests": int(getattr(usage_start, "usage_requests", 0)),
        "input_tokens": int(getattr(usage_start, "input_tokens", 0)),
        "output_tokens": int(getattr(usage_start, "output_tokens", 0)),
    }
    if not continuation or not isinstance(context.metadata.get(NO_PROGRESS_STATE), dict):
        reset_no_progress(context)
    context.metadata.pop(SHELL_PERMISSION_PREFLIGHT, None)
    context.metadata.pop(GUARD_STOP_REASON, None)


def inherit_guarded_run(target: RunContext, source: RunContext, *, preserve_loop_state: bool = False) -> None:
    baseline = source.metadata.get(RUN_USAGE_BASELINE)
    if isinstance(baseline, dict):
        target.metadata[RUN_USAGE_BASELINE] = dict(baseline)
    config = source.metadata.get("friday.model_config")
    if isinstance(config, dict):
        target.metadata["friday.model_config"] = dict(config)
    if isinstance(source.metadata.get("friday.thinking_effort"), str):
        target.metadata["friday.thinking_effort"] = source.metadata["friday.thinking_effort"]
    if preserve_loop_state:
        inherit_no_progress(target, source)
    else:
        reset_no_progress(target)
    target.metadata.pop(SHELL_PERMISSION_PREFLIGHT, None)
    target.metadata.pop(GUARD_STOP_REASON, None)


def _guard_context(payload: Any):
    state = dict(payload or {})
    context = get_current_context()
    if context is None:
        return "chat", state

    # A run is not bounded by how long it takes or what it costs: it ends when
    # the work is done, when it stops making progress, or when the window can no
    # longer be made to fit. Compaction is what keeps the last one rare.
    reason = _context_window(context)
    if reason:
        context.metadata[GUARD_STOP_REASON] = reason
        context.emit("loop.guard", category="flow", action="finalize", data={"reason": reason})
        context.add_message("system", _context_window_message())
        state["chat_kwargs"] = {**dict(state.get("chat_kwargs", {}) or {}), "tool_choice": "none"}
    return "chat", state


class _AttachToolImagesHook:
    name = "tool-images"
    priority = 150

    def after_tool_batch(
        self,
        context: RunContext,
        _batch: ToolBatch,
        results: Sequence[ToolResult],
    ) -> PostToolDecision:
        _attach_tool_images(context, results)
        return PostToolDecision()


def _attach_tool_images(context: RunContext, results: Sequence[ToolResult]) -> None:
    parts: list[dict[str, Any]] = []
    workspace = Path(str(context.metadata.get("workspace") or ".")).resolve()
    for result in results[:4]:
        try:
            value = json.loads(result.content)
        except (AttributeError, json.JSONDecodeError):
            continue
        if not isinstance(value, dict) or value.get("image") is not True:
            continue
        path = Path(str(value.get("path") or "")).resolve()
        mime_type = IMAGE_MIME_TYPES.get(path.suffix.lower())
        if not mime_type or not path.is_file():
            continue
        if path.stat().st_size > MAX_IMAGE_BYTES:
            continue
        try:
            label = path.relative_to(workspace).as_posix()
        except ValueError:
            label = str(path)
        parts.extend(
            [
                {"type": "text", "text": f"Image loaded from {label} for visual inspection."},
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


def _context_window_message() -> str:
    return "Loop guard: the context window is full and compaction could not free enough of it. Do not call more tools. Return the best supported answer, state unresolved items, and stop."
