from __future__ import annotations

import json
import platform
import re
from dataclasses import asdict
from pathlib import Path
from typing import Any, Callable

from agent_core import Agent, RunContext

from friday.agent_flow import GUARD_STOP_REASON, build_guarded_flow, inherit_guarded_run
from friday.config import (
    ModelConfig,
    build_model,
    load_model_config,
    output_token_limit,
)
from friday.model_options import DEFAULT_THINKING_EFFORT, thinking_request_kwargs
from friday.prompts import SECURITY_NOTES, VERIFIER_NOTES
from friday.storage import project_state_dir
from friday.tools import _shell_surface, allow_permissions_for_session, build_tools, pending_approval

VERIFIER_MAX_STEPS = 10000
def build_verifier(
    workspace: Path,
    config: ModelConfig | None = None,
    *,
    thinking_effort: str = DEFAULT_THINKING_EFFORT,
) -> tuple[Agent, RunContext]:
    root = workspace.resolve()
    friday_dir = project_state_dir(root)
    # One model, three roles: the verifier and the trace analyst reuse the
    # workspace's own model config, so a provider whose real ceiling is not
    # 1M never gets a window it cannot serve.
    config = config or load_model_config(root)
    system = platform.system()
    shell = "PowerShell" if system == "Windows" else "bash"
    tools = build_tools(root, friday_dir)
    agent = Agent(
        flow=build_guarded_flow(
            build_model(config),
            tools,
            chat_kwargs={
                "stream": False,
                # Thinking models burn output tokens on reasoning before writing
                # the verdict JSON. A tight cap like 900 can leave zero content
                # tokens, which fails parsing and blocks the whole turn.
                **output_token_limit(config, 4000),
                **thinking_request_kwargs(config.provider, thinking_effort),
                "tool_choice": "auto",
            },
        ),
        instructions=f"{SECURITY_NOTES}\n\n{VERIFIER_NOTES}\n\nWorkspace: {root}\nOS: {system}\nShell: {shell}",
    )
    context = agent.new_context()
    context.metadata["workspace"] = str(root)
    context.metadata["friday.model_config"] = asdict(config)
    context.metadata["friday.thinking_effort"] = thinking_effort
    # The verifier's job is to break the deliverable, which means running
    # builds, tests, and probes in manual mode without pausing the turn for
    # approval. Its commands are part of verification, not user work: exempt
    # it from permission prompts outright. Hard-denied commands (disk format,
    # credential exfiltration, encoded shell) stay blocked for every agent.
    allow_permissions_for_session(context)
    return agent, context


def verify_friday(goal: str, context: RunContext, start_event: int, *, force: bool = False) -> dict[str, Any] | None:
    events = [event.to_dict() for event in context.events[start_event:]]
    if not force and not needs_verification(events):
        return None
    workspace = Path(context.metadata["workspace"])
    session_id = str(context.metadata.get("session_id") or "")
    approval_result = _pending_approval_result(workspace, session_id)
    if approval_result:
        return approval_result
    context.emit("verification.start", category="verification", data={"goal_chars": len(goal)})
    config_data = context.metadata.get("friday.model_config")
    config = ModelConfig(**config_data) if isinstance(config_data, dict) else None
    thinking_effort = str(context.metadata.get("friday.thinking_effort") or DEFAULT_THINKING_EFFORT)
    verifier, verifier_context = build_verifier(workspace, config, thinking_effort=thinking_effort)
    verifier_context.usage = context.usage
    if context.on_observation is not None:
        def observe(event: Any) -> None:
            event.data["agent_role"] = "verifier"
            context.on_observation(event)

        verifier_context.on_observation = observe
    inherit_guarded_run(verifier_context, context)
    # The verifier is an extension of the main session: an approval it triggers
    # must land on this session's pending slot. Without the session id the
    # approval file is written to the shared slot, the post-run check below
    # misses it, and the suspended flow's empty answer is misreported as
    # broken verifier JSON. (Verification commands themselves no longer ask
    # for approval -- build_verifier grants them full access -- but keeping
    # the id makes any future approval path findable.)
    verifier_context.metadata["session_id"] = session_id
    try:
        history = [
            str(message.get("content") or "")[:1500]
            for message in context.get_messages()
            if message.get("role") == "user" and not message.get("friday_internal")
        ][-4:]
        if history and history[-1].strip() == goal.strip():
            history.pop()
        raw = verifier.chat(
            verification_prompt(goal, events, history),
            context=verifier_context,
            max_steps=VERIFIER_MAX_STEPS,
            stream=False,
        )
    except Exception as exc:
        return {"verdict": "inconclusive", "blocked": False, "error": True, "evidence": [], "feedback": f"Verifier failed: {exc}", "next_check": "", "passed": False, "required": True}
    approval_result = _pending_approval_result(workspace, session_id)
    if approval_result:
        return approval_result
    parsed = parse_verification(raw)
    guard_reason = verifier_context.metadata.get(GUARD_STOP_REASON)
    if isinstance(guard_reason, str):
        parsed["guard_stop_reason"] = guard_reason
    parsed["required"] = True
    return parsed


def record_verification(context: RunContext, result: dict[str, Any], on_verify: Callable[[dict[str, Any]], None] | None) -> None:
    context.emit("verification.result", category="verification", data=result)
    if on_verify:
        on_verify(result)


def needs_verification(events: list[dict[str, Any]]) -> bool:
    for event in events:
        data = event.get("data", {})
        if not isinstance(data, dict):
            continue
        name = str(data.get("name", ""))
        if event.get("type") == "tool.call" and name in {"Write", "Edit"}:
            return True
        if event.get("type") == "tool.call" and name == "Bash":
            args = data.get("arguments", {})
            command = str(args.get("command", "")) if isinstance(args, dict) else ""
            if bash_may_write(command):
                return True
    return False


def bash_may_write(command: str) -> bool:
    lowered = _shell_surface(command).lower()
    checked = re.sub(r"(?:(?:&|\*|\d+)\s*)?>{1,2}\s*(?:\$null\b|/dev/null\b|nul\b|&\d+\b)", "", lowered)
    return bool(re.search(r"\b(set-content|add-content|out-file|new-item|move-item|rename-item|rm|del|remove-item)\b|(^|[^><])>{1,2}(?![=>&])", checked))


def _pending_approval_result(workspace: Path, session_id: str = "") -> dict[str, Any] | None:
    approval = pending_approval(workspace, session_id=session_id)
    if not approval.get("pending"):
        return None
    return {
        "approval_required": True,
        "verdict": "inconclusive",
        "blocked": False,
        "evidence": [f"Pending approval for: {approval.get('command', '')}"],
        "feedback": "Approve or reject the pending command before continuing verification.",
        "passed": False,
        "required": True,
    }


def verification_prompt(goal: str, events: list[dict[str, Any]], user_history: list[str] | None = None) -> str:
    parts = [f"User goal:\n{goal}"]
    if user_history:
        parts.append(
            "Earlier user requirements (acceptance context, not proof):\n"
            + json.dumps(user_history, ensure_ascii=False, indent=2)
        )
    parts.extend(
        [
            "Independently verify the delivered workspace state by trying to break it. Use the delivery hints only to locate artifacts; they are not proof.",
            "Delivery hints:\n" + json.dumps(summarize_events(events), ensure_ascii=False, indent=2),
            'Return only JSON: {"verdict": "pass|repair|blocked|inconclusive", "evidence": ["criterion -> challenge -> outcome"], "feedback": "", "next_check": ""}',
        ]
    )
    return "\n\n".join(parts)


def summarize_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    summary = []
    for event in events:
        if event.get("type") != "tool.call":
            continue
        data = event.get("data", {})
        if not isinstance(data, dict):
            continue
        name = str(data.get("name") or "")
        if name not in {"Write", "Edit", "Bash"}:
            continue
        arguments = data.get("arguments", {})
        path = arguments.get("path") if isinstance(arguments, dict) else None
        hint = {"tool": name}
        if isinstance(path, str) and path:
            hint["path"] = path
        summary.append(hint)
    return summary[-20:]


def parse_verification(raw: str) -> dict[str, Any]:
    text = raw.strip()
    if not text:
        # An empty answer is not a malformed verdict: the verifier flow ended
        # without producing text (for example it suspended on a pending
        # approval it triggered). Name the real symptom instead of blaming the
        # JSON so the UI surfaces the actual blocker.
        return {
            "verdict": "inconclusive",
            "blocked": False,
            "error": True,
            "passed": False,
            "evidence": [],
            "feedback": "Verifier returned no output.",
            "next_check": "",
        }
    if text.startswith("```"):
        text = text.strip("`")
        text = text[text.find("{") :]
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1:
        try:
            value = json.loads(text[start : end + 1])
            if isinstance(value, dict):
                verdict = _verdict(value)
                feedback = str(value.get("feedback") or "").strip()
                next_check = str(value.get("next_check") or "").strip()
                if "verdict" not in value and verdict == "repair" and not next_check:
                    next_check = feedback
                return {
                    "verdict": verdict,
                    "blocked": verdict == "blocked",
                    "passed": verdict == "pass",
                    "evidence": value.get("evidence") if isinstance(value.get("evidence"), list) else [],
                    "feedback": feedback,
                    "next_check": next_check,
                }
        except json.JSONDecodeError:
            pass
    return {"verdict": "inconclusive", "blocked": False, "error": True, "passed": False, "evidence": [], "feedback": f"Verifier returned invalid JSON: {raw[:500]}", "next_check": ""}


def _verdict(value: dict[str, Any]) -> str:
    verdict = str(value.get("verdict") or "").strip().lower()
    if verdict in {"pass", "repair", "blocked", "inconclusive"}:
        return verdict
    if value.get("passed"):
        return "pass"
    if value.get("blocked"):
        return "blocked"
    return "repair" if value.get("feedback") else "inconclusive"
