from __future__ import annotations

import json
import sys
import threading
from pathlib import Path
from typing import Any

from agent_core import AgentEvent

from friday.app import resume_choices
from friday.checkpoint import checkpoint_choices
from friday.config import (
    delete_model_profile,
    load_model_catalog,
    load_model_config,
    save_model_profile,
    select_model_profile,
)
from friday.context import context_report
from friday.memory import format_memory_result, run_memory_command
from friday.model_options import supports_thinking
from friday.session import FridaySession
from friday.skills import discover_skills, skill_body
from friday.state import USER_MESSAGE_TIMES_KEY, delete_session, rename_session
from friday.storage import friday_home
from friday.tools import build_tools, pending_approval, permission_mode, set_permission_mode
from friday.trace_web import start_trace_server

_write_lock = threading.Lock()
_IMAGE_PREFIXES = ("data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,", "data:image/gif;base64,")
_MAX_IMAGE_CHARS = 14_000_000
_MAX_TOTAL_IMAGE_CHARS = 20_000_000


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
            try:
                message = json.loads(line)
            except json.JSONDecodeError as exc:
                gateway.err(None, f"invalid JSON-RPC request: {exc}")
                continue
            if not isinstance(message, dict):
                gateway.err(None, "invalid JSON-RPC request: expected an object")
                continue
            gateway.handle(message)


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
        self.reasoning_ids: dict[str, str] = {}
        self.reasoning_seq = 0
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
                    "verification": verification_status(result.verifications[-1]) if result.verifications else None,
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
                images = _image_urls(params.get("images"))
                self.ok(rid, {"text": self.session.chat(str(params.get("text") or ""), images=images).answer})
            elif method == "goal.run":
                self.ok(rid, {"text": self.session.chat(str(params.get("text") or ""), goal=True).answer})
            elif method == "memory.command":
                result = run_memory_command(str(params.get("command") or ""), Path.cwd().resolve())
                self.ok(rid, {"text": format_memory_result(result)})
            elif method == "context.get":
                _agent, context = self.session.ensure()
                self.ok(rid, {"text": context_report(context, build_tools(Path.cwd().resolve()))})
            elif method == "progress.get":
                self.session.ensure()
                self.ok(rid, {"progress": self.session.progress()})
            elif method == "skill.list":
                self.ok(rid, {"skills": discover_skills(Path.cwd().resolve(), friday_home())})
            elif method == "skill.get":
                path = str(params.get("path") or "")
                skill = next(
                    (
                        item
                        for item in discover_skills(Path.cwd().resolve(), friday_home())
                        if str(item["path"]) == path
                    ),
                    None,
                )
                if skill is None:
                    raise ValueError("Skill is not available to Friday.")
                self.ok(rid, {"skill": skill, "content": skill_body(Path(path).read_text(encoding="utf-8"))})
            elif method == "permission.set":
                self.ok(rid, {"permission_mode": set_permission_mode(str(params.get("mode") or ""))})
            elif method == "thinking.set":
                effort = self.session.select_thinking(str(params.get("effort") or ""))
                self.ok(rid, {"thinking_effort": effort, "info": self.session_info()})
            elif method == "model.list":
                self.ok(rid, load_model_catalog(Path.cwd().resolve()))
            elif method == "model.save":
                profile = params.get("profile")
                if not isinstance(profile, dict):
                    raise ValueError("Model configuration must be an object.")
                catalog = save_model_profile(
                    Path.cwd().resolve(),
                    profile,
                    api_key=str(params["api_key"]) if "api_key" in params else None,
                    clear_api_key=bool(params.get("clear_api_key")),
                    activate=bool(params.get("activate", True)),
                )
                if bool(params.get("activate", True)):
                    self.session.select_model(catalog["active"])
                self.ok(rid, {"catalog": catalog, "info": self.session_info()})
            elif method == "model.select":
                profile_id = str(params.get("id") or "")
                catalog = select_model_profile(Path.cwd().resolve(), profile_id)
                self.session.select_model(profile_id)
                self.ok(rid, {"catalog": catalog, "info": self.session_info()})
            elif method == "model.delete":
                catalog = delete_model_profile(Path.cwd().resolve(), str(params.get("id") or ""))
                if self.session.model_profile not in {profile["id"] for profile in catalog["profiles"]}:
                    self.session.select_model(catalog["active"])
                self.ok(rid, {"catalog": catalog, "info": self.session_info()})
            elif method == "trace.serve":
                _server, url = start_trace_server(port=0)
                self.ok(rid, {"url": url})
            elif method == "session.reset":
                removed = self.session.reset(include_user=bool(params.get("global")))
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
            elif method == "checkpoint.list":
                self.ok(rid, {"checkpoints": checkpoint_choices(Path.cwd().resolve(), limit=50)})
            elif method == "checkpoint.undo":
                restored = self.session.undo(params.get("id"), force=bool(params.get("force")))
                self.ok(
                    rid,
                    {
                        "id": restored["id"],
                        "user": restored.get("user", ""),
                        "changed_paths": restored.get("changed_paths", []),
                        "progress": self.session.progress(),
                        "history": session_history(self.session),
                        "info": self.session_info(),
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
            for reasoning_id in self.reasoning_ids.values():
                self.event("reasoning.complete", {"id": reasoning_id, "error": True})
            self.reasoning_ids.clear()
            self.err(rid, str(exc))

    def session_info(self) -> dict[str, Any]:
        catalog = load_model_catalog(Path.cwd().resolve())
        config = load_model_config(Path.cwd().resolve(), profile_id=self.session.model_profile)
        profile = next(
            (item for item in catalog["profiles"] if item["id"] == config.profile_id),
            {},
        )
        session_id = ""
        if self.session.context is not None:
            session_id = str(self.session.context.metadata.get("session_id") or "")
        return {
            "cwd": str(Path.cwd().resolve()),
            "model": f"{config.provider}/{config.model}",
            "model_configured": bool(profile.get("api_key_configured")),
            "model_name": config.profile_name,
            "model_profile": config.profile_id,
            "model_vision": config.vision,
            "thinking_effort": self.session.thinking_effort or "high",
            "thinking_supported": supports_thinking(config.provider),
            "permission_mode": permission_mode(),
            "progress": self.session.progress(),
            "approval": pending_approval(),
            "session_id": session_id,
            "tools": [tool.name for tool in build_tools(Path.cwd().resolve())],
        }

    def on_agent_event(self, event: AgentEvent) -> None:
        reasoning_key = f"{event.run_id}:{event.step}"
        if event.type == "model.reasoning.delta":
            reasoning_id = self.reasoning_ids.get(reasoning_key)
            if reasoning_id is None:
                self.reasoning_seq += 1
                reasoning_id = f"reasoning-{self.reasoning_seq}"
                self.reasoning_ids[reasoning_key] = reasoning_id
            self.event(
                "reasoning.delta",
                {"id": reasoning_id, "text": str(event.data.get("content") or "")},
            )
        elif event.type == "model.response" and event.data.get("has_reasoning"):
            reasoning_id = self.reasoning_ids.pop(reasoning_key, None)
            if reasoning_id is not None:
                self.event("reasoning.complete", {"id": reasoning_id})
        elif event.type == "verification.start":
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

    def ok(self, rid: Any, result: Any) -> None:
        self.write({"jsonrpc": "2.0", "id": rid, "result": result})

    def err(self, rid: Any, message: str) -> None:
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
        content = _message_text(message.get("content"))
        if role == "user" and content:
            flush_assistant()
            history.append(
                {
                    "images": _message_images(message.get("content")),
                    "kind": "user",
                    "text": content,
                }
            )
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
    message_times = session.context.metadata.get(USER_MESSAGE_TIMES_KEY, [])
    records = [item for item in message_times if isinstance(item, dict)] if isinstance(message_times, list) else []
    record_index = len(records) - 1
    for item in reversed(history):
        if item["kind"] != "user":
            continue
        while record_index >= 0:
            record = records[record_index]
            record_index -= 1
            if record.get("text") == item["text"]:
                item["timestamp"] = str(record.get("time") or "")
                break
    return history


def _image_urls(value: Any) -> list[str]:
    if value in (None, []):
        return []
    if not isinstance(value, list) or len(value) > 4:
        raise ValueError("Attach at most four images.")
    images = [str(item) for item in value]
    if any(len(item) > _MAX_IMAGE_CHARS or not item.lower().startswith(_IMAGE_PREFIXES) for item in images):
        raise ValueError("Images must be PNG, JPEG, WebP, or GIF data URLs no larger than 10 MB.")
    if sum(map(len, images)) > _MAX_TOTAL_IMAGE_CHARS:
        raise ValueError("Attached images are too large.")
    return images


def _message_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        text = [str(part.get("text") or "") for part in content if isinstance(part, dict) and part.get("type") == "text"]
        return "\n".join(filter(None, text)) or "[Image]"
    return str(content or "")


def _message_images(content: Any) -> list[str]:
    if not isinstance(content, list):
        return []
    return [
        str((part.get("image_url") or {}).get("url") or "")
        for part in content
        if isinstance(part, dict) and part.get("type") == "image_url"
    ]


if __name__ == "__main__":
    main()
