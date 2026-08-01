from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Any

from friday import __version__
from friday.app import _installed_core_version, _pinned_core_version
from friday.config import load_model_catalog
from friday.storage import friday_home


def doctor_report(workspace: Path) -> dict[str, Any]:
    root = workspace.resolve()
    checks = [
        _check("Friday", "ok", f"version {__version__}"),
        _runtime_check(),
        _path_check("User data", friday_home()),
        _path_check("Workspace", root),
        _model_check(root),
        _tui_check(),
    ]
    status = "error" if any(item["status"] == "error" for item in checks) else "warning" if any(
        item["status"] == "warning" for item in checks
    ) else "ok"
    return {"status": status, "ok": status != "error", "checks": checks}


def format_doctor_report(report: dict[str, Any]) -> str:
    lines = ["Friday doctor"]
    for item in report["checks"]:
        lines.append(f"[{item['status'].upper()}] {item['name']}: {item['detail']}")
    lines.append(f"Overall: {report['status']}")
    return "\n".join(lines)


def _runtime_check() -> dict[str, str]:
    installed = _installed_core_version()
    expected = _pinned_core_version()
    if not installed:
        return _check("Agent runtime", "error", "friday-agent-core is not installed")
    if expected and installed != expected:
        return _check("Agent runtime", "error", f"installed {installed}, expected {expected}")
    suffix = f" (pinned {expected})" if expected else ""
    return _check("Agent runtime", "ok", f"friday-agent-core {installed}{suffix}")


def _path_check(name: str, path: Path) -> dict[str, str]:
    if not path.exists():
        return _check(name, "warning", f"{path} (not created yet)")
    writable = path.is_dir() and os.access(path, os.W_OK)
    return _check(name, "ok" if writable else "error", f"{path} ({'writable' if writable else 'not writable'})")


def _model_check(workspace: Path) -> dict[str, str]:
    catalog = load_model_catalog(workspace)
    active = next(profile for profile in catalog["profiles"] if profile["id"] == catalog["active"])
    label = f"{active['provider']}/{active['model']}"
    if not active["api_key_configured"]:
        return _check("Model", "error", f"{label}; API key is not configured")
    return _check("Model", "ok", f"{label}; API key configured")


def _tui_check() -> dict[str, str]:
    root = Path(__file__).resolve().parents[2]
    ui = root / "ui-tui"
    if not ui.is_dir():
        return _check("TUI", "warning", "not bundled in this installation; use `friday chat` or install from source")
    if not shutil.which("node"):
        return _check("TUI", "error", "Node.js is not available on PATH")
    if (ui / "node_modules").is_dir() or (ui / "dist" / "entry.js").is_file():
        return _check("TUI", "ok", "Node.js and TUI assets are available")
    return _check("TUI", "warning", f"dependencies are missing; run `npm --prefix \"{ui}\" ci`")


def _check(name: str, status: str, detail: str) -> dict[str, str]:
    return {"name": name, "status": status, "detail": detail}
