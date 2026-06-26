from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def run_tui() -> None:
    root = Path(__file__).resolve().parents[2]
    ui = root / "ui-tui"
    entry = ui / "dist" / "entry.js"
    env = os.environ.copy()
    env.setdefault("FRIDAY_PYTHON", sys.executable)
    env.setdefault("FRIDAY_ROOT", str(root))

    if entry.exists():
        raise SystemExit(subprocess.call(["node", str(entry)], cwd=root, env=env))
    if (ui / "node_modules").exists():
        raise SystemExit(subprocess.call(["npm", "start", "--prefix", str(ui)], cwd=root, env=env))

    print("Friday TS TUI needs Node deps first:")
    print("  npm install --prefix ui-tui")
    raise SystemExit(1)
