"""Smoke test for the frozen friday-app-server sidecar.

Spawns the binary, waits for the `gateway.ready` event, then runs a
`session.current` JSON-RPC round trip. Exits non-zero with the child stderr
printed when the gateway does not answer, so CI logs show the real failure.
"""

from __future__ import annotations

import json
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path

TIMEOUT_SECONDS = 60


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: smoke-sidecar.py <path-to-friday-app-server>", file=sys.stderr)
        return 2
    binary = Path(sys.argv[1])
    if not binary.is_file():
        print(f"sidecar binary not found: {binary}", file=sys.stderr)
        return 2

    process = subprocess.Popen(
        [str(binary)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    lines: queue.Queue[tuple[str, str]] = queue.Queue()

    def pump(stream, kind: str) -> None:
        for line in stream:
            lines.put((kind, line.rstrip()))

    threading.Thread(target=pump, args=(process.stdout, "stdout"), daemon=True).start()
    threading.Thread(target=pump, args=(process.stderr, "stderr"), daemon=True).start()

    assert process.stdin is not None
    request = {"id": "smoke-1", "jsonrpc": "2.0", "method": "session.current", "params": {}}
    process.stdin.write(json.dumps(request) + "\n")
    process.stdin.flush()

    deadline = time.monotonic() + TIMEOUT_SECONDS
    stderr_lines: list[str] = []
    ready = False
    answered = False
    failed = False
    while time.monotonic() < deadline and not (ready and answered) and not failed:
        if process.poll() is not None and lines.empty():
            break
        try:
            kind, line = lines.get(timeout=0.5)
        except queue.Empty:
            continue
        if kind == "stderr":
            stderr_lines.append(line)
            continue
        print(f"sidecar: {line}")
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        if message.get("method") == "event" and (message.get("params") or {}).get("type") == "gateway.ready":
            ready = True
        elif message.get("id") == "smoke-1":
            if "error" in message:
                print(f"gateway returned an error: {message['error']}", file=sys.stderr)
                failed = True
            else:
                answered = True

    if process.poll() is None:
        process.kill()
    exit_code = process.wait()

    if ready and answered:
        print("sidecar smoke test passed")
        return 0

    print("sidecar smoke test FAILED:", file=sys.stderr)
    print(f"  gateway.ready seen: {ready}, session.current answered: {answered}", file=sys.stderr)
    print(f"  process exit code: {exit_code}", file=sys.stderr)
    if stderr_lines:
        print("  --- sidecar stderr ---", file=sys.stderr)
        for line in stderr_lines:
            print(f"  {line}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
