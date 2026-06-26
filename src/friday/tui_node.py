from __future__ import annotations

import ctypes
import os
import shutil
import subprocess
import sys
from pathlib import Path


def run_tui() -> None:
    _configure_windows_console()
    root = Path(__file__).resolve().parents[2]
    ui = root / "ui-tui"
    entry = ui / "dist" / "entry.js"
    env = os.environ.copy()
    env.setdefault("FRIDAY_PYTHON", sys.executable)
    env.setdefault("FRIDAY_ROOT", str(root))
    env.setdefault("FRIDAY_CWD", str(root))
    env.setdefault("PYTHONIOENCODING", "utf-8")
    env.setdefault("PYTHONUTF8", "1")

    if entry.exists():
        raise SystemExit(subprocess.call([_exe("node"), str(entry)], cwd=root, env=env))
    if (ui / "node_modules").exists():
        raise SystemExit(subprocess.call([_exe("npm"), "start"], cwd=ui, env=env))

    print("Friday TS TUI needs Node deps first:")
    print("  cd ui-tui")
    print("  npm install")
    raise SystemExit(1)


def _exe(name: str) -> str:
    return shutil.which(name) or name


def _configure_windows_console() -> None:
    if os.name != "nt":
        return
    kernel32 = ctypes.windll.kernel32
    kernel32.SetConsoleCP(65001)
    kernel32.SetConsoleOutputCP(65001)
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
