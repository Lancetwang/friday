from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from agent_core import Agent, RunContext

from friday.agent_flow import begin_guarded_run
from friday.app import prepare_context_for_chat, save_turn
from friday.checkpoint import begin_checkpoint, finish_checkpoint
from friday.context import token_estimate
from friday.loop import AGENT_MAX_STEPS, goal_chat, verified_chat
from friday.memory import capture_user_memory, relevant_memory
from friday.progress import append_progress_checkpoint, begin_progress, current_progress, finish_progress
from friday.tools import build_tools, pending_approval
from friday.trace import begin_live_trace, finish_live_trace, record_context_transition, write_live_event, write_trace


@dataclass
class TurnResult:
    agent: Agent
    context: RunContext
    answer: str
    verifications: list[dict[str, Any]]
    metrics: dict[str, Any]
    progress: dict[str, Any]
    context_notice: str = ""


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
    on_context_notice: Callable[[str], None] | None = None,
    approval_result: dict[str, Any] | None = None,
    user_label: str | None = None,
    continuation: bool = False,
) -> TurnResult:
    event_handler = context.on_event
    observation_handler = context.on_observation
    usage_start = context.usage.snapshot()
    workspace = Path(context.metadata["workspace"])
    user = user_label or (f"/goal {text}" if goal else text)
    mode = "approve" if user_label == "/approve" else "goal" if goal else "chat"
    live_path, turn_id = begin_live_trace(
        workspace,
        context=context,
        mode=mode,
        user=user,
        prompt_messages=[dict(message) for message in context.get_messages()],
    )
    try:
        checkpoint_id = begin_checkpoint(
            workspace,
            session_id=str(context.metadata.get("session_id") or ""),
            turn_id=turn_id,
            user=user,
            progress=current_progress(context),
            continuation=continuation,
        )
    except BaseException:
        finish_live_trace(live_path, turn_id, status="error")
        raise

    def on_observation(event: Any) -> None:
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
        record_context_transition(live_path, turn_id, notice, context.get_messages())
        begin_guarded_run(context, usage_start)
        if notice and on_context_notice:
            on_context_notice(notice)
        if approval_result is not None:
            context.add_message("system", "## Approval Result\n" + json.dumps(approval_result, ensure_ascii=False, indent=2))

        start_event = len(context.events)
        progress = begin_progress(
            context,
            text,
            mode="goal" if goal else "normal",
            continuation=continuation,
        )
        append_progress_checkpoint(context)
        if on_progress:
            on_progress(progress)
        recalled = relevant_memory(workspace, text)
        if recalled:
            context.add_message("system", recalled, friday_memory_recall=True)
        if user_label is None:
            capture_user_memory(
                workspace,
                text,
                session_id=str(context.metadata.get("session_id") or ""),
            )
        prompt_messages = [dict(message) for message in context.get_messages()]
        input_estimate = token_estimate(context, build_tools(workspace, workspace / ".friday")) + _tokens(text)
        start = time.perf_counter()
        chat = goal_chat if goal else verified_chat
        answer, verifications = chat(
            agent,
            context,
            text,
            max_steps=AGENT_MAX_STEPS,
            on_delta=on_delta,
            on_verify=on_verify,
        )
        progress = finish_progress(
            context,
            str(context.metadata.get("friday.loop_status") or "done"),
            verifications,
        )
    except BaseException as exc:
        finish_live_trace(live_path, turn_id, status="error")
        try:
            finish_checkpoint(workspace, checkpoint_id, pending=bool(pending_approval(workspace).get("pending")))
        except Exception as checkpoint_error:
            exc.add_note(f"Friday could not finalize the recovery checkpoint: {checkpoint_error}")
        raise
    finally:
        context.on_event = event_handler
        context.on_observation = observation_handler
    turn_usage = context.usage.since(usage_start).to_dict()
    estimated = turn_usage["input_tokens"] is None or turn_usage["output_tokens"] is None
    metrics = {
        "elapsed_ms": int((time.perf_counter() - start) * 1000),
        "requests": turn_usage["requests"],
        "estimated_tokens": estimated,
        "input_tokens": turn_usage["input_tokens"] if not estimated else input_estimate,
        "output_tokens": turn_usage["output_tokens"] if not estimated else _tokens(answer),
    }
    context.metadata["friday.last_usage"] = metrics
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
    )
    finish_live_trace(live_path, turn_id, status="done", metrics=metrics)
    save_turn(
        workspace,
        user,
        answer,
        [event.to_dict() for event in context.events[-20:]],
        str(context.metadata.get("session_id") or ""),
        context.get_messages(),
        progress,
        last_usage=metrics,
    )
    finish_checkpoint(workspace, checkpoint_id, pending=bool(pending_approval(workspace).get("pending")))
    return TurnResult(agent, context, answer, verifications, metrics, progress, notice)


def _tokens(text: str) -> int:
    return max(1, (len(text) + 3) // 4)
