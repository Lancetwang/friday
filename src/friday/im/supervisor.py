"""Runs the phone bridge as a child process of one gateway.

The bridge is a separate process rather than a thread so that phone and desktop
conversations stay on their own sessions: each process owns its own gateway and
its own session selection, and a bridge crash cannot take the desktop down with
it. The gateway that started it also owns its lifetime, which is what makes the
switch mean "my computer is reachable from my phone right now".
"""

from __future__ import annotations

import os
import subprocess
import sys
import threading
from collections import deque
from pathlib import Path
from typing import Any

STOP_GRACE_SECONDS = 5.0
LOG_TAIL = 40


class BridgeSupervisor:
    """Starts, stops, and reports on one bridge child process."""

    def __init__(self, *, log_tail: int = LOG_TAIL) -> None:
        self._proc: subprocess.Popen[str] | None = None
        self._lines: deque[str] = deque(maxlen=log_tail)
        self._lock = threading.Lock()
        self._workspace: Path | None = None

    def start(self, workspace: Path) -> dict[str, Any]:
        with self._lock:
            if self._alive():
                return self._status()
            self._lines.clear()
            self._workspace = workspace.resolve()
            try:
                self._proc = self._spawn(self._workspace)
            except OSError as exc:
                self._proc = None
                self._lines.append(f"could not start the bridge: {exc}")
                return self._status()
            threading.Thread(target=self._drain, args=(self._proc,), name="friday-bridge-log", daemon=True).start()
            return self._status()

    def stop(self) -> dict[str, Any]:
        with self._lock:
            proc = self._proc
            if proc is None:
                return self._status()
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=STOP_GRACE_SECONDS)
                except subprocess.TimeoutExpired:
                    proc.kill()
            self._proc = None
            return self._status()

    def status(self) -> dict[str, Any]:
        with self._lock:
            return self._status()

    def _spawn(self, workspace: Path) -> subprocess.Popen[str]:
        import friday

        package_root = str(Path(friday.__file__).resolve().parent.parent)
        return subprocess.Popen(
            [sys.executable, "-m", "friday.app_server", "--cli", "feishu"],
            cwd=str(workspace),
            env=_bridge_env(package_root),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )

    def _drain(self, proc: subprocess.Popen[str]) -> None:
        """Keep the tail of the bridge's output so the UI can explain a failure."""
        stream = proc.stdout
        if stream is None:
            return
        try:
            for line in stream:
                text = line.rstrip()
                if text:
                    with self._lock:
                        self._lines.append(text)
        except (OSError, ValueError):
            pass

    def _alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def _status(self) -> dict[str, Any]:
        proc = self._proc
        running = self._alive()
        exit_code = None if proc is None or running else proc.returncode
        return {
            "running": running,
            "pid": proc.pid if proc is not None and running else None,
            "workspace": str(self._workspace) if self._workspace else "",
            "exit_code": exit_code,
            "log": list(self._lines),
        }


def _bridge_env(package_root: str) -> dict[str, str]:
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(filter(None, [package_root, env.get("PYTHONPATH")]))
    return env
