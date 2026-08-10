from __future__ import annotations

import json
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from agent_core import Agent, RunContext, get_current_context

from friday.agent_flow import begin_guarded_run
from friday.app import prepare_context_for_chat
from friday.checkpoint import begin_checkpoint, checkpoint_artifacts, discard_checkpoint, finish_checkpoint
from friday.compaction import LAST_COMPACTION, announce_compaction, compaction_record
from friday.context import context_window, observe_context_usage, token_estimate, token_measurement
from friday.loop import AGENT_MAX_STEPS, run_loop
from friday.memory import capture_user_memory, relevant_memory
from friday.prompts import goal_attempt_prompt
from friday.progress import append_progress_checkpoint, begin_progress, current_progress, finish_progress
from friday.state import USER_MESSAGE_TIMES_KEY, archived_messages, save_turn
from friday.tools import build_tools, pending_approval
from friday.trace import begin_live_trace, finish_live_trace, record_context_transition, write_live_event, write_trace

PENDING_TURN_ID = "friday.pending_turn_id"
PENDING_TURN_METRICS = "friday.pending_turn_metrics"


@dataclass
class TurnResult:
    agent: Agent
    context: RunContext
    answer: str
    verifications: list[dict[str, Any]]
    metrics: dict[str, Any]
    progress: dict[str, Any]
    artifacts: list[dict[str, Any]] = field(default_factory=list)
    context_notice: str = ""


class TurnCancelled(RuntimeError):
    pass


@dataclass
class _ActivityRecorder:
    """Small persisted view of model thinking and tool execution."""

    items: list[dict[str, Any]] = field(default_factory=list)
    requests: dict[tuple[str, int | None], float] = field(default_factory=dict)
    reasoning: dict[tuple[str, int | None], float] = field(default_factory=dict)

    def observe(self, event: Any) -> None:
        key = (str(getattr(event, "run_id", "") or ""), getattr(event, "step", None))
        timestamp = float(getattr(event, "timestamp", time.time()))
        data = event.data if isinstance(getattr(event, "data", None), Mapping) else {}
        if event.type == "model.request.payload":
            self.requests[key] = timestamp
        elif event.type == "model.reasoning.delta":
            self.reasoning.setdefault(key, timestamp)
        elif event.type == "model.response.payload":
            message = data.get("message")
            content = message.get("reasoning_content") if isinstance(message, Mapping) else None
            if content:
                started = self.reasoning.pop(key, self.requests.get(key, timestamp))
                self.items.append(
                    {
                        "kind": "reasoning",
                        "text": str(content),
                        "elapsed_ms": max(0, round((timestamp - started) * 1000)),
                    }
                )
            self.requests.pop(key, None)
        elif event.type == "tool.result":
            elapsed = data.get("elapsed_ms")
            item: dict[str, Any] = {
                "kind": "tool",
                "tool_call_id": str(data.get("tool_call_id") or ""),
                "status": "error" if data.get("is_error") else "done",
            }
            if isinstance(elapsed, (int, float)):
                item["elapsed_ms"] = max(0, round(elapsed))
            self.items.append(item)


def run_turn(
    agent: Agent,
    context: RunContext,
    text: str,
    *,
    goal: bool = False,
    stream: bool = True,
    on_delta: Callable[[str], None] | None = None,
    on_verify: Callable[[dict[str, Any]], None] | None = None,
    on_progress: Callable[[dict[str, Any]], None] | None = None,
    on_context_notice: Callable[[dict[str, Any]], None] | None = None,
    approval_result: dict[str, Any] | None = None,
    user_label: str | None = None,
    continuation: bool = False,
    images: Sequence[str] = (),
    attachments: Sequence[Mapping[str, Any]] = (),
) -> TurnResult:
    event_handler = context.on_event
    observation_handler = context.on_observation
    usage_start = context.usage.snapshot()
    workspace = Path(context.metadata["workspace"])
    user = user_label or (f"/goal {text}" if goal else text)
    request = _with_local_attachments(text, attachments)
    mode = "goal" if goal else "chat"
    continued_turn_id = str(context.metadata.get(PENDING_TURN_ID) or "") if continuation else ""
    session_id = str(context.metadata.get("session_id") or "")
    live_path, turn_id = begin_live_trace(
        workspace,
        context=context,
        mode=mode,
        user=user,
        prompt_messages=[dict(message) for message in context.get_messages()],
        turn_id=continued_turn_id or None,
        continuation=continuation,
    )
    try:
        checkpoint_id = begin_checkpoint(
            workspace,
            session_id=session_id,
            turn_id=turn_id,
            user=user,
            progress=current_progress(context),
            continuation=continuation,
        )
    except BaseException:
        finish_live_trace(live_path, turn_id, status="error")
        raise

    # Kept beside the turn rather than on the context because a mid-run
    # compaction swaps the context out, and cost has to keep accruing across it.
    cost = {"cached_tokens": 0}
    activity = _ActivityRecorder()

    def on_observation(event: Any) -> None:
        activity.observe(event)
        observe_context_usage(get_current_context() or context, event.type, event.data)
        if event.type == "model.request.payload":
            config = context.metadata.get("friday.model_config")
            if isinstance(config, dict):
                event.data["model"] = dict(config)
        if event.type == "model.response.payload":
            cost["cached_tokens"] += _cached_tokens(event.data)
        write_live_event(live_path, turn_id, event)
        if observation_handler is not None:
            observation_handler(event)

    def on_event(event: Any) -> None:
        if event.type == "progress.updated" and on_progress:
            on_progress(dict(event.data))
        if event_handler is not None:
            event_handler(event)

    context.on_observation = on_observation
    context.on_event = on_event
    try:
        agent, context, notice = prepare_context_for_chat(agent, context, stream=stream)
        context.on_event = on_event
        context.on_observation = on_observation
        if not continuation or not context.metadata.get("friday.user_request"):
            context.metadata["friday.user_request"] = text
        record_context_transition(live_path, turn_id, notice, context.get_messages())
        if notice:
            announce_compaction(context, compaction_record(context.metadata.get(LAST_COMPACTION)), on_context_notice)
        begin_guarded_run(context, usage_start, continuation=continuation)
        if approval_result is not None:
            tool_call_id = _replace_pending_tool_result(context, approval_result)
            context.observe(
                "tool.result",
                category="tool",
                data={
                    "tool_call_id": tool_call_id,
                    "content": json.dumps(approval_result, ensure_ascii=False),
                    "is_error": False,
                },
            )
            context.emit(
                "approval.resolved",
                category="approval",
                data={
                    "decision": "approve" if approval_result.get("approved") else "reject",
                    "continued": True,
                },
            )

        start_event = len(context.events)
        progress = begin_progress(
            context,
            text,
            mode="goal" if goal else "normal",
            continuation=continuation,
        )
        if goal or continuation:
            append_progress_checkpoint(context)
        recalled = "" if continuation else relevant_memory(workspace, text)
        if recalled:
            context.add_message("system", recalled, friday_memory_recall=True)
        if user_label is None and not continuation:
            capture_user_memory(
                workspace,
                text,
                session_id=str(context.metadata.get("session_id") or ""),
            )
        user_message_times = context.metadata.setdefault(USER_MESSAGE_TIMES_KEY, [])
        if not isinstance(user_message_times, list):
            user_message_times = []
            context.metadata[USER_MESSAGE_TIMES_KEY] = user_message_times
        if not continuation:
            recorded_text = goal_attempt_prompt(request) if goal else request
            user_message_times.append(
                {
                    "attachments": [dict(item) for item in attachments],
                    "display_text": text,
                    "goal": goal,
                    "text": recorded_text,
                    "time": datetime.now().astimezone().isoformat(timespec="seconds"),
                }
            )
        prompt_messages = [dict(message) for message in context.get_messages()]
        tools = build_tools(workspace)
        input_estimate = token_estimate(context, tools) + _tokens(request)
        start = time.perf_counter()
        loop_result = run_loop(
            agent,
            context,
            request,
            force_verify=goal,
            max_attempts=None,
            max_steps=AGENT_MAX_STEPS,
            stream=stream,
            compact_between_attempts=True,
            resume=continuation,
            images=images,
            on_delta=on_delta,
            on_verify=on_verify,
        )
        answer, verifications = loop_result.answer, loop_result.verifications
        if loop_result.context is not None and loop_result.context is not context:
            # The loop compacted mid-run and rebuilt the pair; continue with it.
            agent, context = loop_result.agent, loop_result.context
            start_event = 0
        progress = finish_progress(
            context,
            str(context.metadata.get("friday.loop_status") or "done"),
            verifications,
        )
    except BaseException as exc:
        cancelled = isinstance(exc, TurnCancelled)
        finish_live_trace(live_path, turn_id, status="cancelled" if cancelled else "error")
        try:
            if cancelled:
                discard_checkpoint(workspace, checkpoint_id)
            else:
                finish_checkpoint(
                    workspace,
                    checkpoint_id,
                    pending=bool(pending_approval(workspace, session_id=session_id).get("pending")),
                )
        except Exception as checkpoint_error:
            exc.add_note(f"Friday could not finalize the recovery checkpoint: {checkpoint_error}")
        context.events.clear()
        raise
    finally:
        context.on_event = event_handler
        context.on_observation = observation_handler
    turn_usage = context.usage.since(usage_start).to_dict()
    estimated = turn_usage["input_tokens"] is None or turn_usage["output_tokens"] is None
    window_usage = token_measurement(context, tools)
    metrics = {
        "elapsed_ms": int((time.perf_counter() - start) * 1000),
        "requests": turn_usage["requests"],
        "estimated_tokens": estimated,
        # Cumulative over every request in the turn: what the turn cost.
        "input_tokens": turn_usage["input_tokens"] if not estimated else input_estimate,
        "output_tokens": turn_usage["output_tokens"] if not estimated else _tokens(answer),
        "cached_tokens": cost["cached_tokens"],
        # How full the window is now: what the next request has to carry.
        "window": context_window(context),
        "window_tokens": window_usage["tokens"],
        "window_provider_tokens": window_usage["provider_tokens"],
        "window_delta_tokens": window_usage["delta_tokens"],
        "window_token_source": window_usage["source"],
    }
    if continuation and isinstance(context.metadata.get(PENDING_TURN_METRICS), dict):
        previous_metrics = context.metadata[PENDING_TURN_METRICS]
        metrics = {
            "elapsed_ms": int(previous_metrics.get("elapsed_ms", 0)) + metrics["elapsed_ms"],
            "requests": int(previous_metrics.get("requests", 0)) + metrics["requests"],
            "estimated_tokens": bool(previous_metrics.get("estimated_tokens")) or metrics["estimated_tokens"],
            "input_tokens": int(previous_metrics.get("input_tokens", 0)) + metrics["input_tokens"],
            "output_tokens": int(previous_metrics.get("output_tokens", 0)) + metrics["output_tokens"],
            "cached_tokens": int(previous_metrics.get("cached_tokens", 0)) + metrics["cached_tokens"],
            # Occupancy is a level, not a total: the resumed reading replaces the
            # one taken before the approval pause instead of adding to it.
            "window": metrics["window"],
            "window_tokens": metrics["window_tokens"],
            "window_provider_tokens": metrics["window_provider_tokens"],
            "window_delta_tokens": metrics["window_delta_tokens"],
            "window_token_source": metrics["window_token_source"],
        }
    loop_status = str(context.metadata.get("friday.loop_status") or "done")
    if loop_status == "needs_approval":
        context.metadata[PENDING_TURN_ID] = turn_id
        context.metadata[PENDING_TURN_METRICS] = dict(metrics)
    else:
        context.metadata.pop(PENDING_TURN_ID, None)
        context.metadata.pop(PENDING_TURN_METRICS, None)
    context.metadata["friday.last_usage"] = metrics
    try:
        checkpoint = finish_checkpoint(
            workspace,
            checkpoint_id,
            pending=bool(pending_approval(workspace, session_id=session_id).get("pending")),
        )
        artifacts = checkpoint_artifacts(workspace, checkpoint)
        write_trace(
            workspace,
            mode=mode,
            user=user,
            assistant=answer,
            context=context,
            start_event=start_event,
            prompt_messages=prompt_messages,
            metrics=metrics,
            verifications=verifications,
            context_notice=notice,
            turn_id=turn_id,
            continuation=continuation,
        )
        save_turn(
            workspace,
            user,
            answer,
            str(context.metadata.get("session_id") or ""),
            context.get_messages(),
            progress,
            last_usage=metrics,
            user_message_times=context.metadata.get(USER_MESSAGE_TIMES_KEY),
            thinking_effort=str(context.metadata.get("friday.thinking_effort") or "high"),
            artifacts=artifacts,
            archived=archived_messages(context),
            metrics=metrics,
            activities=activity.items,
            continuation=continuation,
        )
        finish_live_trace(
            live_path,
            turn_id,
            status=str(context.metadata.get("friday.loop_status") or "done"),
            metrics=metrics,
        )
    finally:
        context.events.clear()
    return TurnResult(agent, context, answer, verifications, metrics, progress, artifacts, notice)


def _tokens(text: str) -> int:
    return max(1, (len(text) + 3) // 4)


def _with_local_attachments(text: str, attachments: Sequence[Mapping[str, Any]]) -> str:
    if not attachments:
        return text
    lines = ["Attached local items (inspect with available tools when relevant):"]
    for item in attachments:
        kind = "folder" if item.get("kind") == "folder" else "file"
        lines.append(f"- {kind}: {json.dumps(str(item.get('path') or ''), ensure_ascii=False)}")
    return f"{text}\n\n" + "\n".join(lines)


def _cached_tokens(data: Any) -> int:
    """Prompt tokens the provider served from its cache on one response.

    Reported so the turn's cost reads honestly: a re-sent conversation is mostly
    cache hits, which bill at a fraction of fresh input.
    """
    message = data.get("message") if isinstance(data, dict) else None
    usage = message.get("usage") if isinstance(message, dict) else None
    if not isinstance(usage, dict):
        return 0
    value = usage.get("prompt_cache_hit_tokens")
    if not isinstance(value, int) or isinstance(value, bool):
        details = usage.get("prompt_tokens_details")
        value = details.get("cached_tokens") if isinstance(details, dict) else None
    if not isinstance(value, int) or isinstance(value, bool):
        return 0
    return max(0, value)


def _replace_pending_tool_result(context: RunContext, approval_result: dict[str, Any]) -> str:
    guidance = str(approval_result.get("instruction") or "").strip()
    tool_result = {key: value for key, value in approval_result.items() if key != "instruction"}
    approval = approval_result.get("approval")
    approval_id = str(approval.get("id") or "") if isinstance(approval, dict) else ""
    for message in reversed(context.get_messages()):
        if message.get("role") != "tool":
            continue
        try:
            value = json.loads(str(message.get("content") or ""))
        except json.JSONDecodeError:
            continue
        if not isinstance(value, dict) or not value.get("approval_required"):
            continue
        if approval_id and str(value.get("id") or "") != approval_id:
            continue
        message["content"] = json.dumps(tool_result, ensure_ascii=False)
        if guidance:
            context.add_message("user", guidance, friday_internal=True, friday_human_guidance=True)
        return str(message.get("tool_call_id") or "")
    context.add_message("system", "## Approval Result\n" + json.dumps(tool_result, ensure_ascii=False, indent=2))
    if guidance:
        context.add_message("user", guidance, friday_internal=True, friday_human_guidance=True)
    return ""
