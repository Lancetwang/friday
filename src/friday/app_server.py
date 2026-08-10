from __future__ import annotations

import base64
import json
import os
import sys
import threading
import time
from pathlib import Path
from typing import Any

from agent_core import AgentEvent

from friday.app import ensure_user_home, resume_choices
from friday.checkpoint import ARTIFACT_TYPES, checkpoint_choices
from friday.child import cli_command
from friday.config import (
    clear_model_credential,
    delete_model_profile,
    load_feishu_settings,
    load_model_catalog,
    load_model_config,
    load_web_search_settings,
    read_feishu_credential,
    read_model_credential,
    read_web_search_credential,
    refresh_model_profiles,
    save_feishu_settings,
    save_model_profile,
    save_web_search_settings,
    select_model_profile,
    set_model_enabled,
)
from friday.context import context_report
from friday.im.bridge import phone_sessions
from friday.im.supervisor import BridgeSupervisor
from friday.memory import (
    format_memory_result,
    load_user_profile_settings,
    read_memory_file,
    run_memory_command,
    save_memory_file,
    save_user_profile_settings,
)
from friday.model_options import normalize_thinking_effort, thinking_options
from friday.session import FridaySession
from friday.skills import discover_skills, skill_body
from friday.state import (
    USER_MESSAGE_TIMES_KEY,
    conversation_body,
    delete_session_tree,
    records_by_message,
    transcript_messages,
    fork_session,
    read_session,
    rename_session,
    session_path,
    session_subtree_ids,
    session_tree,
)
from friday.storage import close_project, friday_home, list_projects, record_project
from friday.text import preview
from friday.tools import build_tools, pending_approval
from friday.trace_web import start_trace_server, stop_trace_server
from friday.turn import TurnCancelled

_write_lock = threading.Lock()
_IMAGE_PREFIXES = ("data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,", "data:image/gif;base64,")
_MAX_IMAGE_CHARS = 14_000_000
_MAX_TOTAL_IMAGE_CHARS = 20_000_000
_MAX_LOCAL_ATTACHMENTS = 8
_MAX_ARTIFACT_BYTES = 25_000_000
_ARTIFACT_MIMES = {
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".webp": "image/webp",
}
# Each cached session pins an agent and its full message history, so idle ones
# are dropped; their state lives on disk and `session.resume` rebuilds them.
_MAX_CACHED_SESSIONS = 8


def main() -> None:
    if sys.argv[1:2] == ["--cli"]:
        from friday.cli import main as cli_main

        cli_main(sys.argv[2:])
        return
    _install_cli_shim()
    # A gateway exists for a workspace because the user opened that project, so
    # this is the one place that may declare it open. Everything else that
    # records a project (any agent build, including a CLI run) leaves the flag
    # alone, which is what keeps a closed project closed.
    record_project(Path.cwd().resolve(), opened=True)
    output = _Utf8Output(sys.stdout.buffer)
    sys.stdout = sys.stderr
    gateway = Gateway(output=output, background=True)
    gateway.event("gateway.ready", {"cwd": str(Path.cwd().resolve())})
    try:
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
    finally:
        # These servers belong to this client process, not to a conversation.
        gateway.bridge.stop()
        stop_trace_server()


def _install_cli_shim() -> Path:
    directory = friday_home() / "bin"
    directory.mkdir(parents=True, exist_ok=True)
    executable, *prefix = cli_command()
    args = " ".join(prefix)
    if os.name == "nt":
        path = directory / "friday.cmd"
        content = f'@"{executable}" {args} %*\n'
    else:
        path = directory / "friday"
        content = f'#!/bin/sh\nexec "{executable}" {args} "$@"\n'
    if not path.exists() or path.read_text(encoding="utf-8") != content:
        path.write_text(content, encoding="utf-8")
        if os.name != "nt":
            path.chmod(0o755)
    if str(directory) not in os.environ.get("PATH", "").split(os.pathsep):
        os.environ["PATH"] = os.pathsep.join([str(directory), os.environ.get("PATH", "")])
    return path


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
    status = {
        key: result[key]
        for key in ("approval_required", "error", "passed", "verdict")
        if key in result
    }
    # The UI only shows a label for the four keys above; carry the verifier's
    # feedback along (truncated) so failures are not a silent "error".
    feedback = result.get("feedback")
    if isinstance(feedback, str) and feedback.strip():
        status["feedback"] = feedback.strip()[:400]
    return status


class Gateway:
    """JSON-RPC view over live Friday sessions in one workspace."""

    def __init__(self, output=None, *, background: bool = False) -> None:
        self.output = output or sys.stdout
        self.background = background
        self.reasoning_ids: dict[str, str] = {}
        self.reasoning_started: dict[str, float] = {}
        self.reasoning_seq = 0
        self.tool_names: dict[str, str] = {}
        self.tool_started: dict[str, float] = {}
        self.sessions: dict[str, FridaySession] = {}
        self.runs: dict[str, threading.Thread] = {}
        self.run_labels: dict[str, str] = {}
        # The mode the user last chose in this window. It seeds new conversations so the
        # choice is not silently forgotten, but never reaches a resumed or running
        # session, which keeps its own policy.
        self.permission_mode: str | None = None
        # Worker threads and their event callbacks touch the maps above while the
        # RPC thread reads them; every access goes through this lock.
        self._state = threading.RLock()
        # The phone bridge belongs to this gateway, not to a session: one switch
        # covers the whole workspace, and closing Friday takes the phone offline.
        self.bridge = BridgeSupervisor()
        self.session = self._new_session()
        self._track(self.session)

    def _track(self, session: FridaySession) -> None:
        """Cache a session as the most recently used and evict idle extras."""
        with self._state:
            self.sessions.pop(session.session_id, None)
            self.sessions[session.session_id] = session
            for session_id in list(self.sessions)[:-_MAX_CACHED_SESSIONS]:
                if session_id != session.session_id and session_id not in self.runs:
                    self._release(self.sessions.pop(session_id))

    @staticmethod
    def _release(session: FridaySession) -> None:
        session.agent = None
        session.context = None

    def _new_session(self, session_id: str | None = None) -> FridaySession:
        session = FridaySession(stream=True, session_id=session_id)
        if self.permission_mode is not None:
            session.select_permission_mode(self.permission_mode)
        session.on_delta = lambda chunk: self.session_event(session, "message.delta", {"text": chunk})
        session.on_verify = lambda verification: self.session_event(
            session, "verification.complete", verification_status(verification)
        )
        session.on_event = lambda event: self.on_agent_event(event, session)
        session.on_turn_start = lambda text: self.session_event(session, "message.start", {"text": text})
        session.on_turn_complete = lambda result: self._turn_complete(session, result)
        return session

    def _cached_session(self, session_id: str) -> FridaySession | None:
        with self._state:
            return self.sessions.get(session_id)

    def _resume_session(self, session_id: str) -> int:
        live = self._cached_session(session_id)
        if live is not None and live.context is not None:
            self.session = live
            count = 0
        else:
            self.session = self._new_session(session_id or None)
            count = self.session.resume(session_id or None)
        self._track(self.session)
        return count

    def _is_running(self, session_id: str) -> bool:
        with self._state:
            return session_id in self.runs

    def _any_running(self) -> bool:
        with self._state:
            return bool(self.runs)

    def _running_labels(self) -> list[tuple[str, str]]:
        with self._state:
            return [(session_id, self.run_labels.get(session_id, "")) for session_id in self.runs]

    def _reasoning_id(self, key: str) -> str:
        with self._state:
            reasoning_id = self.reasoning_ids.get(key)
            if reasoning_id is None:
                self.reasoning_seq += 1
                reasoning_id = f"reasoning-{self.reasoning_seq}"
                self.reasoning_ids[key] = reasoning_id
                self.reasoning_started[key] = time.monotonic()
            return reasoning_id

    def _pop_reasoning_id(self, key: str) -> tuple[str | None, int | None]:
        with self._state:
            reasoning_id = self.reasoning_ids.pop(key, None)
            started = self.reasoning_started.pop(key, None)
        elapsed_ms = int((time.monotonic() - started) * 1000) if started is not None else None
        return reasoning_id, elapsed_ms

    def handle(self, msg: dict[str, Any]) -> None:
        rid = msg.get("id")
        method = msg.get("method")
        params = msg.get("params") or {}
        try:
            if method == "session.info":
                self.ok(rid, self.session_info())
            elif method == "projects.list":
                # The sidebar restores what the user left open, not every
                # workspace Friday has ever run in.
                self.ok(rid, {"projects": list_projects(open_only=True)})
            elif method == "projects.close":
                workspace = str(params.get("workspace") or "").strip()
                if workspace:
                    close_project(Path(workspace))
                self.ok(rid, {"closed": bool(workspace)})
            elif method == "chat.send":
                images = _image_urls(params.get("images"))
                attachments = _local_attachments(params.get("attachments"))
                self.run_chat(rid, str(params.get("text") or ""), images=images, attachments=attachments)
            elif method == "goal.run":
                images = _image_urls(params.get("images"))
                attachments = _local_attachments(params.get("attachments"))
                self.run_chat(
                    rid,
                    str(params.get("text") or ""),
                    goal=True,
                    images=images,
                    attachments=attachments,
                )
            elif method == "chat.cancel":
                session_id = str(params.get("session_id") or self.session.session_id)
                session = self._cached_session(session_id)
                if session is None or not self._is_running(session_id):
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
                ensure_user_home()
                self.ok(rid, {"skills": discover_skills(Path.cwd().resolve(), friday_home())})
            elif method == "skill.get":
                ensure_user_home()
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
                mode = self.session.select_permission_mode(str(params.get("mode") or ""))
                self.permission_mode = mode
                self.ok(rid, {"permission_mode": mode, "session_id": self.session.session_id})
            elif method == "thinking.set":
                effort = self.session.select_thinking(str(params.get("effort") or ""))
                self.ok(rid, {"thinking_effort": effort, "info": self.session_info()})
            elif method == "model.list":
                catalog = load_model_catalog(Path.cwd().resolve())
                catalog["profiles"] = [
                    {
                        **profile,
                        "thinking_options": list(
                            thinking_options(str(profile["provider"]), str(profile["model"]))
                        ),
                    }
                    for profile in catalog["profiles"]
                ]
                self.ok(rid, catalog)
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
                enabled = {profile["id"] for profile in catalog["profiles"] if profile.get("enabled")}
                if bool(params.get("activate", True)) or self.session.model_profile not in enabled:
                    self.session.select_model(catalog["active"])
                self.ok(rid, {"catalog": catalog, "info": self.session_info()})
            elif method == "model.key.get":
                self.ok(
                    rid,
                    {
                        "api_key": read_model_credential(
                            Path.cwd().resolve(),
                            provider_id=str(params.get("provider") or ""),
                            profile_id=str(params.get("profile") or ""),
                        )
                    },
                )
            elif method == "model.key.clear":
                catalog = clear_model_credential(
                    Path.cwd().resolve(),
                    provider_id=str(params.get("provider") or ""),
                    profile_id=str(params.get("profile") or ""),
                )
                enabled = {profile["id"] for profile in catalog["profiles"] if profile.get("enabled")}
                if self.session.model_profile not in enabled:
                    self.session.select_model(catalog["active"])
                self.ok(rid, {"catalog": catalog, "info": self.session_info()})
            elif method == "model.refresh":
                catalog, models = refresh_model_profiles(
                    Path.cwd().resolve(),
                    provider_id=str(params.get("provider") or ""),
                    profile_id=str(params.get("profile") or ""),
                )
                enabled = {profile["id"] for profile in catalog["profiles"] if profile.get("enabled")}
                if self.session.model_profile not in enabled:
                    self.session.select_model(catalog["active"])
                self.ok(rid, {"catalog": catalog, "info": self.session_info(), "models": models})
            elif method == "model.enabled.set":
                catalog = set_model_enabled(
                    Path.cwd().resolve(),
                    bool(params.get("enabled")),
                    provider_id=str(params.get("provider") or ""),
                    profile_id=str(params.get("profile") or ""),
                )
                enabled = {profile["id"] for profile in catalog["profiles"] if profile.get("enabled")}
                if self.session.model_profile not in enabled:
                    self.session.select_model(catalog["active"])
                self.ok(rid, {"catalog": catalog, "info": self.session_info()})
            elif method == "model.select":
                profile_id = str(params.get("id") or "")
                catalog = select_model_profile(Path.cwd().resolve(), profile_id)
                self.session.select_model(profile_id)
                self.ok(rid, {"catalog": catalog, "info": self.session_info()})
            elif method == "model.delete":
                catalog = delete_model_profile(Path.cwd().resolve(), str(params.get("id") or ""))
                if self.session.model_profile not in {
                    profile["id"] for profile in catalog["profiles"] if profile.get("enabled")
                }:
                    self.session.select_model(catalog["active"])
                self.ok(rid, {"catalog": catalog, "info": self.session_info()})
            elif method == "settings.get":
                self.ok(
                    rid,
                    {
                        "memory_files": {
                            scope: {
                                key: value
                                for key, value in read_memory_file(scope).items()
                                if key != "content"
                            }
                            for scope in ("user", "global")
                        },
                        "web_search": load_web_search_settings(),
                        "user_profile": load_user_profile_settings(),
                        "feishu": load_feishu_settings(),
                        "bridge": self.bridge.status(),
                    },
                )
            elif method == "settings.web.key.get":
                self.ok(
                    rid,
                    {"api_key": read_web_search_credential(str(params.get("provider") or ""))},
                )
            elif method == "settings.web.get":
                self.ok(rid, load_web_search_settings())
            elif method == "settings.feishu.key.get":
                self.ok(rid, {"app_secret": read_feishu_credential()})
            elif method == "settings.memory.read":
                self.ok(rid, read_memory_file(str(params.get("file") or "")))
            elif method == "settings.memory.save":
                self.ok(
                    rid,
                    save_memory_file(str(params.get("file") or ""), params.get("content")),
                )
            elif method == "settings.web.save":
                self.ok(
                    rid,
                    save_web_search_settings(
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
            elif method == "settings.feishu.save":
                users = params.get("allowed_users")
                self.ok(
                    rid,
                    {
                        "feishu": save_feishu_settings(
                            app_id=params.get("app_id") if isinstance(params.get("app_id"), str) else None,
                            app_secret=(
                                params.get("app_secret") if isinstance(params.get("app_secret"), str) else None
                            ),
                            allowed_users=users if isinstance(users, (list, str)) else None,
                            allow_group=(
                                bool(params.get("allow_group")) if params.get("allow_group") is not None else None
                            ),
                            clear_app_secret=bool(params.get("clear_app_secret")),
                        ),
                        "bridge": self.bridge.status(),
                    },
                )
            elif method == "bridge.status":
                self.ok(rid, self.bridge.status())
            elif method == "bridge.sessions":
                self.ok(rid, {"choices": phone_sessions(Path.cwd().resolve())})
            elif method == "bridge.start":
                self.ok(rid, self.bridge.start(Path.cwd().resolve()))
            elif method == "bridge.stop":
                self.ok(rid, self.bridge.stop())
            elif method == "settings.user.save":
                profile = params.get("profile")
                if not isinstance(profile, dict):
                    raise ValueError("User profile settings must be an object.")
                self.ok(rid, save_user_profile_settings(profile))
            elif method == "trace.serve":
                # The UI opens the URL itself: this process is a bundled sidecar, and a
                # browser launched from here fails silently when it cannot find one.
                _server, url = start_trace_server(port=0, open_browser=False)
                self.ok(rid, {"url": url})
            elif method == "trace.stop":
                self.ok(rid, {"stopped": stop_trace_server()})
            elif method == "session.reset":
                removed = self.session.reset(include_user=bool(params.get("global")))
                self.ok(rid, {"removed": [str(path) for path in removed], "info": self.session_info()})
            elif method == "session.new":
                self.session = self._new_session()
                self._track(self.session)
                self.ok(rid, {"info": self.session_info(), "history": []})
            elif method == "session.current":
                self.ok(rid, {"info": self.session_info(), "history": session_history(self.session)})
            elif method == "session.compact":
                self.ok(rid, {"text": self.session.compact()})
            elif method == "session.resume":
                session_id = str(params.get("id") or "")
                count = self._resume_session(session_id)
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
                if self._is_running(source_id):
                    raise RuntimeError("Stop the running request before forking this session.")
                source = self._cached_session(source_id)
                source_messages = transcript_messages(source.context) if source and source.context is not None else None
                message_index = params.get("message_index")
                if message_index is None:
                    points = fork_points(source) if source is not None else []
                    if not points:
                        snapshot = read_session(session_path(Path.cwd().resolve(), source_id)) or {}
                        body = conversation_body(snapshot.get("messages", []))
                        points = [
                            {"message_index": index}
                            for index, message in enumerate(body)
                            if message.get("role") == "assistant"
                        ]
                    if not points:
                        raise ValueError("This conversation has no assistant response to fork from.")
                    message_index = points[-1]["message_index"]
                snapshot = fork_session(
                    Path.cwd().resolve(),
                    source_id,
                    int(message_index),
                    # Fork points are indices into the transcript, so fork from it.
                    messages=source_messages,
                )
                self._resume_session(str(snapshot["session_id"]))
                self.ok(
                    rid,
                    {
                        "history": session_history(self.session),
                        "info": self.session_info(),
                        "tree": session_tree(Path.cwd().resolve(), self.session.session_id),
                    },
                )
            elif method == "session.backward":
                tree = session_tree(Path.cwd().resolve(), self.session.session_id)
                current = next(
                    (node for node in tree.get("nodes", []) if node.get("id") == self.session.session_id),
                    None,
                )
                parent = str(current.get("parent") or "") if isinstance(current, dict) else ""
                if not parent:
                    raise ValueError("This conversation is already at the root branch.")
                self._resume_session(parent)
                self.ok(
                    rid,
                    {
                        "history": session_history(self.session),
                        "info": self.session_info(),
                        "progress": self.session.progress(),
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
                with self._state:
                    if not subtree and session_id in self.sessions:
                        subtree = [session_id]
                    threads = []
                    for deleted_id in subtree:
                        if self.sessions.get(deleted_id) is not None and deleted_id in self.runs:
                            self.sessions[deleted_id].cancel()
                            threads.append(self.runs[deleted_id])
                for thread in threads:
                    thread.join(5)
                if any(thread.is_alive() for thread in threads):
                    raise RuntimeError("A running command did not stop; the session was not deleted.")
                persisted = delete_session_tree(Path.cwd().resolve(), session_id)
                deleted = list(dict.fromkeys([*subtree, *persisted]))
                with self._state:
                    for deleted_id in deleted:
                        live = self.sessions.pop(deleted_id, None)
                        if live is not None:
                            live.cancel()
                if self.session.session_id in deleted:
                    self.session = self._new_session()
                    self._track(self.session)
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
                if self._any_running():
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
                self.ok(rid, pending_approval(session_id=self.session.session_id))
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
            with self._state:
                orphaned = list(self.reasoning_ids.values())
                self.reasoning_ids.clear()
                self.reasoning_started.clear()
            for reasoning_id in orphaned:
                self.event("reasoning.complete", {"id": reasoning_id, "error": True})
            self.err(rid, str(exc))

    def run_chat(
        self,
        rid: Any,
        text: str,
        *,
        goal: bool = False,
        images: list[str] | None = None,
        attachments: list[dict[str, Any]] | None = None,
    ) -> None:
        session = self.session
        session_id = session.session_id
        with self._state:
            if session_id in self.runs:
                self.err(rid, "This session already has a request in progress.")
                return
            self.run_labels[session_id] = text

        def work() -> None:
            try:
                kwargs: dict[str, Any] = {"images": images or []}
                if attachments:
                    kwargs["attachments"] = attachments
                if goal:
                    kwargs["goal"] = True
                result = session.chat(text, **kwargs)
                self.ok(rid, {"text": result.answer, "session_id": session_id})
            except TurnCancelled:
                self.session_event(session, "message.cancelled", {})
                self.ok(rid, {"cancelled": True, "session_id": session_id})
            except Exception as exc:
                self.err(rid, str(exc))
            finally:
                # Close any reasoning block the run left open, whatever the
                # outcome, so the streams do not accumulate across turns.
                self._finish_reasoning(session)
                self._forget_tool_names(session)
                with self._state:
                    self.runs.pop(session_id, None)
                    self.run_labels.pop(session_id, None)
                self.session_event(session, "session.updated", {"running": False})

        thread = threading.Thread(target=work, name=f"friday-{session_id}", daemon=True)
        with self._state:
            self.runs[session_id] = thread
        # A session reaches the sidebar by being saved, and it is only saved once
        # a turn finishes -- so a conversation the user just started showed no
        # trace of itself until the reply landed, with no way to tell whether it
        # had been created at all. Announcing the run puts it in the list now:
        # `session_choices` lists a running session whether or not it is on disk.
        self.session_event(session, "session.updated", {"running": True})
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
                # Why the turn ended. A guard stop reads as an ordinary answer
                # otherwise, and the user has no way to tell it was cut short.
                "status": str(result.context.metadata.get("friday.loop_status") or "done"),
                "artifacts": result.artifacts,
                "fork_points": [] if suspended else fork_points(session),
                "verification": verification_status(result.verifications[-1]) if result.verifications else None,
            },
        )

    def session_choices(self) -> list[dict[str, Any]]:
        choices = resume_choices(limit=50)
        by_id = {str(choice["id"]): choice for choice in choices}
        for session_id, label in self._running_labels():
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
                    "user": preview(label or "New conversation"),
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
        options = thinking_options(config.provider, config.model)
        effort = normalize_thinking_effort(
            config.provider, config.model, self.session.thinking_effort
        )
        return {
            "cwd": str(Path.cwd().resolve()),
            "model": f"{config.provider}/{config.model}",
            "model_configured": bool(profile.get("api_key_configured")),
            "model_name": config.profile_name,
            "model_profile": config.profile_id,
            "model_vision": config.vision,
            "thinking_effort": effort,
            "thinking_options": list(options),
            "thinking_supported": len(options) > 1,
            "permission_mode": self.session.effective_permission_mode(),
            "progress": self.session.progress(),
            "approval": pending_approval(session_id=session_id),
            "session_id": session_id,
            "running": self._is_running(session_id),
            "tools": [tool.name for tool in build_tools(Path.cwd().resolve())],
        }

    def on_agent_event(self, event: AgentEvent, session: FridaySession | None = None) -> None:
        session = session or self.session
        session.raise_if_cancelled()
        reasoning_key = f"{session.session_id}:{event.run_id}:{event.step}"
        if event.type == "model.reasoning.delta":
            self.session_event(
                session,
                "reasoning.delta",
                {"id": self._reasoning_id(reasoning_key), "text": str(event.data.get("content") or "")},
            )
        elif event.type == "model.response" and event.data.get("has_reasoning"):
            reasoning_id, elapsed_ms = self._pop_reasoning_id(reasoning_key)
            if reasoning_id is not None:
                self.session_event(
                    session,
                    "reasoning.complete",
                    {"id": reasoning_id, "elapsed_ms": elapsed_ms},
                )
        elif event.type == "verification.start":
            self.session_event(session, "verification.start", {})
        elif event.type == "context.compacted":
            self.session_event(session, "context.compacted", dict(event.data))
        elif event.type == "progress.updated":
            self.session_event(session, "progress.update", dict(event.data))
        elif event.type == "tool.call":
            call_id = str(event.data.get("tool_call_id") or "")
            name = str(event.data.get("name") or "")
            if call_id:
                with self._state:
                    self.tool_names[f"{session.session_id}:{call_id}"] = name
                    self.tool_started[f"{session.session_id}:{call_id}"] = time.monotonic()
            self.session_event(
                session,
                "tool.start",
                {
                    "tool_call_id": call_id,
                    "name": name,
                    "arguments": event.data.get("arguments", {}),
                },
            )
        elif event.type == "tool.progress":
            self.session_event(
                session,
                "tool.update",
                {
                    "tool_call_id": str(event.data.get("tool_call_id") or ""),
                    "name": str(event.data.get("name") or ""),
                    "content": str(event.data.get("content") or ""),
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
            with self._state:
                tool_name = self.tool_names.pop(f"{session.session_id}:{call_id}", "")
                started = self.tool_started.pop(f"{session.session_id}:{call_id}", None)
            # Prefer the executor-measured time: it stays accurate when the
            # batch runs concurrently, where the event gap includes waiting.
            measured = event.data.get("elapsed_ms")
            if isinstance(measured, (int, float)):
                elapsed_ms = int(measured)
            else:
                elapsed_ms = int((time.monotonic() - started) * 1000) if started is not None else None
            self.session_event(
                session,
                "tool.complete",
                {
                    "tool_call_id": call_id,
                    "name": tool_name,
                    "elapsed_ms": elapsed_ms,
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
        with self._state:
            orphaned = [
                (
                    self.reasoning_ids.pop(key),
                    self.reasoning_started.pop(key, None),
                )
                for key in [key for key in self.reasoning_ids if key.startswith(prefix)]
            ]
        now = time.monotonic()
        for reasoning_id, started in orphaned:
            self.session_event(
                session,
                "reasoning.complete",
                {
                    "id": reasoning_id,
                    "elapsed_ms": int((now - started) * 1000) if started is not None else None,
                    "error": error,
                },
            )

    def _forget_tool_names(self, session: FridaySession) -> None:
        prefix = f"{session.session_id}:"
        with self._state:
            for key in [key for key in self.tool_names if key.startswith(prefix)]:
                del self.tool_names[key]
            for key in [key for key in self.tool_started if key.startswith(prefix)]:
                del self.tool_started[key]

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
    user_indexes: list[int] = []
    assistant_parts: list[str] = []
    assistant_index = -1
    snapshot = read_session(session_path(Path.cwd().resolve(), session.session_id)) or {}
    # The transcript, not the prompt: compaction rewrites what the model is sent,
    # and the user's scrollback must not shrink with it.
    transcript = transcript_messages(session.context)
    artifacts = records_by_message(snapshot.get("artifacts"), transcript)
    # What each reply cost, restored from disk. Held only in the live event it was
    # emitted with, it vanished the moment the conversation was reopened.
    metrics = records_by_message(snapshot.get("metrics"), transcript)
    activities = records_by_message(snapshot.get("activities"), transcript)
    tool_activity: dict[str, dict[str, Any]] = {}
    for record in activities.values():
        items = record.get("items")
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict) or item.get("kind") != "tool":
                continue
            call_id = str(item.get("tool_call_id") or "")
            if call_id:
                tool_activity[call_id] = item
    emitted_reasoning: set[int] = set()

    def append_reasoning(message_index: int) -> None:
        if message_index in emitted_reasoning:
            return
        emitted_reasoning.add(message_index)
        items = activities.get(message_index, {}).get("items")
        if not isinstance(items, list):
            return
        for item in items:
            if not isinstance(item, dict) or item.get("kind") != "reasoning":
                continue
            history.append(
                {
                    "elapsed_ms": item.get("elapsed_ms"),
                    "kind": "reasoning",
                    "message_index": message_index,
                    "status": str(item.get("status") or "done"),
                    "text": str(item.get("text") or ""),
                }
            )

    def flush_assistant() -> None:
        nonlocal assistant_index
        if assistant_parts:
            item = {"kind": "assistant", "message_index": assistant_index, "text": "\n\n".join(assistant_parts)}
            items = artifacts.get(assistant_index, {}).get("items")
            if isinstance(items, list):
                item["artifacts"] = items
            values = metrics.get(assistant_index, {}).get("values")
            if isinstance(values, dict):
                item["metrics"] = values
            history.append(item)
            assistant_parts.clear()
            assistant_index = -1

    for message_index, message in enumerate(transcript):
        role = message.get("role")
        content = _message_text(message.get("content"))
        if role == "user" and content and not message.get("friday_internal"):
            flush_assistant()
            user_indexes.append(len(history))
            history.append(
                {
                    "attachments": [],
                    "images": _message_images(message.get("content")),
                    "kind": "user",
                    "message_index": message_index,
                    "text": content,
                }
            )
        elif role == "assistant" and not message.get("friday_progress"):
            append_reasoning(message_index)
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
                item = {
                    "arguments": arguments,
                    "kind": "tool",
                    "message_index": message_index,
                    "name": str(function.get("name") or "Tool"),
                    "status": "running",
                    "text": "",
                    "tool_call_id": call_id,
                }
                timing = tool_activity.get(call_id)
                if timing:
                    item["elapsed_ms"] = timing.get("elapsed_ms")
                    item["status"] = str(timing.get("status") or item["status"])
                history.append(item)
            if content:
                assistant_parts.append(content)
                assistant_index = message_index
        elif role == "tool":
            call_id = str(message.get("tool_call_id") or "")
            index = tools.get(call_id)
            if index is not None:
                timing = tool_activity.get(call_id, {})
                history[index].update(
                    elapsed_ms=timing.get("elapsed_ms"),
                    status=str(timing.get("status") or "done"),
                    text=content,
                )
            else:
                timing = tool_activity.get(call_id, {})
                history.append(
                    {
                        "arguments": {},
                        "elapsed_ms": timing.get("elapsed_ms"),
                        "kind": "tool",
                        "message_index": message_index,
                        "name": "Tool",
                        "status": str(timing.get("status") or "done"),
                        "text": content,
                        "tool_call_id": call_id,
                    }
                )
    flush_assistant()
    # The desktop renders images from an LRU budget and only ever displays the
    # most recent ones, but the payload itself is shipped whole over IPC: older
    # attachments are dropped here so an image-heavy conversation does not
    # re-transfer megabytes every time it is resumed.
    for index in user_indexes[:-6]:
        if history[index].get("images"):
            history[index]["images"] = []
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
                attachments = record.get("attachments")
                if isinstance(attachments, list):
                    item["attachments"] = [dict(value) for value in attachments if isinstance(value, dict)]
                display_text = record.get("display_text")
                if isinstance(display_text, str):
                    item["text"] = display_text
                if record.get("goal") is True:
                    item["goal"] = True
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


def _local_attachments(value: Any) -> list[dict[str, Any]]:
    if value in (None, []):
        return []
    if not isinstance(value, list) or len(value) > _MAX_LOCAL_ATTACHMENTS:
        raise ValueError(f"Attach at most {_MAX_LOCAL_ATTACHMENTS} local files or folders.")
    attachments: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, dict):
            raise ValueError("Local attachments must be files or folders selected on this computer.")
        raw = Path(str(item.get("path") or ""))
        if not raw.is_absolute():
            raise ValueError("Local attachment paths must be absolute.")
        try:
            path = raw.resolve(strict=True)
        except (OSError, RuntimeError) as exc:
            raise ValueError(f"Attached item is unavailable: {raw}") from exc
        if not path.is_file() and not path.is_dir():
            raise ValueError(f"Attached item is not a file or folder: {path}")
        key = os.path.normcase(str(path))
        if key in seen:
            continue
        seen.add(key)
        attachment: dict[str, Any] = {
            "kind": "folder" if path.is_dir() else "file",
            "name": path.name or str(path),
            "path": str(path),
        }
        if path.is_file():
            attachment["size"] = path.stat().st_size
        attachments.append(attachment)
    return attachments


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
        # Deliberately not mimetypes.guess_type: that consults the OS registry, and a
        # data URL the UI hands to <img>/<iframe> must never be able to become text/html.
        mime = _ARTIFACT_MIMES.get(path.suffix.lower())
        if not mime:
            raise ValueError("This artifact type cannot be previewed safely.")
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
