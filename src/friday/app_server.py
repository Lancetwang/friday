from __future__ import annotations

import json
import sys
import threading
from pathlib import Path
from typing import Any

from agent_core import AgentEvent

from friday.app import build_instructions, resume_choices
from friday.config import load_model_config
from friday.context import context_report
from friday.memory import format_memory_result, run_memory_command
from friday.session import FridaySession
from friday.state import delete_session, rename_session
from friday.tools import build_tools, pending_approval, permission_mode, set_permission_mode
from friday.trace_web import start_trace_server

_write_lock = threading.Lock()


def main() -> None:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    output = sys.stdout
    sys.stdout = sys.stderr
    gateway = Gateway(output=output)
    gateway.event("gateway.ready", {"cwd": str(Path.cwd().resolve())})
    for line in sys.stdin:
        # Tolerate a UTF-8 BOM from Windows shells piping into the gateway.
        line = line.lstrip("\ufeff")
        if line.strip():
            gateway.handle(json.loads(line))


def verification_status(result: dict[str, Any]) -> dict[str, Any]:
    return {
        key: result[key]
        for key in ("approval_required", "error", "passed", "verdict")
        if key in result
    }


class Gateway:
    """JSON-RPC view over one FridaySession: renders events, owns no agent state."""

    def __init__(self, output=None) -> None:
        self.output = output or sys.stdout
        self.tool_names: dict[str, str] = {}
        self.session = self._new_session()

    def _new_session(self) -> FridaySession:
        return FridaySession(
            stream=True,
            on_delta=lambda chunk: self.event("message.delta", {"text": chunk}),
            on_verify=lambda verification: self.event("verification.complete", verification_status(verification)),
            on_context_notice=lambda notice: self.event("gateway.stderr", {"line": f"context {notice.split(':', 1)[0]}"}),
            on_event=self.on_agent_event,
            on_turn_start=lambda text: self.event("message.start", {"text": text}),
            on_turn_complete=lambda result: self.event(
                "message.complete",
                {
                    "text": result.answer,
                    "metrics": result.metrics,
                    "progress": result.progress,
                    "session_id": str(result.context.metadata.get("session_id") or ""),
                },
            ),
        )

    def handle(self, msg: dict[str, Any]) -> None:
        rid = msg.get("id")
        method = msg.get("method")
        params = msg.get("params") or {}
        try:
            if method == "session.info":
                self.ok(rid, self.session_info())
            elif method == "chat.send":
                self.ok(rid, {"text": self.session.chat(str(params.get("text") or "")).answer})
            elif method == "goal.run":
                self.ok(rid, {"text": self.session.chat(str(params.get("text") or ""), goal=True).answer})
            elif method == "prompt.get":
                self.ok(rid, {"text": build_instructions(Path.cwd().resolve(), Path.cwd().resolve() / ".friday")})
            elif method == "memory.command":
                result = run_memory_command(str(params.get("command") or ""), Path.cwd().resolve())
                self.ok(rid, {"text": format_memory_result(result)})
            elif method == "context.get":
                _agent, context = self.session.ensure()
                self.ok(rid, {"text": context_report(context, build_tools(Path.cwd().resolve(), Path.cwd().resolve() / ".friday"))})
            elif method == "progress.get":
                self.session.ensure()
                self.ok(rid, {"progress": self.session.progress()})
            elif method == "permission.set":
                self.ok(rid, {"permission_mode": set_permission_mode(str(params.get("mode") or ""))})
            elif method == "trace.serve":
                _server, url = start_trace_server()
                self.ok(rid, {"url": url})
            elif method == "session.reset":
                removed = self.session.reset()
                self.ok(rid, {"removed": [str(path) for path in removed], "info": self.session_info()})
            elif method == "session.new":
                self.session.new()
                self.tool_names.clear()
                self.ok(rid, {"info": self.session_info(), "history": []})
            elif method == "session.current":
                self.ok(rid, {"info": self.session_info(), "history": session_history(self.session)})
            elif method == "session.compact":
                self.ok(rid, {"text": self.session.compact()})
            elif method == "session.resume":
                count = self.session.resume(params.get("id"))
                self.ok(
                    rid,
                    {
                        "count": count,
                        "history": session_history(self.session),
                        "info": self.session_info(),
                        "progress": self.session.progress(),
                    },
                )
            elif method == "session.resume_choices":
                self.ok(rid, {"choices": resume_choices(limit=50)})
            elif method == "session.rename":
                session_id = str(params.get("id") or "")
                data = rename_session(Path.cwd().resolve(), session_id, str(params.get("title") or ""))
                self.ok(rid, {"id": session_id, "title": data["title"]})
            elif method == "session.delete":
                session_id = str(params.get("id") or "")
                delete_session(Path.cwd().resolve(), session_id)
                if self.session.context is not None and self.session.context.metadata.get("session_id") == session_id:
                    self.session.new()
                    self.tool_names.clear()
                self.ok(
                    rid,
                    {
                        "deleted": session_id,
                        "info": self.session_info(),
                        "history": session_history(self.session),
                    },
                )
            elif method == "checkpoint.undo":
                restored = self.session.undo(params.get("id"), force=bool(params.get("force")))
                self.ok(
                    rid,
                    {
                        "id": restored["id"],
                        "user": restored.get("user", ""),
                        "changed_paths": restored.get("changed_paths", []),
                        "progress": self.session.progress(),
                    },
                )
            elif method == "approval.pending":
                self.ok(rid, pending_approval())
            elif method == "approval.approve":
                outcome = self.session.approve(for_session=bool(params.get("session")))
                self.event("approval.resolved", {"decision": "approve", "continued": outcome["continued"]})
                if outcome["continued"]:
                    self.ok(
                        rid,
                        {
                            "approval": outcome["approval"],
                            "approved": True,
                            "continued": True,
                            "message": {"text": outcome["turn"].answer},
                        },
                    )
                else:
                    self.ok(rid, outcome["approval"])
            elif method == "approval.instruct":
                instruction = str(params.get("text") or "").strip()
                if not instruction:
                    raise ValueError("Tell Friday what to do before continuing.")
                outcome = self.session.reject(instruction)
                self.event("approval.resolved", {"decision": "instruct", "continued": outcome["continued"]})
                if outcome["continued"]:
                    self.ok(
                        rid,
                        {
                            "approval": outcome["approval"],
                            "continued": True,
                            "message": {"text": outcome["turn"].answer},
                        },
                    )
                else:
                    self.ok(rid, outcome["approval"])
            elif method == "approval.reject":
                outcome = self.session.reject()
                self.event("approval.resolved", {"decision": "reject", "continued": outcome["continued"]})
                self.ok(rid, outcome["approval"])
            else:
                self.err(rid, f"unknown method: {method}")
        except Exception as exc:
            self.err(rid, str(exc))

    def session_info(self) -> dict[str, Any]:
        config = load_model_config(Path.cwd().resolve())
        session_id = ""
        if self.session.context is not None:
            session_id = str(self.session.context.metadata.get("session_id") or "")
        return {
            "cwd": str(Path.cwd().resolve()),
            "model": f"{config.provider}/{config.model}",
            "permission_mode": permission_mode(),
            "progress": self.session.progress(),
            "approval": pending_approval(),
            "session_id": session_id,
            "tools": [tool.name for tool in build_tools(Path.cwd().resolve(), Path.cwd().resolve() / ".friday")],
        }

    def on_agent_event(self, event: AgentEvent) -> None:
        if event.type == "verification.start":
            self.event("verification.start", {})
        elif event.type == "progress.updated":
            self.event("progress.update", dict(event.data))
        elif event.type == "tool.call":
            call_id = str(event.data.get("tool_call_id") or "")
            name = str(event.data.get("name") or "")
            if call_id:
                self.tool_names[call_id] = name
            self.event(
                "tool.start",
                {
                    "tool_call_id": call_id,
                    "name": name,
                    "arguments": event.data.get("arguments", {}),
                },
            )
        elif event.type == "tool.result":
            call_id = str(event.data.get("tool_call_id") or "")
            content = event.data.get("content", "")
            if not isinstance(content, str):
                content = json.dumps(content, ensure_ascii=False)
            try:
                value = json.loads(content)
            except json.JSONDecodeError:
                value = None
            approval = value if isinstance(value, dict) and value.get("approval_required") else None
            self.event(
                "tool.complete",
                {
                    "tool_call_id": call_id,
                    "name": self.tool_names.pop(call_id, ""),
                    "error": bool(event.data.get("is_error")),
                    "content": content,
                    "approval": approval,
                },
            )
        elif event.type == "approval.pending":
            self.event("approval.pending", dict(event.data))

    def event(self, event_type: str, payload: dict[str, Any]) -> None:
        self.write({"jsonrpc": "2.0", "method": "event", "params": {"type": event_type, "payload": payload}})

    def ok(self, rid: str, result: Any) -> None:
        self.write({"jsonrpc": "2.0", "id": rid, "result": result})

    def err(self, rid: str, message: str) -> None:
        self.write({"jsonrpc": "2.0", "id": rid, "error": {"message": message}})

    def write(self, msg: dict[str, Any]) -> None:
        with _write_lock:
            self.output.write(json.dumps(msg, ensure_ascii=False) + "\n")
            self.output.flush()


def session_history(session: FridaySession) -> list[dict[str, Any]]:
    if session.context is None:
        return []
    history: list[dict[str, Any]] = []
    tools: dict[str, int] = {}
    assistant_parts: list[str] = []

    def flush_assistant() -> None:
        if assistant_parts:
            history.append({"kind": "assistant", "text": "\n\n".join(assistant_parts)})
            assistant_parts.clear()

    for message in session.context.get_messages():
        role = message.get("role")
        content = str(message.get("content") or "")
        if role == "user" and content:
            flush_assistant()
            history.append({"kind": "user", "text": content})
        elif role == "assistant" and not message.get("friday_progress"):
            for call in message.get("tool_calls") or []:
                function = call.get("function") if isinstance(call, dict) else {}
                function = function if isinstance(function, dict) else {}
                call_id = str(call.get("id") or "")
                arguments = function.get("arguments") or {}
                if isinstance(arguments, str):
                    try:
                        arguments = json.loads(arguments)
                    except json.JSONDecodeError:
                        pass
                tools[call_id] = len(history)
                history.append(
                    {
                        "arguments": arguments,
                        "kind": "tool",
                        "name": str(function.get("name") or "Tool"),
                        "status": "running",
                        "text": "",
                        "tool_call_id": call_id,
                    }
                )
            if content:
                assistant_parts.append(content)
        elif role == "tool":
            call_id = str(message.get("tool_call_id") or "")
            index = tools.get(call_id)
            if index is not None:
                history[index].update(status="done", text=content)
            else:
                history.append(
                    {
                        "arguments": {},
                        "kind": "tool",
                        "name": "Tool",
                        "status": "done",
                        "text": content,
                        "tool_call_id": call_id,
                    }
                )
    flush_assistant()
    return history


if __name__ == "__main__":
    main()
