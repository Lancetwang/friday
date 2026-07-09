from __future__ import annotations

import json
import sys
import threading
import time
from pathlib import Path
from typing import Any

from agent_core import Agent, AgentEvent, RunContext

from friday.app import build_friday, build_instructions, compact_friday, prepare_context_for_chat, reset_friday, resume_choices, resume_friday, save_turn
from friday.context import context_report, usage_from_events
from friday.loop import AGENT_MAX_STEPS, goal_chat, verified_chat
from friday.tools import approve_pending, build_tools, pending_approval
from friday.trace import write_trace

_real_stdout = sys.stdout
sys.stdout = sys.stderr
_write_lock = threading.Lock()


def main() -> None:
    gateway = Gateway()
    gateway.event("gateway.ready", {"cwd": str(Path.cwd().resolve())})
    for line in sys.stdin:
        if line.strip():
            gateway.handle(json.loads(line))


class Gateway:
    def __init__(self) -> None:
        self.agent: Agent | None = None
        self.context: RunContext | None = None
        self.pending_after_approval: dict[str, Any] | None = None

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
            elif method == "context.get":
                agent, context = self.ensure_agent()
                self.ok(rid, {"text": context_report(context, build_tools(Path.cwd().resolve(), Path.cwd().resolve() / ".friday"))})
            elif method == "session.reset":
                removed = reset_friday(include_user=True)
                self.agent = None
                self.context = None
                self.pending_after_approval = None
                self.ok(rid, {"removed": [str(path) for path in removed], "info": self.session_info()})
            elif method == "session.compact":
                agent, context = self.ensure_agent()
                self.agent, self.context, summary = compact_friday(agent, context, stream=True)
                self.context.on_event = self.on_agent_event
                self.ok(rid, {"text": summary})
            elif method == "session.resume":
                self.agent, self.context, count = resume_friday(stream=True, resume_id=params.get("id"))
                self.context.on_event = self.on_agent_event
                self.pending_after_approval = None
                self.ok(rid, {"count": count})
            elif method == "session.resume_choices":
                self.ok(rid, {"choices": resume_choices()})
            elif method == "approval.pending":
                self.ok(rid, pending_approval())
            elif method == "approval.approve":
                result = approve_pending()
                continuation = self.pending_after_approval if result.get("approved") else None
                self.pending_after_approval = None
                if continuation:
                    prompt = str(continuation["text"]) if continuation.get("goal") else _approval_followup_prompt(result)
                    continued = self.chat(
                        prompt,
                        goal=bool(continuation.get("goal")),
                        approval_result=result,
                        save_user="/approve",
                    )
                    self.ok(rid, {"approval": result, "approved": True, "continued": True, "message": continued})
                else:
                    self.ok(rid, result)
            elif method == "approval.reject":
                self.pending_after_approval = None
                self.ok(rid, approve_pending(reject=True))
            else:
                self.err(rid, f"unknown method: {method}")
        except Exception as exc:
            self.err(rid, str(exc))

    def session_info(self) -> dict[str, Any]:
        return {
            "cwd": str(Path.cwd().resolve()),
            "model": "model from .env",
            "tools": [tool.name for tool in build_tools(Path.cwd().resolve(), Path.cwd().resolve() / ".friday")],
        }

    def chat(
        self,
        text: str,
        *,
        goal: bool = False,
        approval_result: dict[str, Any] | None = None,
        save_user: str | None = None,
    ) -> dict[str, Any]:
        agent, context = self.ensure_agent()
        self.agent, self.context, notice = prepare_context_for_chat(agent, context, stream=True)
        agent, context = self.agent, self.context
        if notice:
            self.event("gateway.stderr", {"line": f"context {notice.split(':', 1)[0]}"})
        if approval_result is not None:
            context.add_message("system", "## Approval Result\n" + json.dumps(approval_result, ensure_ascii=False, indent=2))
        self.event("message.start", {"text": text})
        start_event = len(context.events)
        prompt_messages = [dict(message) for message in context.get_messages()]
        start = time.perf_counter()
        verifications: list[dict[str, Any]] = []

        def delta(chunk: str) -> None:
            self.event("message.delta", {"text": chunk})

        if goal:
            answer, verifications = goal_chat(
                agent,
                context,
                text,
                agent.instructions or "",
                max_steps=AGENT_MAX_STEPS,
                on_delta=delta,
                on_verify=lambda result: self.event("verification.complete", result),
            )
        else:
            answer, verifications = verified_chat(
                agent,
                context,
                text,
                agent.instructions or "",
                max_steps=AGENT_MAX_STEPS,
                on_delta=delta,
                on_verify=lambda result: self.event("verification.complete", result),
            )
        if context.events:
            pending = pending_approval(Path(context.metadata["workspace"]))
            self.pending_after_approval = {"text": text, "goal": goal} if pending.get("pending") else None
        usage = usage_from_events([event.to_dict() for event in context.events])
        context.metadata["friday.last_usage"] = usage
        estimated = usage["input_tokens"] is None or usage["output_tokens"] is None
        metrics = {
            "elapsed_ms": int((time.perf_counter() - start) * 1000),
            "estimated_tokens": estimated,
            "input_tokens": usage["input_tokens"] or _estimate_tokens(_input_text(context, answer)),
            "output_tokens": usage["output_tokens"] or _estimate_tokens(answer),
        }
        self.event("message.complete", {"text": answer, "metrics": metrics})
        write_trace(
            Path(context.metadata["workspace"]),
            mode="approve" if save_user == "/approve" else "goal" if goal else "chat",
            user=save_user or (f"/goal {text}" if goal else text),
            assistant=answer,
            context=context,
            start_event=start_event,
            prompt_messages=prompt_messages,
            metrics=metrics,
            verifications=verifications,
        )
        save_turn(
            Path(context.metadata["workspace"]),
            save_user or (f"/goal {text}" if goal else text),
            answer,
            [event.to_dict() for event in context.events[-20:]],
            str(context.metadata.get("session_id") or ""),
            context.get_messages(),
        )
        return {"text": answer}

    def ensure_agent(self) -> tuple[Agent, RunContext]:
        if self.agent is None or self.context is None:
            self.agent, self.context = build_friday(stream=True)
            self.context.on_event = self.on_agent_event
        return self.agent, self.context

    def on_agent_event(self, event: AgentEvent) -> None:
        if event.type == "tool.call":
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


def _approval_followup_prompt(result: dict[str, Any]) -> str:
    return (
        "The user approved the pending command and it has now executed. "
        "Use the approval result in the system context to continue or briefly report the final state to the user. "
        "Do not ask for approval again unless a new dangerous action is required."
    )


def _input_text(context: RunContext, answer: str) -> str:
    parts = []
    for message in context.get_messages():
        content = str(message.get("content", ""))
        if message.get("role") == "assistant" and content == answer:
            continue
        parts.append(content)
    return "\n".join(parts)


def _estimate_tokens(text: str) -> int:
    # ponytail: local display estimate; provider usage wins when present.
    return max(1, (len(text) + 3) // 4)


if __name__ == "__main__":
    main()
