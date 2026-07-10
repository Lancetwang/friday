from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Callable

from agent_core import Agent, RunContext

from friday.prompts import VERIFIER_NOTES
from friday.tools import build_tools, pending_approval

VERIFIER_MAX_STEPS = 10000


def build_verifier(instructions: str, workspace: Path) -> tuple[Agent, RunContext]:
    root = workspace.resolve()
    friday_dir = root / ".friday"
    agent = Agent(
        instructions=f"{instructions}\n\n## Verifier\n{VERIFIER_NOTES}",
        tools=build_tools(root, friday_dir),
        stream=False,
        chat_kwargs={"temperature": 0, "max_tokens": 900, "tool_choice": "auto"},
    )
    context = agent.new_context()
    context.metadata["workspace"] = str(root)
    return agent, context


def verify_friday(goal: str, context: RunContext, start_event: int, instructions: str, *, force: bool = False) -> dict[str, Any] | None:
    events = [event.to_dict() for event in context.events[start_event:]]
    if not force and not needs_verification(events):
        return None
    workspace = Path(context.metadata["workspace"])
    approval = pending_approval(workspace)
    if approval.get("pending"):
        return {
            "approval_required": True,
            "blocked": False,
            "evidence": [f"Pending approval for: {approval.get('command', '')}"],
            "feedback": "Approve or reject the pending command before continuing verification.",
            "passed": False,
            "required": True,
        }
    verifier, verifier_context = build_verifier(instructions, workspace)
    try:
        raw = verifier.chat(verification_prompt(goal, events), context=verifier_context, max_steps=VERIFIER_MAX_STEPS, stream=False)
    except Exception as exc:
        return {"blocked": False, "error": True, "evidence": [], "feedback": f"Verifier failed: {exc}", "passed": False, "required": True}
    parsed = parse_verification(raw)
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
    lowered = command.lower()
    return bool(re.search(r"\b(set-content|add-content|out-file|new-item|move-item|rename-item|rm|del|remove-item)\b|(^|[^><])>{1,2}(?![=>])", lowered))


def verification_prompt(goal: str, events: list[dict[str, Any]]) -> str:
    return "\n\n".join(
        [
            f"User goal:\n{goal}",
            "Verify the delivered workspace state. Do not trust any main-agent claims.",
            "Use tools if needed. Prefer concrete checks over reasoning from descriptions.",
            "Recent tool events:\n" + json.dumps(summarize_events(events), ensure_ascii=False, indent=2),
            'Return only JSON: {"passed": true, "blocked": false, "evidence": ["..."], "feedback": ""}',
        ]
    )


def summarize_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    summary = []
    for event in events[-30:]:
        data = event.get("data", {})
        if isinstance(data, dict):
            summary.append({"type": event.get("type"), "name": data.get("name"), "arguments": data.get("arguments")})
    return summary


def parse_verification(raw: str) -> dict[str, Any]:
    text = raw.strip()
    if text.startswith("```"):
        text = text.strip("`")
        text = text[text.find("{") :]
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1:
        try:
            value = json.loads(text[start : end + 1])
            if isinstance(value, dict):
                return {
                    "blocked": bool(value.get("blocked")),
                    "passed": bool(value.get("passed")),
                    "evidence": value.get("evidence") if isinstance(value.get("evidence"), list) else [],
                    "feedback": str(value.get("feedback") or ""),
                }
        except json.JSONDecodeError:
            pass
    return {"blocked": False, "passed": False, "evidence": [], "feedback": f"Verifier returned invalid JSON: {raw[:500]}"}
