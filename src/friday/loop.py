from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Literal

from agent_core import Agent, CallableNode, Flow, RunContext

from friday.verification import record_verification, verify_friday

AGENT_MAX_STEPS = 10000
FLOW_MAX_STEPS = 10000

LoopStatus = Literal["done", "needs_approval", "blocked", "error", "max_attempts"]


@dataclass
class LoopResult:
    answer: str = ""
    status: LoopStatus = "done"
    verifications: list[dict[str, Any]] = field(default_factory=list)


def verified_chat(
    agent: Agent,
    context: RunContext,
    text: str,
    instructions: str,
    *,
    max_steps: int = AGENT_MAX_STEPS,
    on_delta: Any = None,
    on_verify: Callable[[dict[str, Any]], None] | None = None,
    repairs: int = 1,
) -> tuple[str, list[dict[str, Any]]]:
    result = run_loop(
        agent,
        context,
        text,
        instructions,
        force_verify=False,
        max_attempts=repairs + 1,
        max_steps=max_steps,
        on_delta=on_delta,
        on_verify=on_verify,
    )
    return result.answer, result.verifications


def goal_chat(
    agent: Agent,
    context: RunContext,
    goal: str,
    instructions: str,
    *,
    max_attempts: int = 5,
    max_steps: int = AGENT_MAX_STEPS,
    on_delta: Any = None,
    on_verify: Callable[[dict[str, Any]], None] | None = None,
) -> tuple[str, list[dict[str, Any]]]:
    result = run_loop(
        agent,
        context,
        goal,
        instructions,
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
    instructions: str,
    *,
    force_verify: bool,
    max_attempts: int,
    max_steps: int,
    on_delta: Any = None,
    on_verify: Callable[[dict[str, Any]], None] | None = None,
) -> LoopResult:
    state: dict[str, Any] = {
        "agent": agent,
        "answer": "",
        "attempt": 0,
        "context": context,
        "feedback": "",
        "force_verify": force_verify,
        "goal": goal,
        "instructions": instructions,
        "max_attempts": max_attempts,
        "max_steps": max_steps,
        "on_delta": on_delta,
        "on_verify": on_verify,
        "start_event": len(context.events),
        "status": "done",
        "verifications": [],
    }
    flow = _loop_flow()
    return flow.run(state, max_steps=FLOW_MAX_STEPS).payload["result"]


def _loop_flow() -> Flow:
    attempt = CallableNode(_attempt)
    verify = CallableNode(_verify)
    finish = CallableNode(lambda state: ("default", {"result": _to_result(state)}))
    attempt - "verify" >> verify
    attempt - "finish" >> finish
    verify - "retry" >> attempt
    verify - "finish" >> finish
    return Flow(attempt)


def _attempt(state: dict[str, Any]):
    state["attempt"] += 1
    if state["attempt"] == 1:
        prompt = (
            f"Goal mode. Work toward this goal until the verifier passes or proves it impossible:\n\n{state['goal']}"
            if state["force_verify"]
            else state["goal"]
        )
    else:
        prompt = f"Verification failed after attempt {state['attempt'] - 1}. Continue working toward the original goal.\n\nVerifier feedback:\n{state['feedback']}"
    state["answer"] = state["agent"].chat(
        prompt,
        context=state["context"],
        max_steps=state["max_steps"],
        on_delta=state["on_delta"],
    )
    return "verify", state


def _verify(state: dict[str, Any]):
    result = verify_friday(
        state["goal"],
        state["context"],
        state["start_event"],
        state["instructions"],
        force=state["force_verify"],
    )
    if not result:
        state["status"] = "done"
        return "finish", state
    state["verifications"].append(result)
    record_verification(state["context"], result, state["on_verify"])
    if result.get("passed"):
        state["status"] = "done"
        return "finish", state
    if result.get("approval_required"):
        state["status"] = "needs_approval"
        return "finish", state
    if result.get("blocked"):
        state["status"] = "blocked"
        return "finish", state
    if result.get("error"):
        state["status"] = "error"
        return "finish", state
    if state["attempt"] >= state["max_attempts"]:
        state["status"] = "max_attempts"
        return "finish", state
    state["feedback"] = str(result.get("feedback") or "Verifier did not pass the goal.")
    return "retry", state


def _to_result(state: dict[str, Any]) -> LoopResult:
    return LoopResult(
        answer=str(state.get("answer", "")),
        status=state.get("status", "done"),
        verifications=list(state.get("verifications", [])),
    )
