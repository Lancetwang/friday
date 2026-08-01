from __future__ import annotations

import base64
import json
import mimetypes
import os
import sys
import threading
import time
from pathlib import Path
from typing import Any

from agent_core import AgentEvent

from friday.app import resume_choices
from friday.checkpoint import ARTIFACT_TYPES, checkpoint_choices
from friday.config import (
    delete_model_profile,
    load_model_catalog,
    load_model_config,
    load_web_search_settings,
    save_model_profile,
    save_web_search_settings,
    select_model_profile,
)
from friday.context import context_report
from friday.memory import format_memory_result, load_user_profile_settings, run_memory_command, save_user_profile_settings
from friday.model_options import supports_thinking
from friday.session import FridaySession
from friday.skills import discover_skills, skill_body
from friday.state import (
    USER_MESSAGE_TIMES_KEY,
    conversation_body,
    delete_session_tree,
    fork_session,
    preview,
    read_session,
    rename_session,
    session_path,
    session_subtree_ids,
    session_tree,
)
from friday.storage import friday_home
from friday.tools import build_tools, pending_approval, permission_mode, set_permission_mode
from friday.trace_web import start_trace_server
from friday.turn import TurnCancelled

_write_lock = threading.Lock()
_IMAGE_PREFIXES = ("data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,", "data:image/gif;base64,")
_MAX_IMAGE_CHARS = 14_000_000
_MAX_TOTAL_IMAGE_CHARS = 20_000_000
_MAX_ARTIFACT_BYTES = 25_000_000


def main() -> None:
    output = _Utf8Output(sys.stdout.buffer)
    sys.stdout = sys.stderr
    gateway = Gateway(output=output, background=True)
    gateway.event("gateway.ready", {"cwd": str(Path.cwd().resolve())})
    for line in _request_lines(sys.stdin.fileno()):
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


class _Utf8Output:
    def __init__(self, output: Any) -> None:
        self.output = output

    def write(self, value: str) -> None:
        self.output.write(value.encode("utf-8"))

    def flush(self) -> None:
        self.output.flush()


def _request_lines(fd: int):
    """Read desktop RPC without blocking the Agent worker on Windows pipes."""
    os.set_blocking(fd, False)
    pending = bytearray()
    while True:
        try:
            chunk = os.read(fd, 64 * 1024)
        except BlockingIOError:
            time.sleep(0.01)
            continue
        if not chunk:
            break
        pending.extend(chunk)
        while (end := pending.find(b"\n")) >= 0:
            raw = bytes(pending[:end]).rstrip(b"\r")
            del pending[: end + 1]
            yield raw.decode("utf-8")
    if pending:
        yield bytes(pending).rstrip(b"\r").decode("utf-8")


def verification_status(result: dict[str, Any]) -> dict[str, Any]:
    return {
        key: result[key]
        for key in ("approval_required", "error", "passed", "verdict")
        if key in result
    }


class Gateway:
    """JSON-RPC view over live Friday sessions in one workspace."""

    def __init__(self, output=None, *, background: bool = False) -> None:
        self.output = output or sys.stdout
        self.background = background
        self.reasoning_ids: dict[str, str] = {}
        self.reasoning_seq = 0
        self.tool_names: dict[str, str] = {}
        self.sessions: dict[str, FridaySession] = {}
        self.runs: dict[str, threading.Thread] = {}
        self.run_labels: dict[str, str] = {}
        self.session = self._new_session()
        self.sessions[self.session.session_id] = self.session

    def _new_session(self, session_id: str | None = None) -> FridaySession:
        session = FridaySession(stream=True, session_id=session_id)
        session.on_delta = lambda chunk: self.session_event(session, "message.delta", {"text": chunk})
        session.on_verify = lambda verification: self.session_event(
            session, "verification.complete", verification_status(verification)
        )
        session.on_context_notice = lambda notice: self.session_event(
            session, "gateway.stderr", {"line": f"context {notice.split(':', 1)[0]}"}
        )
        session.on_event = lambda event: self.on_agent_event(event, session)
        session.on_turn_start = lambda text: self.session_event(session, "message.start", {"text": text})
        session.on_turn_complete = lambda result: self._turn_complete(session, result)
        return session

    def handle(self, msg: dict[str, Any]) -> None:
        rid = msg.get("id")
        method = msg.get("method")
        params = msg.get("params") or {}
        try:
            if method == "session.info":
                self.ok(rid, self.session_info())
            elif method == "chat.send":
                images = _image_urls(params.get("images"))
                self.run_chat(rid, str(params.get("text") or ""), images=images)
            elif method == "goal.run":
                self.run_chat(rid, str(params.get("text") or ""), goal=True)
            elif method == "chat.cancel":
                session_id = str(params.get("session_id") or self.session.session_id)
                session = self.sessions.get(session_id)
                if session is None or session_id not in self.runs:
                    self.ok(rid, {"cancelled": False})
                else:
                    session.cancel()
                    self.ok(rid, {"cancelled": True, "session_id": session_id})
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
            elif method == "artifact.get":
                self.ok(rid, artifact_detail(Path.cwd().resolve(), str(params.get("path") or "")))
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
            elif method == "settings.get":
                self.ok(
                    rid,
                    {
                        "web_search": load_web_search_settings(Path.cwd().resolve()),
                        "user_profile": load_user_profile_settings(),
                    },
                )
            elif method == "settings.web.save":
                self.ok(
                    rid,
                    save_web_search_settings(
                        Path.cwd().resolve(),
                        tavily_api_key=(
                            params.get("tavily_api_key")
                            if isinstance(params.get("tavily_api_key"), str)
                            else None
                        ),
                        anysearch_api_key=(
                            params.get("anysearch_api_key")
                            if isinstance(params.get("anysearch_api_key"), str)
                            else None
                        ),
                        clear_tavily=bool(params.get("clear_tavily")),
                        clear_anysearch=bool(params.get("clear_anysearch")),
                    ),
                )
            elif method == "settings.user.save":
                profile = params.get("profile")
                if not isinstance(profile, dict):
                    raise ValueError("User profile settings must be an object.")
                self.ok(rid, save_user_profile_settings(profile))
            elif method == "trace.serve":
                _server, url = start_trace_server(port=0)
                self.ok(rid, {"url": url})
            elif method == "session.reset":
                removed = self.session.reset(include_user=bool(params.get("global")))
                self.ok(rid, {"removed": [str(path) for path in removed], "info": self.session_info()})
            elif method == "session.new":
                self.session = self._new_session()
                self.sessions[self.session.session_id] = self.session
                self.ok(rid, {"info": self.session_info(), "history": []})
            elif method == "session.current":
                self.ok(rid, {"info": self.session_info(), "history": session_history(self.session)})
            elif method == "session.compact":
                self.ok(rid, {"text": self.session.compact()})
            elif method == "session.resume":
                session_id = str(params.get("id") or "")
                live = self.sessions.get(session_id)
                if live is not None:
                    self.session = live
                    count = 0
                else:
                    self.session = self._new_session(session_id or None)
                    count = self.session.resume(session_id or None)
                    self.sessions[self.session.session_id] = self.session
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
                self.ok(rid, {"choices": self.session_choices()})
            elif method == "session.tree":
                self.ok(rid, session_tree(Path.cwd().resolve(), str(params.get("id") or self.session.session_id)))
            elif method == "session.fork":
                source_id = str(params.get("id") or self.session.session_id)
                if source_id in self.runs:
                    raise RuntimeError("Stop the running request before forking this session.")
                source = self.sessions.get(source_id)
                snapshot = fork_session(
                    Path.cwd().resolve(),
                    source_id,
                    int(params.get("message_index", -1)),
                    messages=source.context.get_messages() if source and source.context is not None else None,
                )
                self.session = self._new_session(str(snapshot["session_id"]))
                self.session.resume(str(snapshot["session_id"]))
                self.sessions[self.session.session_id] = self.session
                self.ok(
                    rid,
                    {
                        "history": session_history(self.session),
                        "info": self.session_info(),
                        "tree": session_tree(Path.cwd().resolve(), self.session.session_id),
                    },
                )
            elif method == "session.rename":
                session_id = str(params.get("id") or "")
                data = rename_session(Path.cwd().resolve(), session_id, str(params.get("title") or ""))
                self.ok(rid, {"id": session_id, "title": data["title"]})
            elif method == "session.delete":
                session_id = str(params.get("id") or "")
                subtree = session_subtree_ids(Path.cwd().resolve(), session_id)
                if not subtree and session_id in self.sessions:
                    subtree = [session_id]
                threads = []
                for deleted_id in subtree:
                    live = self.sessions.get(deleted_id)
                    if live is not None and deleted_id in self.runs:
                        live.cancel()
                        threads.append(self.runs[deleted_id])
                for thread in threads:
                    thread.join(5)
                if any(thread.is_alive() for thread in threads):
                    raise RuntimeError("A running command did not stop; the session was not deleted.")
                persisted = delete_session_tree(Path.cwd().resolve(), session_id)
                deleted = list(dict.fromkeys([*subtree, *persisted]))
                for deleted_id in deleted:
                    live = self.sessions.pop(deleted_id, None)
                    if live is not None:
                        live.cancel()
                if self.session.session_id in deleted:
                    self.session = self._new_session()
                    self.sessions[self.session.session_id] = self.session
                self.ok(
                    rid,
                    {
                        "deleted": deleted,
                        "info": self.session_info(),
                        "history": session_history(self.session),
                    },
                )
            elif method == "checkpoint.list":
                self.ok(rid, {"checkpoints": checkpoint_choices(Path.cwd().resolve(), limit=50)})
            elif method == "checkpoint.undo":
                if self.runs:
                    raise RuntimeError("Stop running requests before restoring a checkpoint.")
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
                if not outcome["continued"]:
                    self.event("approval.resolved", {"decision": "approve", "continued": False})
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
                if not outcome["continued"]:
                    self.event("approval.resolved", {"decision": "instruct", "continued": False})
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

    def run_chat(self, rid: Any, text: str, *, goal: bool = False, images: list[str] | None = None) -> None:
        session = self.session
        session_id = session.session_id
        if session_id in self.runs:
            self.err(rid, "This session already has a request in progress.")
            return
        self.run_labels[session_id] = text

        def work() -> None:
            try:
                kwargs: dict[str, Any] = {"images": images or []}
                if goal:
                    kwargs["goal"] = True
                result = session.chat(text, **kwargs)
                self.ok(rid, {"text": result.answer, "session_id": session_id})
            except TurnCancelled:
                self.session_event(session, "message.cancelled", {})
                self.ok(rid, {"cancelled": True, "session_id": session_id})
            except Exception as exc:
                self._finish_reasoning(session, error=True)
                self.err(rid, str(exc))
            finally:
                self.runs.pop(session_id, None)
                self.run_labels.pop(session_id, None)
                self.session_event(session, "session.updated", {"running": False})

        thread = threading.Thread(target=work, name=f"friday-{session_id}", daemon=True)
        self.runs[session_id] = thread
        if self.background:
            thread.start()
        else:
            work()

    def _turn_complete(self, session: FridaySession, result: Any) -> None:
        suspended = str(result.progress.get("status") or "") == "waiting"
        self.session_event(
            session,
            "message.suspended" if suspended else "message.complete",
            {
                "text": result.answer,
                "metrics": result.metrics,
                "progress": result.progress,
                "artifacts": result.artifacts,
                "fork_points": [] if suspended else fork_points(session),
                "verification": verification_status(result.verifications[-1]) if result.verifications else None,
            },
        )

    def session_choices(self) -> list[dict[str, Any]]:
        choices = resume_choices(limit=50)
        by_id = {str(choice["id"]): choice for choice in choices}
        for session_id in self.runs:
            if session_id in by_id:
                by_id[session_id]["running"] = True
                continue
            snapshot = read_session(session_path(Path.cwd().resolve(), session_id))
            if snapshot and snapshot.get("fork_parent"):
                continue
            choices.insert(
                0,
                {
                    "assistant": "",
                    "id": session_id,
                    "objective": "",
                    "running": True,
                    "status": "working",
                    "time": "",
                    "title": "",
                    "turns": "0",
                    "user": preview(self.run_labels.get(session_id, "New conversation")),
                },
            )
        return choices

    def session_info(self) -> dict[str, Any]:
        catalog = load_model_catalog(Path.cwd().resolve())
        config = load_model_config(Path.cwd().resolve(), profile_id=self.session.model_profile)
        profile = next(
            (item for item in catalog["profiles"] if item["id"] == config.profile_id),
            {},
        )
        session_id = self.session.session_id
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
            "running": session_id in self.runs,
            "tools": [tool.name for tool in build_tools(Path.cwd().resolve())],
        }

    def on_agent_event(self, event: AgentEvent, session: FridaySession | None = None) -> None:
        session = session or self.session
        session.raise_if_cancelled()
        reasoning_key = f"{session.session_id}:{event.run_id}:{event.step}"
        if event.type == "model.reasoning.delta":
            reasoning_id = self.reasoning_ids.get(reasoning_key)
            if reasoning_id is None:
                self.reasoning_seq += 1
                reasoning_id = f"reasoning-{self.reasoning_seq}"
                self.reasoning_ids[reasoning_key] = reasoning_id
            self.session_event(
                session,
                "reasoning.delta",
                {"id": reasoning_id, "text": str(event.data.get("content") or "")},
            )
        elif event.type == "model.response" and event.data.get("has_reasoning"):
            reasoning_id = self.reasoning_ids.pop(reasoning_key, None)
            if reasoning_id is not None:
                self.session_event(session, "reasoning.complete", {"id": reasoning_id})
        elif event.type == "verification.start":
            self.session_event(session, "verification.start", {})
        elif event.type == "progress.updated":
            self.session_event(session, "progress.update", dict(event.data))
        elif event.type == "tool.call":
            call_id = str(event.data.get("tool_call_id") or "")
            name = str(event.data.get("name") or "")
            if call_id:
                self.tool_names[f"{session.session_id}:{call_id}"] = name
            self.session_event(
                session,
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
            self.session_event(
                session,
                "tool.complete",
                {
                    "tool_call_id": call_id,
                    "name": self.tool_names.pop(f"{session.session_id}:{call_id}", ""),
                    "error": bool(event.data.get("is_error")),
                    "content": content,
                    "approval": approval,
                },
            )
        elif event.type == "approval.pending":
            self.session_event(session, "approval.pending", dict(event.data))
        elif event.type == "approval.resolved":
            self.session_event(session, "approval.resolved", dict(event.data))

    def _finish_reasoning(self, session: FridaySession, *, error: bool = False) -> None:
        prefix = f"{session.session_id}:"
        for key, reasoning_id in list(self.reasoning_ids.items()):
            if key.startswith(prefix):
                self.session_event(session, "reasoning.complete", {"id": reasoning_id, "error": error})
                self.reasoning_ids.pop(key, None)

    def session_event(self, session: FridaySession, event_type: str, payload: dict[str, Any]) -> None:
        self.event(event_type, {**payload, "session_id": session.session_id})

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
    assistant_index = -1
    snapshot = read_session(session_path(Path.cwd().resolve(), session.session_id)) or {}
    records = snapshot.get("artifacts", []) if isinstance(snapshot.get("artifacts"), list) else []
    artifacts = {
        int(record["message_index"]): record["items"]
        for record in records
        if isinstance(record, dict)
        and isinstance(record.get("message_index"), int)
        and isinstance(record.get("items"), list)
    }

    def flush_assistant() -> None:
        nonlocal assistant_index
        if assistant_parts:
            item = {"kind": "assistant", "message_index": assistant_index, "text": "\n\n".join(assistant_parts)}
            if assistant_index in artifacts:
                item["artifacts"] = artifacts[assistant_index]
            history.append(item)
            assistant_parts.clear()
            assistant_index = -1

    for message_index, message in enumerate(conversation_body(session.context.get_messages())):
        role = message.get("role")
        content = _message_text(message.get("content"))
        if role == "user" and content and not message.get("friday_internal"):
            flush_assistant()
            history.append(
                {
                    "images": _message_images(message.get("content")),
                    "kind": "user",
                    "message_index": message_index,
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
                        "message_index": message_index,
                        "name": str(function.get("name") or "Tool"),
                        "status": "running",
                        "text": "",
                        "tool_call_id": call_id,
                    }
                )
            if content:
                assistant_parts.append(content)
                assistant_index = message_index
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
                        "message_index": message_index,
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


def fork_points(session: FridaySession) -> list[dict[str, Any]]:
    return [
        {"kind": item["kind"], "message_index": item["message_index"]}
        for item in session_history(session)
        if item["kind"] == "assistant" and "message_index" in item
    ]


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


def artifact_detail(workspace: Path, relative: str) -> dict[str, Any]:
    candidate = Path(relative)
    if not relative or candidate.is_absolute():
        raise ValueError("Artifact path must be relative to the workspace.")
    root = workspace.resolve()
    path = (root / candidate).resolve()
    if root not in path.parents or not path.is_file():
        raise ValueError("Artifact is outside the workspace or no longer exists.")
    kind = ARTIFACT_TYPES.get(path.suffix.lower())
    if not kind:
        raise ValueError("This artifact type cannot be previewed safely.")
    size = path.stat().st_size
    if size > _MAX_ARTIFACT_BYTES:
        raise ValueError("Artifact is too large to preview (25 MB limit).")
    data = path.read_bytes()
    result = {"kind": kind, "name": path.name, "path": path.relative_to(root).as_posix(), "size": size}
    if kind in {"markdown", "text"}:
        result["content"] = data.decode("utf-8", errors="replace")
    else:
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        result["data_url"] = f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"
    return result


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
