from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from agent_core import Agent, RunContext

from friday.agent_flow import begin_guarded_run
from friday.app import prepare_context_for_chat, save_turn
from friday.context import token_estimate
from friday.loop import AGENT_MAX_STEPS, goal_chat, verified_chat
from friday.tools import build_tools
from friday.trace import begin_live_trace, finish_live_trace, write_live_event, write_trace


@dataclass
class TurnResult:
    agent: Agent
    context: RunContext
    answer: str
    verifications: list[dict[str, Any]]
    metrics: dict[str, Any]
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
    on_context_notice: Callable[[str], None] | None = None,
    approval_result: dict[str, Any] | None = None,
    user_label: str | None = None,
) -> TurnResult:
    event_handler = context.on_event
    usage_start = context.usage.snapshot()
    agent, context, notice = prepare_context_for_chat(agent, context, stream=stream)
    if context.on_event is None:
        context.on_event = event_handler
    begin_guarded_run(context, usage_start)
    if notice and on_context_notice:
        on_context_notice(notice)
    if approval_result is not None:
        context.add_message("system", "## Approval Result\n" + json.dumps(approval_result, ensure_ascii=False, indent=2))

    start_event = len(context.events)
    prompt_messages = [dict(message) for message in context.get_messages()]
    workspace = Path(context.metadata["workspace"])
    user = user_label or (f"/goal {text}" if goal else text)
    mode = "approve" if user_label == "/approve" else "goal" if goal else "chat"
    live_path, turn_id = begin_live_trace(
        workspace,
        context=context,
        mode=mode,
        user=user,
        prompt_messages=prompt_messages,
    )

    def on_event(event: Any) -> None:
        write_live_event(live_path, turn_id, event)
        if event_handler is not None:
            event_handler(event)

    context.on_event = on_event
    input_estimate = token_estimate(context, build_tools(workspace, workspace / ".friday")) + _tokens(text)
    start = time.perf_counter()
    chat = goal_chat if goal else verified_chat
    try:
        answer, verifications = chat(
            agent,
            context,
            text,
            max_steps=AGENT_MAX_STEPS,
            on_delta=on_delta,
            on_verify=on_verify,
        )
    except BaseException:
        finish_live_trace(live_path, turn_id, status="error")
        raise
    finally:
        context.on_event = event_handler
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
    finish_live_trace(live_path, turn_id, status="done", metrics=metrics)

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
    save_turn(
        workspace,
        user,
        answer,
        [event.to_dict() for event in context.events[-20:]],
        str(context.metadata.get("session_id") or ""),
        context.get_messages(),
    )
    return TurnResult(agent, context, answer, verifications, metrics, notice)


def _tokens(text: str) -> int:
    return max(1, (len(text) + 3) // 4)
