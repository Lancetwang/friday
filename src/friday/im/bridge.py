from __future__ import annotations

import json
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator, Protocol

from friday.im.gateway_client import GatewayClient, GatewayError
from friday.storage import project_state_dir

TURN_TIMEOUT_SECONDS = 1800.0
PROGRESS_NOTICE_SECONDS = 30.0
CANCEL_WORDS = {"/cancel", "/stop"}
YES_WORDS = {"y", "yes", "ok", "approve", "/approve"}
NO_WORDS = {"n", "no", "reject", "deny", "/reject"}

HELP = """Friday commands
/new - start a fresh conversation for this chat
/goal <text> - run a verified goal loop
/cancel - stop the running turn
/status - show model, workspace, and progress
/help - show this message

While a command waits for approval, reply y to run it, n to refuse,
or send any other text as an instruction for what to do instead."""


class Stream(Protocol):
    """One reply that keeps being revised while Friday is still writing it.

    The gateway reports text on its reader thread, so every method here has to
    return without waiting on the network; implementations buffer and let their
    own thread do the talking.
    """

    def push(self, body: str) -> None:
        """Show the answer as written so far."""

    def status(self, note: str) -> None:
        """Say what Friday is doing while no new text is arriving."""

    def close(self, body: str) -> None:
        """Settle on a final body and stop revising."""


OpenStream = Callable[[str], "Stream | None"]


class FridayBridge:
    """Drives one Friday workspace from IM messages.

    Turns run one at a time: the gateway keeps a single selected session and
    `chat.send` targets whatever `session.resume` last chose, so overlapping
    turns from two chats would cross wires. `/cancel` deliberately skips the
    lock, since a stuck turn is exactly when a user needs it.
    """

    def __init__(
        self,
        client: GatewayClient,
        reply: Callable[[str, str], None],
        *,
        workspace: Path | None = None,
        turn_timeout: float = TURN_TIMEOUT_SECONDS,
        progress_notice_seconds: float = PROGRESS_NOTICE_SECONDS,
        open_stream: OpenStream | None = None,
    ) -> None:
        self.client = client
        self.reply = reply
        self.turn_timeout = turn_timeout
        self.progress_notice_seconds = progress_notice_seconds
        self.open_stream = open_stream
        self._state_path = project_state_dir(workspace or client.workspace) / "im" / "chats.json"
        self._sessions: dict[str, str] = self._load()
        self._awaiting: dict[str, dict[str, Any]] = {}
        self._last_tool = ""
        self._lock = threading.Lock()
        self._stream: Stream | None = None
        self._parts: list[str] = []
        self._stream_lock = threading.Lock()

    def on_event(self, event_type: str, payload: dict[str, Any]) -> None:
        if event_type == "tool.start":
            self._last_tool = str(payload.get("name") or "")
            self._note_status(f"Running {self._last_tool}...")
        elif event_type == "message.delta":
            self._append_delta(str(payload.get("text") or ""))

    def _append_delta(self, chunk: str) -> None:
        if not chunk:
            return
        with self._stream_lock:
            stream = self._stream
            if stream is None:
                return
            self._parts.append(chunk)
            body = "".join(self._parts)
        stream.push(body)

    def _note_status(self, note: str) -> None:
        with self._stream_lock:
            stream = self._stream
        if stream is not None:
            stream.status(note)

    @contextmanager
    def _streaming(self, chat_key: str) -> Iterator[Stream | None]:
        """Route this turn's text into a live message, when the platform has one."""
        stream = self.open_stream(chat_key) if self.open_stream is not None else None
        with self._stream_lock:
            self._stream, self._parts = stream, []
        try:
            yield stream
        finally:
            with self._stream_lock:
                self._stream, self._parts = None, []

    def handle(self, chat_key: str, text: str) -> None:
        text = text.strip()
        if not text:
            return
        try:
            if text.lower() in CANCEL_WORDS:
                self._cancel(chat_key)
                return
            with self._lock:
                self._dispatch(chat_key, text)
        except GatewayError as exc:
            self.reply(chat_key, f"Friday gateway error: {exc}")

    def _dispatch(self, chat_key: str, text: str) -> None:
        if chat_key in self._awaiting:
            self._resolve_approval(chat_key, text)
            return
        lowered = text.lower()
        if lowered in {"/help", "help", "/?"}:
            self.reply(chat_key, HELP)
            return
        if lowered == "/new":
            self._bind(chat_key, self._new_session())
            self.reply(chat_key, "Started a new conversation.")
            return
        if lowered == "/status":
            self._activate(chat_key)
            self.reply(chat_key, self._status())
            return
        if lowered.startswith("/goal"):
            goal = text[len("/goal") :].strip()
            if not goal:
                self.reply(chat_key, "Send the goal after /goal.")
                return
            self._run_turn(chat_key, goal, goal_mode=True)
            return
        self._run_turn(chat_key, text, goal_mode=False)

    def _run_turn(self, chat_key: str, text: str, *, goal_mode: bool) -> None:
        self._activate(chat_key)
        self._last_tool = ""
        with self._streaming(chat_key) as stream:
            stop = self._progress_notice(chat_key) if stream is None else None
            try:
                result = self.client.request(
                    "goal.run" if goal_mode else "chat.send",
                    {"text": text},
                    timeout=self.turn_timeout,
                )
            except BaseException:
                # Leaving a live message mid-stream would look like a hang.
                if stream is not None:
                    stream.close("Friday stopped before it finished answering.")
                raise
            finally:
                if stop is not None:
                    stop.set()
            self._deliver(chat_key, result, stream=stream)
        self._check_approval(chat_key)

    def _resolve_approval(self, chat_key: str, text: str) -> None:
        self._awaiting.pop(chat_key, None)
        self._activate(chat_key)
        lowered = text.lower()
        with self._streaming(chat_key) as stream:
            stop = self._progress_notice(chat_key) if stream is None else None
            try:
                if lowered in YES_WORDS:
                    result = self.client.request("approval.approve", {}, timeout=self.turn_timeout)
                elif lowered in NO_WORDS:
                    result = self.client.request("approval.reject", {}, timeout=self.turn_timeout)
                else:
                    result = self.client.request("approval.instruct", {"text": text}, timeout=self.turn_timeout)
            except BaseException:
                if stream is not None:
                    stream.close("Friday stopped before it finished answering.")
                raise
            finally:
                if stop is not None:
                    stop.set()
            self._deliver(chat_key, result, fallback="Approval recorded.", stream=stream)
        self._check_approval(chat_key)

    def _deliver(self, chat_key: str, result: Any, *, fallback: str = "", stream: Stream | None = None) -> None:
        data = result if isinstance(result, dict) else {}
        message = data.get("message")
        text = str(data.get("text") or (message or {}).get("text") or "").strip()
        if data.get("cancelled"):
            text, fallback = "", "Cancelled."
        if stream is not None:
            stream.close(text or fallback)
            return
        if text:
            self.reply(chat_key, text)
        elif fallback:
            self.reply(chat_key, fallback)

    def _check_approval(self, chat_key: str) -> None:
        approval = self.client.request("approval.pending") or {}
        if not isinstance(approval, dict) or not approval.get("pending"):
            self._awaiting.pop(chat_key, None)
            return
        self._awaiting[chat_key] = approval
        reason = str(approval.get("reason") or "").strip()
        lines = [
            "Approval needed before Friday runs this command:",
            str(approval.get("command") or ""),
        ]
        if reason:
            lines.append(f"Reason: {reason}")
        lines.append("Reply y to run it, n to refuse, or send an instruction instead.")
        self.reply(chat_key, "\n".join(lines))

    def _cancel(self, chat_key: str) -> None:
        session_id = self._sessions.get(chat_key)
        result = self.client.request("chat.cancel", {"session_id": session_id} if session_id else {})
        cancelled = bool((result or {}).get("cancelled"))
        self.reply(chat_key, "Cancelled." if cancelled else "Nothing is running.")

    def _status(self) -> str:
        info = self.client.request("session.info") or {}
        progress = info.get("progress") if isinstance(info.get("progress"), dict) else {}
        lines = [
            f"Workspace: {info.get('cwd', '')}",
            f"Model: {info.get('model', '')}",
            f"Permissions: {info.get('permission_mode', '')}",
            f"Session: {info.get('session_id', '')}",
        ]
        objective = str((progress or {}).get("objective") or "").strip()
        if objective:
            lines.append(f"Objective: {objective}")
        return "\n".join(lines)

    def _activate(self, chat_key: str) -> str:
        session_id = self._sessions.get(chat_key)
        if session_id:
            try:
                result = self.client.request("session.resume", {"id": session_id})
                resumed = str(((result or {}).get("info") or {}).get("session_id") or "")
                if resumed:
                    self._bind(chat_key, resumed)
                    return resumed
            except GatewayError:
                # The snapshot is gone or unreadable; fall through to a new one
                # rather than leaving this chat permanently broken.
                pass
        session_id = self._new_session()
        self._bind(chat_key, session_id)
        return session_id

    def _new_session(self) -> str:
        result = self.client.request("session.new") or {}
        return str(((result or {}).get("info") or {}).get("session_id") or "")

    def _bind(self, chat_key: str, session_id: str) -> None:
        if not session_id or self._sessions.get(chat_key) == session_id:
            return
        self._sessions[chat_key] = session_id
        self._save()

    def _progress_notice(self, chat_key: str) -> threading.Event:
        stop = threading.Event()

        def loop() -> None:
            waited = 0.0
            while not stop.wait(self.progress_notice_seconds):
                waited += self.progress_notice_seconds
                tool = self._last_tool
                detail = f" ({tool})" if tool else ""
                self.reply(chat_key, f"Still working{detail}, {int(waited)}s so far. Send /cancel to stop.")

        if self.progress_notice_seconds > 0:
            threading.Thread(target=loop, name="friday-im-progress", daemon=True).start()
        return stop

    def _load(self) -> dict[str, str]:
        try:
            data = json.loads(self._state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        return {str(key): str(value) for key, value in data.items()} if isinstance(data, dict) else {}

    def _save(self) -> None:
        self._state_path.parent.mkdir(parents=True, exist_ok=True)
        temp = self._state_path.with_suffix(".tmp")
        temp.write_text(json.dumps(self._sessions, ensure_ascii=False, indent=2), encoding="utf-8")
        temp.replace(self._state_path)
