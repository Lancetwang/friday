from __future__ import annotations

import json
import sys
import threading
from pathlib import Path
from typing import Any

from agent_core import Agent, AgentEvent, RunContext

from friday.app import build_friday, build_instructions, compact_friday, reset_friday, resume_choices, resume_friday
from friday.config import load_model_config
from friday.context import context_report
from friday.memory import format_memory_result, run_memory_command
from friday.progress import current_progress, finish_progress
from friday.tools import allow_permissions_for_session, approve_pending, build_tools, pending_approval
from friday.turn import run_turn

_real_stdout = sys.stdout
sys.stdout = sys.stderr
_write_lock = threading.Lock()


def main() -> None:
    gateway = Gateway()
    gateway.event("gateway.ready", {"cwd": str(Path.cwd().resolve())})
    for line in sys.stdin:
        if line.strip():
            gateway.handle(json.loads(line))


def verification_status(result: dict[str, Any]) -> dict[str, Any]:
    return {
        key: result[key]
        for key in ("approval_required", "error", "passed", "verdict")
        if key in result
    }


class Gateway:
    def __init__(self) -> None:
        self.agent: Agent | None = None
        self.context: RunContext | None = None
        self.suspended_turn: dict[str, Any] | None = None

    def handle(self, msg: dict[str, Any]) -> None:
        rid = msg.get("id")
        method = msg.get("method")
        params = msg.get("params") or {}
        try:
            if method == "session.info":
                self.ok(rid, self.session_info())
            elif method == "chat.send":
                self.ok(rid, self.chat(str(params.get("text") or "")))
            elif method == "goal.run":
                self.ok(rid, self.chat(str(params.get("text") or ""), goal=True))
            elif method == "prompt.get":
                self.ok(rid, {"text": build_instructions(Path.cwd().resolve(), Path.cwd().resolve() / ".friday")})
            elif method == "memory.command":
                result = run_memory_command(str(params.get("command") or ""), Path.cwd().resolve())
                self.ok(rid, {"text": format_memory_result(result)})
            elif method == "context.get":
                agent, context = self.ensure_agent()
                self.ok(rid, {"text": context_report(context, build_tools(Path.cwd().resolve(), Path.cwd().resolve() / ".friday"))})
            elif method == "progress.get":
                _agent, context = self.ensure_agent()
                self.ok(rid, {"progress": current_progress(context)})
            elif method == "session.reset":
                removed = reset_friday(include_user=True)
                self.agent = None
                self.context = None
                self.suspended_turn = None
                self.ok(rid, {"removed": [str(path) for path in removed], "info": self.session_info()})
            elif method == "session.compact":
                agent, context = self.ensure_agent()
                self.agent, self.context, summary = compact_friday(agent, context, stream=True)
                self.context.on_event = self.on_agent_event
                self.ok(rid, {"text": summary})
            elif method == "session.resume":
                self.agent, self.context, count = resume_friday(stream=True, resume_id=params.get("id"))
                self.context.on_event = self.on_agent_event
                self.suspended_turn = None
                self.ok(rid, {"count": count, "progress": current_progress(self.context)})
            elif method == "session.resume_choices":
                self.ok(rid, {"choices": resume_choices()})
            elif method == "approval.pending":
                self.ok(rid, pending_approval())
            elif method == "approval.approve":
                result = approve_pending()
                suspended = self.suspended_turn if result.get("approved") else None
                self.suspended_turn = None
                if result.get("approved") and params.get("session"):
                    _agent, context = self.ensure_agent()
                    allow_permissions_for_session(context)
                if suspended:
                    prompt = str(suspended["text"]) if suspended.get("goal") else _approval_followup_prompt()
                    continued = self.chat(
                        prompt,
                        goal=bool(suspended.get("goal")),
                        approval_result=result,
                        user_label="/approve",
                        continuation=True,
                    )
                    self.ok(rid, {"approval": result, "approved": True, "continued": True, "message": continued})
                else:
                    self.ok(rid, result)
            elif method == "approval.instruct":
                instruction = str(params.get("text") or "").strip()
                if not instruction:
                    raise ValueError("Tell Friday what to do before continuing.")
                suspended = self.suspended_turn
                self.suspended_turn = None
                result = approve_pending(reject=True)
                if suspended and result.get("rejected"):
                    goal = bool(suspended.get("goal"))
                    prompt = instruction
                    if goal:
                        prompt = f"{suspended['text']}\n\nHuman guidance after declining the pending command: {instruction}"
                    continued = self.chat(
                        prompt,
                        goal=goal,
                        approval_result={**result, "instruction": instruction},
                        user_label=instruction,
                        continuation=True,
                    )
                    self.ok(rid, {"approval": result, "continued": True, "message": continued})
                else:
                    self.ok(rid, result)
            elif method == "approval.reject":
                self.suspended_turn = None
                result = approve_pending(reject=True)
                if self.context is not None and result.get("rejected"):
                    finish_progress(self.context, "blocked", [{"verdict": "blocked", "feedback": "User rejected the pending command."}])
                self.ok(rid, result)
            else:
                self.err(rid, f"unknown method: {method}")
        except Exception as exc:
            self.err(rid, str(exc))

    def session_info(self) -> dict[str, Any]:
        config = load_model_config(Path.cwd().resolve())
        return {
            "cwd": str(Path.cwd().resolve()),
            "model": f"{config.provider}/{config.model}",
            "progress": current_progress(self.context) if self.context is not None else {},
            "tools": [tool.name for tool in build_tools(Path.cwd().resolve(), Path.cwd().resolve() / ".friday")],
        }

    def chat(
        self,
        text: str,
        *,
        goal: bool = False,
        approval_result: dict[str, Any] | None = None,
        user_label: str | None = None,
        continuation: bool = False,
    ) -> dict[str, Any]:
        agent, context = self.ensure_agent()
        self.event("message.start", {"text": text})
        result = run_turn(
            agent,
            context,
            text,
            goal=goal,
            on_delta=lambda chunk: self.event("message.delta", {"text": chunk}),
            on_verify=lambda verification: self.event("verification.complete", verification_status(verification)),
            on_context_notice=lambda notice: self.event("gateway.stderr", {"line": f"context {notice.split(':', 1)[0]}"}),
            approval_result=approval_result,
            user_label=user_label,
            continuation=continuation,
        )
        self.agent, self.context = result.agent, result.context
        if self.context.events:
            pending = pending_approval(Path(self.context.metadata["workspace"]))
            self.suspended_turn = {"text": text, "goal": goal} if pending.get("pending") else None
        self.event("message.complete", {"text": result.answer, "metrics": result.metrics, "progress": result.progress})
        return {"text": result.answer}

    def ensure_agent(self) -> tuple[Agent, RunContext]:
        if self.agent is None or self.context is None:
            self.agent, self.context = build_friday(stream=True)
            self.context.on_event = self.on_agent_event
        return self.agent, self.context

    def on_agent_event(self, event: AgentEvent) -> None:
        if event.type == "verification.start":
            self.event("verification.start", {})
        elif event.type == "progress.updated":
            self.event("progress.update", dict(event.data))
        elif event.type == "tool.call":
            self.event(
                "tool.start",
                {
                    "name": event.data.get("name", ""),
                    "arguments": event.data.get("arguments", {}),
                },
            )
        elif event.type == "tool.result":
            content = event.data.get("content", "")
            if not isinstance(content, str):
                content = json.dumps(content, ensure_ascii=False)
            self.event(
                "tool.complete",
                {
                    "name": event.data.get("name", ""),
                    "error": bool(event.data.get("is_error")),
                    "content": content,
                },
            )

    def event(self, event_type: str, payload: dict[str, Any]) -> None:
        self.write({"jsonrpc": "2.0", "method": "event", "params": {"type": event_type, "payload": payload}})

    def ok(self, rid: str, result: Any) -> None:
        self.write({"jsonrpc": "2.0", "id": rid, "result": result})

    def err(self, rid: str, message: str) -> None:
        self.write({"jsonrpc": "2.0", "id": rid, "error": {"message": message}})

    def write(self, msg: dict[str, Any]) -> None:
        with _write_lock:
            _real_stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
            _real_stdout.flush()


def _approval_followup_prompt() -> str:
    return (
        "The user approved the pending command and it has now executed. "
        "Use the approval result in the system context to continue or briefly report the final state to the user. "
        "Do not ask for approval again unless a new dangerous action is required."
    )


if __name__ == "__main__":
    main()
