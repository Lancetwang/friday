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


def resolve_workspace(workspace: Path) -> Path:
    r"""The one spelling of a directory that Friday keys a project by.

    Windows canonicalisation returns extended-length paths (``\\?\E:\work``), and
    the desktop hands that string straight back to the gateway. Left alone it is
    a second name for the same directory, and everything keyed by the path
    silently forks: closing a project writes ``open: false`` to the record under
    one spelling while the other stays open and keeps being advertised, and the
    sidebar lists the workspace twice.
    """
    resolved = workspace.expanduser().resolve()
    text = str(resolved)
    if text.startswith("\\\\?\\UNC\\"):
        return Path("\\\\" + text[len("\\\\?\\UNC\\") :])
    if text.startswith("\\\\?\\"):
        return Path(text[len("\\\\?\\") :])
    return resolved


def workspace_key(workspace: Path) -> str:
    return hashlib.sha256(str(resolve_workspace(workspace)).casefold().encode("utf-8")).hexdigest()[:20]


def project_state_dir(workspace: Path, home: Path | None = None) -> Path:
    return friday_home(home) / "projects" / workspace_key(workspace)


def record_project(workspace: Path, home: Path | None = None, *, opened: bool | None = None) -> Path:
    """Note that Friday worked in this workspace, and optionally that it is open.

    `opened` is the desktop sidebar's state, not a fact about the workspace, so
    working in a project leaves it alone: the default preserves whatever the last
    explicit open or close decided. Only a host that knows the user's intent --
    the gateway a project was opened in, or `close_project` -- passes it. A
    workspace Friday merely built an agent in (a CLI run, say) therefore never
    appears in a sidebar the user did not put it in.
    """
    root = resolve_workspace(workspace)
    path = project_state_dir(root, home) / "project.json"
    existing = _project_record(path)
    # Records predating the flag were all sidebar entries, so an upgrade keeps
    # showing them. A workspace with no record at all is not open until a host
    # that knows the user's intent says it is.
    inherited = bool(existing.get("open", bool(existing)))
    value = {
        "workspace": str(root),
        "created": existing.get("created") or datetime.now().isoformat(timespec="seconds"),
        "updated": datetime.now().isoformat(timespec="seconds"),
        "open": inherited if opened is None else opened,
    }
    write_json_atomic(path, value)
    return path


def list_projects(home: Path | None = None, *, open_only: bool = False) -> list[dict[str, Any]]:
    """Workspaces Friday knows about, most recently used first.

    `open_only` is what the desktop sidebar asks for: the projects the user left
    open. Without it the closed ones come too, each carrying its `open` flag,
    which is what a "reopen a recent project" list would want.

    A record whose directory is gone is skipped rather than closed: the workspace
    may be on a drive that is merely not mounted right now, and it comes back on
    its own once the path resolves again.

    Records written before paths were normalised left some workspaces stored
    twice, under an extended-length spelling and a plain one, so they are
    collapsed here and the newest decision wins. Without that the copy the user
    never closed keeps the project in the sidebar.
    """
    root = friday_home(home) / "projects"
    newest: dict[str, dict[str, Any]] = {}
    if root.is_dir():
        for path in root.glob("*/project.json"):
            value = _project_record(path)
            stored = str(value.get("workspace") or "").strip()
            if not stored:
                continue
            workspace = resolve_workspace(Path(stored))
            if not workspace.is_dir():
                continue
            updated = str(value.get("updated") or "")
            key = str(workspace).casefold()
            if key in newest and newest[key]["updated"] >= updated:
                continue
            newest[key] = {"workspace": str(workspace), "updated": updated, "open": bool(value.get("open", True))}
    projects = [item for item in newest.values() if item["open"] or not open_only]
    projects.sort(key=lambda item: str(item["updated"]), reverse=True)
    return projects


def close_project(workspace: Path, home: Path | None = None) -> None:
    """Record that the user closed this project, and keep it closed.

    Closing is a decision that has to outlive the window, so it is written down
    rather than expressed by deleting the record: a deleted record is recreated
    by the next agent built in that directory, which is how a closed project
    used to come back on the following launch. Sessions and checkpoints stay on
    disk either way -- this only takes the project out of the sidebar.
    """
    record_project(workspace, home, opened=False)


def _project_record(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}
    return value if isinstance(value, dict) else {}


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
