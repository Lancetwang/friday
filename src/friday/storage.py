from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
from datetime import datetime
from pathlib import Path

RUNTIME_ENTRIES = ("sessions", "tool-results", "pending_approval.json", "permissions.json", "config.json")


def friday_home(home: Path | None = None) -> Path:
    if home is not None:
        return home.expanduser().resolve() / ".friday"
    override = os.getenv("FRIDAY_HOME")
    return Path(override).expanduser().resolve() if override else Path.home().resolve() / ".friday"


def workspace_key(workspace: Path) -> str:
    return hashlib.sha256(str(workspace.resolve()).casefold().encode("utf-8")).hexdigest()[:20]


def project_state_dir(workspace: Path, home: Path | None = None) -> Path:
    return friday_home(home) / "projects" / workspace_key(workspace)


def record_project(workspace: Path, home: Path | None = None) -> Path:
    root = workspace.resolve()
    path = project_state_dir(root, home) / "project.json"
    existing = {}
    if path.exists():
        try:
            existing = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    if not isinstance(existing, dict):
        existing = {}
    value = {
        "workspace": str(root),
        "created": existing.get("created") or datetime.now().isoformat(timespec="seconds"),
        "updated": datetime.now().isoformat(timespec="seconds"),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, dir=path.parent) as file:
        json.dump(value, file, ensure_ascii=False, indent=2)
        temporary = Path(file.name)
    temporary.replace(path)
    return path


def checkpoint_dir(workspace: Path, home: Path | None = None) -> Path:
    root = workspace.resolve()
    override = os.getenv("FRIDAY_CHECKPOINT_DIR")
    if override:
        return Path(override).expanduser().resolve() / workspace_key(root)
    target = project_state_dir(root, home) / "checkpoints"
    legacy = friday_home(home) / "checkpoints" / workspace_key(root)
    if legacy.exists():
        _merge_move(legacy, target)
        _remove_empty(legacy.parent)
    return target


def migrate_legacy_runtime(workspace: Path, home: Path | None = None) -> Path:
    root = workspace.resolve()
    legacy = root / ".friday"
    target = project_state_dir(root, home)
    if legacy.exists():
        for name in RUNTIME_ENTRIES:
            source = legacy / name
            if source.exists():
                _merge_move(source, target / name)
        _remove_empty(legacy)
    checkpoint_dir(root, home)
    return target


def _merge_move(source: Path, target: Path) -> None:
    if not source.exists():
        return
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            shutil.move(str(source), str(target))
        except FileNotFoundError:
            pass
        return
    if source.is_dir() and target.is_dir():
        for child in source.iterdir():
            _merge_move(child, target / child.name)
        _remove_empty(source)


def _remove_empty(path: Path) -> None:
    if not path.is_dir():
        return
    for child in sorted(path.rglob("*"), key=lambda item: len(item.parts), reverse=True):
        if child.is_dir():
            try:
                child.rmdir()
            except OSError:
                pass
    try:
        path.rmdir()
    except OSError:
        pass
