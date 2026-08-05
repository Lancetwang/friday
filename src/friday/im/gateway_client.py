from __future__ import annotations

import json
import subprocess
import threading
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from friday.child import child_environment, gateway_command

_STDERR_TAIL = 20


class GatewayError(RuntimeError):
    """A gateway request failed, timed out, or the child process went away."""


@dataclass
class _Pending:
    done: threading.Event = field(default_factory=threading.Event)
    result: Any = None
    error: str | None = None


class GatewayClient:
    """JSON-RPC client over one `friday app-server` child process.

    The gateway answers `chat.send` only after the turn finishes, so callers
    size timeouts to the work rather than to the transport.
    """

    def __init__(
        self,
        workspace: Path,
        *,
        on_event: Callable[[str, dict[str, Any]], None] | None = None,
        withhold_env: Sequence[str] = (),
    ) -> None:
        self.workspace = workspace.resolve()
        self.on_event = on_event
        # The gateway never needs the bridge's IM credentials, and anything it
        # inherits is reachable from the agent's own shell commands.
        self.withhold_env = frozenset(withhold_env)
        self._proc: subprocess.Popen[bytes] | None = None
        self._pending: dict[str, _Pending] = {}
        self._stderr: list[str] = []
        self._lock = threading.Lock()
        self._seq = 0

    def start(self) -> None:
        if self._proc is not None:
            return
        self._proc = subprocess.Popen(
            gateway_command(),
            cwd=str(self.workspace),
            env=child_environment(withhold=self.withhold_env),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        threading.Thread(target=self._read_stdout, name="friday-im-rpc", daemon=True).start()
        threading.Thread(target=self._read_stderr, name="friday-im-log", daemon=True).start()

    def request(self, method: str, params: dict[str, Any] | None = None, *, timeout: float = 60.0) -> Any:
        self.start()
        proc = self._proc
        if proc is None or proc.stdin is None:
            raise GatewayError("gateway is not running")
        with self._lock:
            self._seq += 1
            rid = f"im{self._seq}"
            pending = _Pending()
            self._pending[rid] = pending
        message = json.dumps({"id": rid, "jsonrpc": "2.0", "method": method, "params": params or {}}, ensure_ascii=False)
        try:
            proc.stdin.write(message.encode("utf-8") + b"\n")
            proc.stdin.flush()
        except OSError as exc:
            self._drop(rid)
            raise GatewayError(f"gateway write failed: {exc}{self._log_tail()}") from exc
        if not pending.done.wait(timeout):
            self._drop(rid)
            raise GatewayError(f"{method} timed out after {timeout:.0f}s")
        if pending.error:
            raise GatewayError(pending.error)
        return pending.result

    def close(self) -> None:
        proc, self._proc = self._proc, None
        if proc is None:
            return
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            try:
                if stream is not None:
                    stream.close()
            except OSError:
                pass
        proc.terminate()
        try:
            proc.wait(5)
        except subprocess.TimeoutExpired:
            proc.kill()
        self._fail_all("gateway closed")

    def _read_stdout(self) -> None:
        proc = self._proc
        if proc is None or proc.stdout is None:
            return
        try:
            for raw in proc.stdout:
                line = raw.decode("utf-8", "replace").strip().lstrip("\ufeff")
                if not line:
                    continue
                try:
                    message = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(message, dict):
                    self._dispatch(message)
        except (OSError, ValueError):
            # close() shuts the pipe from under this thread; that is a normal exit.
            pass
        self._fail_all(f"gateway exited{self._log_tail()}")

    def _read_stderr(self) -> None:
        proc = self._proc
        if proc is None or proc.stderr is None:
            return
        try:
            for raw in proc.stderr:
                line = raw.decode("utf-8", "replace").rstrip()
                if not line:
                    continue
                with self._lock:
                    self._stderr.append(line)
                    del self._stderr[:-_STDERR_TAIL]
        except (OSError, ValueError):
            pass

    def _dispatch(self, message: dict[str, Any]) -> None:
        rid = message.get("id")
        if rid is not None:
            with self._lock:
                pending = self._pending.pop(str(rid), None)
            if pending is not None:
                error = message.get("error")
                pending.error = str(error.get("message") or "request failed") if isinstance(error, dict) else None
                pending.result = message.get("result")
                pending.done.set()
                return
        if message.get("method") != "event":
            return
        params = message.get("params")
        if self.on_event is not None and isinstance(params, dict):
            payload = params.get("payload")
            self.on_event(str(params.get("type") or ""), payload if isinstance(payload, dict) else {})

    def _drop(self, rid: str) -> None:
        with self._lock:
            self._pending.pop(rid, None)

    def _fail_all(self, reason: str) -> None:
        with self._lock:
            pending, self._pending = list(self._pending.values()), {}
        for item in pending:
            item.error = reason
            item.done.set()

    def _log_tail(self) -> str:
        with self._lock:
            tail = [line for line in self._stderr if line.strip()][-3:]
        return f": {' | '.join(tail)}" if tail else ""
