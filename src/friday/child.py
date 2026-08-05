"""How to start another Friday process from inside one.

A packaged Friday is a single frozen binary whose entry point is the gateway, so
`-m friday.cli` means nothing to it: the interpreter flags a source checkout uses
are just argv the bootloader hands to `app_server.main()`. Every spelling of a
Friday child therefore has two forms, and choosing the wrong one fails only in
the packaged app, which is the one place development never exercises.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Sequence
from pathlib import Path


def frozen() -> bool:
    """Whether this process is the packaged single-file build."""
    return bool(getattr(sys, "frozen", False))


def cli_command(*args: str) -> list[str]:
    """Argv that runs `friday <args>`.

    The frozen binary routes to the CLI through its own `--cli` marker, which it
    only recognises as the very first argument.
    """
    prefix = ["--cli"] if frozen() else ["-m", "friday.cli"]
    return [sys.executable, *prefix, *args]


def gateway_command() -> list[str]:
    """Argv that runs the JSON-RPC gateway."""
    return [sys.executable] if frozen() else [sys.executable, "-m", "friday.app_server"]


def child_environment(*, withhold: Sequence[str] = ()) -> dict[str, str]:
    """Environment for a Friday child, with `friday` importable and secrets dropped.

    A source checkout is not necessarily installed, so the child is told where the
    package lives; the frozen build carries its own imports and must not have a
    stray `PYTHONPATH` pointing at a source tree that may not exist.
    """
    hidden = frozenset(withhold)
    env = {key: value for key, value in os.environ.items() if key not in hidden}
    if not frozen():
        root = str(Path(__file__).resolve().parent.parent)
        env["PYTHONPATH"] = os.pathsep.join(filter(None, [root, env.get("PYTHONPATH")]))
    return env
