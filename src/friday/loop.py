from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any, Callable, Literal

from agent_core import Agent, CallableNode, Flow, RunContext

from friday.agent_flow import GUARD_STOP_REASON, inherit_guarded_run
from friday.config import DEFAULT_MODEL_CONFIG
from friday.prompts import goal_attempt_prompt, retry_prompt
from friday.verification import record_verification, verify_friday

AGENT_MAX_STEPS = 10000
FLOW_MAX_STEPS = 10000
TOKEN_BUDGET_SOFT_LIMIT = 0.85
GUARD_STOP_REASONS = {"no_progress", "token_budget", "context_window"}

LoopStatus = Literal[
    "done",
    "needs_approval",
    "blocked",
    "inconclusive",
    "no_progress",
    "token_budget",
    "context_window",
    "error",
    "max_attempts",
]


@dataclass
class LoopResult:
    answer: str = ""
    status: LoopStatus = "done"
    verifications: list[dict[str, Any]] = field(default_factory=list)
    # The loop may compact between attempts, which rebuilds the pair; callers
    # must continue with the returned agent and context.
    agent: Agent | None = None
    context: RunContext | None = None


def verified_chat(
    agent: Agent,
    context: RunContext,
    text: str,
    *,
    max_steps: int = AGENT_MAX_STEPS,
    on_delta: Any = None,
    on_verify: Callable[[dict[str, Any]], None] | None = None,
    repairs: int | None = None,
) -> tuple[str, list[dict[str, Any]]]:
    result = run_loop(
        agent,
        context,
        text,
        force_verify=False,
        max_attempts=None if repairs is None else repairs + 1,
        max_steps=max_steps,
        on_delta=on_delta,
        on_verify=on_verify,
    )
    return result.answer, result.verifications


def goal_chat(
    agent: Agent,
    context: RunContext,
    goal: str,
    *,
    max_attempts: int | None = None,
    max_steps: int = AGENT_MAX_STEPS,
    on_delta: Any = None,
    on_verify: Callable[[dict[str, Any]], None] | None = None,
) -> tuple[str, list[dict[str, Any]]]:
    result = run_loop(
        agent,
        context,
        goal,
        force_verify=True,
        max_attempts=max_attempts,
        max_steps=max_steps,
        on_delta=on_delta,
        on_verify=on_verify,
    )
    return result.answer, result.verifications


def run_loop(
    agent: Agent,
    context: RunContext,
    goal: str,
    *,
    force_verify: bool,
    max_attempts: int | None,
    max_steps: int,
    stream: bool = True,
    compact_between_attempts: bool = False,
    on_delta: Any = None,
    on_verify: Callable[[dict[str, Any]], None] | None = None,
) -> LoopResult:
    state: dict[str, Any] = {
        "agent": agent,
        "answer": "",
        "attempt": 0,
        "compact_between_attempts": compact_between_attempts,
        "context": context,
        "feedback": "",
        "force_verify": force_verify,
        "goal": goal,
        "last_attempt_signature": None,
        "last_repair_signature": None,
        "max_attempts": max_attempts,
        "max_steps": max_steps,
        "on_delta": on_delta,
        "on_verify": on_verify,
        "start_event": len(context.events),
        "status": "done",
        "stream": stream,
        "token_budget": _token_budget(context),
        "usage_start": _usage_snapshot(context),
        "verifications": [],
    }
    result = _loop_flow().run(state, max_steps=FLOW_MAX_STEPS).payload["result"]
    result.context.metadata["friday.loop_status"] = result.status
    return result


def _loop_flow() -> Flow:
    attempt = CallableNode(_attempt)
    verify = CallableNode(_verify)
    finish = CallableNode(lambda state: ("default", {"result": _to_result(state)}))
    attempt - "verify" >> verify
    verify - "retry" >> attempt
    verify - "finish" >> finish
    return Flow(attempt)


def _attempt(state: dict[str, Any]):
    state["attempt"] += 1
    if state["attempt"] > 1 and state.get("compact_between_attempts"):
        _refresh_context(state)
    if state["attempt"] == 1:
        prompt = goal_attempt_prompt(state["goal"]) if state["force_verify"] else state["goal"]
    else:
        prompt = retry_prompt(state["goal"], state["attempt"] - 1, state["feedback"])
    event_start = len(state["context"].events)
    state["answer"] = state["agent"].chat(
        prompt,
        context=state["context"],
        max_steps=state["max_steps"],
        on_delta=state["on_delta"],
    )
    state["attempt_signature"] = _event_signature(state["context"].events[event_start:])
    return "verify", state


def _refresh_context(state: dict[str, Any]) -> None:
    """Between repair attempts, let the harness compact a long-running goal so the
    next attempt starts inside the context window. A swap re-inherits the run's
    guard baseline and resets event-relative bookkeeping; usage accounting is
    shared across the swap, so the token budget keeps counting the whole run.
    """
    from friday.app import prepare_context_for_chat

    context = state["context"]
    if not isinstance(getattr(context, "metadata", None), dict) or "workspace" not in context.metadata:
        return
    agent, new_context, notice = prepare_context_for_chat(state["agent"], context, stream=state.get("stream", True))
    if new_context is context:
        return
    new_context.on_event = context.on_event
    new_context.on_observation = context.on_observation
    inherit_guarded_run(new_context, context)
    state["agent"] = agent
    state["context"] = new_context
    state["start_event"] = 0
    new_context.emit("context.transition", category="context", data={"notice": notice})


def _verify(state: dict[str, Any]):
    result = verify_friday(
        state["goal"],
        state["context"],
        state["start_event"],
        force=state["force_verify"],
    )
    if not result:
        state["status"] = "done"
        return "finish", state

    result = _normalize_result(result, state["attempt"])
    verdict = result["verdict"]
    if result.get("approval_required"):
        return _finish(state, result, "needs_approval")
    if result.get("error"):
        return _finish(state, result, "error")
    if verdict == "pass":
        return _finish(state, result, "done")
    if verdict == "blocked":
        return _finish(state, result, "blocked")
    if verdict == "inconclusive":
        return _finish(state, result, "inconclusive")

    guard_reason = result.get("guard_stop_reason") or state["context"].metadata.get(GUARD_STOP_REASON)
    if guard_reason in GUARD_STOP_REASONS:
        result["stop_reason"] = guard_reason
        return _finish(state, result, guard_reason)

    next_check = str(result.get("next_check") or "").strip()
    if not next_check:
        result["verdict"] = "inconclusive"
        result["feedback"] = str(result.get("feedback") or "Verifier requested repair without a concrete next check.")
        return _finish(state, result, "inconclusive")

    tokens_used = _tokens_used(state["context"], state.get("usage_start"))
    if tokens_used is not None:
        result["tokens_used"] = tokens_used
        result["token_budget"] = state["token_budget"]

    repair_signature = _repair_signature(result)
    attempt_signature = state.get("attempt_signature")
    if repair_signature == state.get("last_repair_signature") and attempt_signature == state.get("last_attempt_signature"):
        result["stop_reason"] = "no_progress"
        return _finish(state, result, "no_progress")

    if tokens_used is not None:
        if tokens_used >= int(state["token_budget"] * TOKEN_BUDGET_SOFT_LIMIT):
            result["stop_reason"] = "token_budget"
            return _finish(state, result, "token_budget")

    if state["max_attempts"] is not None and state["attempt"] >= state["max_attempts"]:
        result["stop_reason"] = "max_attempts"
        return _finish(state, result, "max_attempts")

    state["last_attempt_signature"] = attempt_signature
    state["last_repair_signature"] = repair_signature
    feedback = str(result.get("feedback") or "").strip()
    state["feedback"] = f"{feedback}\n\nNext check: {next_check}".strip()
    _record(state, result)
    return "retry", state


def _finish(state: dict[str, Any], result: dict[str, Any], status: LoopStatus):
    state["status"] = status
    if status not in {"done", "needs_approval"}:
        result.setdefault("stop_reason", status)
    _record(state, result)
    return "finish", state


def _record(state: dict[str, Any], result: dict[str, Any]) -> None:
    state["verifications"].append(result)
    record_verification(state["context"], result, state["on_verify"])


def _normalize_result(result: dict[str, Any], attempt: int) -> dict[str, Any]:
    value = dict(result)
    legacy = "verdict" not in value
    verdict = str(value.get("verdict") or "").strip().lower()
    if verdict not in {"pass", "repair", "blocked", "inconclusive"}:
        verdict = "pass" if value.get("passed") else "blocked" if value.get("blocked") else "repair" if value.get("feedback") else "inconclusive"
    value["verdict"] = verdict
    value["passed"] = verdict == "pass"
    value["blocked"] = verdict == "blocked"
    value["attempt"] = attempt
    if verdict == "repair" and legacy and "next_check" not in value:
        value["next_check"] = str(value.get("feedback") or "")
    return value


def _repair_signature(result: dict[str, Any]) -> str:
    text = " ".join(" ".join(str(result.get(key) or "").lower().split()) for key in ("feedback", "next_check"))
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _event_signature(events: list[Any]) -> str:
    rows = []
    for event in events:
        value = event.to_dict() if hasattr(event, "to_dict") else event
        if not isinstance(value, dict) or value.get("type") not in {"tool.call", "tool.result", "artifact.set"}:
            continue
        data = value.get("data", {})
        rows.append({"type": value.get("type"), "data": data})
    return hashlib.sha256(json.dumps(rows, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")).hexdigest()


def _usage_snapshot(context: RunContext) -> Any:
    usage = getattr(context, "usage", None)
    return usage.snapshot() if usage is not None and hasattr(usage, "snapshot") else None


def _tokens_used(context: RunContext, start: Any) -> int | None:
    usage = getattr(context, "usage", None)
    if usage is None or start is None or not hasattr(usage, "since"):
        return None
    total = usage.since(start).to_dict().get("total_tokens")
    return total if isinstance(total, int) else None


def _token_budget(context: RunContext) -> int:
    config = context.metadata.get("friday.model_config", {})
    value = config.get("run_token_budget") if isinstance(config, dict) else None
    return value if isinstance(value, int) and value > 0 else DEFAULT_MODEL_CONFIG.run_token_budget


def _to_result(state: dict[str, Any]) -> LoopResult:
    return LoopResult(
        answer=str(state.get("answer", "")),
        status=state.get("status", "done"),
        verifications=list(state.get("verifications", [])),
        agent=state.get("agent"),
        context=state.get("context"),
    )
