from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

RUNTIME_ENTRIES = ("sessions", "tool-results", "pending_approval.json", "permissions.json", "config.json")

# One lock for every atomic write in the process. Contention is irrelevant next to
# the disk write it guards, and a single lock keeps two threads editing the same
# state file from interleaving their read-modify-write cycles.
_WRITE_LOCK = threading.RLock()


def write_lock() -> threading.RLock:
    """The lock guarding on-disk state, for callers that read then write."""
    return _WRITE_LOCK


def write_text_atomic(path: Path, text: str, *, private: bool = False) -> None:
    """Replace `path` in one step so a reader never observes a half-written file.

    `private` restricts the result to the owner before it becomes visible, which
    matters for credential stores: chmod after the rename would leave a window
    where the secret is world-readable.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with _WRITE_LOCK:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, dir=path.parent) as file:
            file.write(text)
            temporary = Path(file.name)
        if private:
            try:
                temporary.chmod(0o600)
            except OSError:
                pass
        temporary.replace(path)


def write_json_atomic(path: Path, value: Any, *, indent: int | None = 2, private: bool = False) -> None:
    text = json.dumps(value, ensure_ascii=False, indent=indent, default=str)
    write_text_atomic(path, text if indent is None else text + "\n", private=private)


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
    write_json_atomic(path, value)
    return path


def list_projects(home: Path | None = None) -> list[dict[str, str]]:
    """Workspaces Friday knows about, most recently used first.

    Reads the registry `record_project` maintains, so the desktop sidebar can
    restore its project list even after the window's own storage is cleared.
    """
    root = friday_home(home) / "projects"
    projects: list[dict[str, str]] = []
    if root.is_dir():
        for path in root.glob("*/project.json"):
            try:
                value = json.loads(path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue
            workspace = str(value.get("workspace") or "").strip()
            if not workspace:
                continue
            projects.append(
                {"workspace": workspace, "updated": str(value.get("updated") or "")}
            )
    projects.sort(key=lambda item: item["updated"], reverse=True)
    return projects


def forget_project(workspace: Path, home: Path | None = None) -> None:
    """Untrack a workspace without touching its state.

    Only the registry entry goes away; the sessions and checkpoints stay on
    disk and the project re-enters the registry the next time it is opened.
    """
    project_state_dir(workspace, home).joinpath("project.json").unlink(missing_ok=True)


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
