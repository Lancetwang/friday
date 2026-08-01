from __future__ import annotations

import json
import os
import shutil
import tempfile
import threading
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any, Iterator
from uuid import uuid4

from dulwich import porcelain
from dulwich.diff_tree import tree_changes
from dulwich.ignore import IgnoreFilterManager
from dulwich.index import build_file_from_blob
from dulwich.object_store import iter_tree_contents
from dulwich.objects import Blob
from dulwich.repo import Repo
from dulwich.worktree import WorkTree

from friday.storage import checkpoint_dir, project_state_dir
from friday.trace import load_trace, load_trace_object

SCHEMA_VERSION = 1
ACTIVE_STATES = {"pending", "ready"}
MAX_CHECKPOINTS = 50
MAX_ARTIFACTS_PER_TURN = 24
ARTIFACT_TYPES = {
    ".csv": "text",
    ".gif": "image",
    ".html": "text",
    ".jpeg": "image",
    ".jpg": "image",
    ".json": "text",
    ".md": "markdown",
    ".markdown": "markdown",
    ".pdf": "pdf",
    ".png": "image",
    ".txt": "text",
    ".webp": "image",
}
_repo_lock = threading.RLock()


def begin_checkpoint(
    workspace: Path,
    *,
    session_id: str,
    turn_id: str,
    user: str,
    progress: dict[str, Any],
    continuation: bool = False,
) -> str:
    root = workspace.resolve()
    if continuation:
        pending = _latest_entry(root, states={"pending"}, session_id=session_id)
        if pending:
            return str(pending["id"])

    checkpoint_id = datetime.now().strftime("%Y%m%d%H%M%S%f") + "-" + uuid4().hex[:8]
    session = _read_json(project_state_dir(root) / "sessions" / f"{session_id}.json")
    _write_entry(
        root,
        {
            "schema_version": SCHEMA_VERSION,
            "id": checkpoint_id,
            "workspace": str(root),
            "session_id": session_id,
            "turn_id": turn_id,
            "created": datetime.now().isoformat(timespec="seconds"),
            "user": user,
            "state": "pending",
            "before_tree": _snapshot(root),
            "after_tree": "",
            "before_progress": progress,
            "before_session": {
                key: value
                for key, value in (session or {}).items()
                if key not in {"messages", "progress"}
            },
            "session_existed": session is not None,
        },
    )
    return checkpoint_id


def finish_checkpoint(workspace: Path, checkpoint_id: str, *, pending: bool) -> dict[str, Any]:
    root = workspace.resolve()
    entry = _entry(root, checkpoint_id)
    entry.update(
        state="pending" if pending else "ready",
        after_tree=_snapshot(root),
        updated=datetime.now().isoformat(timespec="seconds"),
    )
    _write_entry(root, entry)
    _prune_checkpoints(root)
    return entry


def finish_pending_checkpoint(workspace: Path, *, pending: bool) -> dict[str, Any] | None:
    root = workspace.resolve()
    entry = _latest_entry(root, states={"pending"})
    return finish_checkpoint(root, str(entry["id"]), pending=pending) if entry else None


def checkpoint_artifacts(workspace: Path, entry: dict[str, Any]) -> list[dict[str, Any]]:
    root = workspace.resolve()
    artifacts = []
    for relative in _diff_paths(root, str(entry["before_tree"]), str(entry["after_tree"])):
        path = (root / Path(*PurePosixPath(relative).parts)).resolve()
        kind = ARTIFACT_TYPES.get(path.suffix.lower())
        if kind and path.is_file() and root in path.parents:
            artifacts.append(
                {
                    "kind": kind,
                    "name": path.name,
                    "path": relative,
                    "size": path.stat().st_size,
                }
            )
            if len(artifacts) >= MAX_ARTIFACTS_PER_TURN:
                break
    return artifacts


def discard_checkpoint(workspace: Path, checkpoint_id: str) -> None:
    root = workspace.resolve()
    entry = _entry(root, checkpoint_id)
    _remove_entries(root, [entry])


def checkpoint_choices(workspace: Path | None = None, *, limit: int = 20) -> list[dict[str, Any]]:
    root = (workspace or Path.cwd()).resolve()
    choices = []
    for entry in reversed(_entries(root)):
        if entry.get("state") not in ACTIVE_STATES:
            continue
        choices.append(
            {
                "id": str(entry["id"]),
                "created": str(entry.get("created") or ""),
                "session_id": str(entry.get("session_id") or ""),
                "state": str(entry.get("state") or ""),
                "user": _preview(str(entry.get("user") or ""), 140),
            }
        )
        if len(choices) >= max(1, limit):
            break
    return choices


def restore_checkpoint(
    workspace: Path | None = None,
    *,
    checkpoint_id: str | None = None,
    force: bool = False,
) -> dict[str, Any]:
    root = (workspace or Path.cwd()).resolve()
    target = _entry(root, checkpoint_id) if checkpoint_id else _latest_entry(root, states=ACTIVE_STATES)
    if not target or target.get("state") not in ACTIVE_STATES:
        raise ValueError("No restorable Friday checkpoint.")

    messages = _before_messages(target)
    active = [entry for entry in _entries(root) if entry.get("state") in ACTIVE_STATES]
    latest = active[-1] if active else target
    expected_tree = str(latest.get("after_tree") or latest["before_tree"])
    current_tree = _snapshot(root)
    conflicts = _diff_paths(root, expected_tree, current_tree)
    if conflicts and not force:
        listed = ", ".join(conflicts[:8])
        suffix = " ..." if len(conflicts) > 8 else ""
        raise RuntimeError(
            f"Workspace changed after Friday's last checkpoint: {listed}{suffix}. "
            "Review those files or retry with --force."
        )

    before_tree = str(target["before_tree"])
    changed = _diff_paths(root, before_tree, current_tree)
    _restore_tree(root, current_tree, before_tree)
    for entry in active:
        if str(entry.get("id")) >= str(target["id"]):
            entry.update(state="undone", undone_at=datetime.now().isoformat(timespec="seconds"))
            _write_entry(root, entry)
    _prune_checkpoints(root)
    return {
        **target,
        "messages": messages,
        "changed_paths": changed,
    }


def _before_messages(entry: dict[str, Any]) -> list[dict[str, Any]]:
    session_id = str(entry.get("session_id") or "")
    turn_id = str(entry.get("turn_id") or "")
    _manifest, events = load_trace(session_id)
    event = next(
        (
            item
            for item in events
            if item.get("type") == "turn.start" and str(item.get("turn_id") or "") == turn_id
        ),
        None,
    )
    descriptors = (event or {}).get("data", {}).get("initial_messages", [])
    messages = []
    for descriptor in descriptors if isinstance(descriptors, list) else []:
        ref = descriptor.get("ref") if isinstance(descriptor, dict) else None
        value = load_trace_object(session_id, ref) if isinstance(ref, str) else None
        if isinstance(value, dict):
            messages.append(value)
    if event is None:
        raise RuntimeError(f"Checkpoint trace is missing for session {session_id}.")
    return messages


def _snapshot(workspace: Path) -> str:
    with _open_repo(workspace) as repo:
        _stage_workspace(repo, workspace)
        return repo.open_index().commit(repo.object_store).decode("ascii")


def _restore_tree(workspace: Path, current_tree: str, target_tree: str) -> None:
    current_paths = set(_tree_paths(workspace, current_tree))
    target_paths = set(_tree_paths(workspace, target_tree))
    changed = set(_diff_paths(workspace, current_tree, target_tree))
    removed = current_paths - target_paths
    for relative in removed:
        path = (workspace / Path(*PurePosixPath(relative).parts)).resolve()
        if path != workspace and workspace not in path.parents:
            raise RuntimeError(f"Checkpoint path escapes workspace: {relative}")
        if path.is_file() or path.is_symlink():
            path.unlink()
        elif path.exists():
            raise RuntimeError(f"Cannot safely replace directory while restoring: {relative}")
    restored = sorted(changed & target_paths)
    with _open_repo(workspace) as repo:
        target_entries = {
            _decode_path(entry.path): entry
            for entry in iter_tree_contents(repo.object_store, target_tree.encode("ascii"))
            if entry.path is not None
        }
        for relative in restored:
            path = workspace / Path(*PurePosixPath(relative).parts)
            parent = path.parent.resolve()
            if parent != workspace and workspace not in parent.parents:
                raise RuntimeError(f"Checkpoint path escapes workspace: {relative}")
            if path.is_symlink() or path.is_file():
                path.unlink()
            elif path.exists():
                raise RuntimeError(f"Cannot safely replace directory while restoring: {relative}")
            path.parent.mkdir(parents=True, exist_ok=True)
            entry = target_entries[relative]
            blob = repo.object_store[entry.sha]
            if not isinstance(blob, Blob):
                raise RuntimeError(f"Checkpoint object is not a file: {relative}")
            build_file_from_blob(blob, entry.mode, path, honor_filemode=False)
        _stage_workspace(repo, workspace)
        restored_tree = repo.open_index().commit(repo.object_store).decode("ascii")
        if restored_tree != target_tree:
            raise RuntimeError("Could not restore the checkpoint exactly.")
    for relative in removed:
        parent = (workspace / Path(*PurePosixPath(relative).parts)).parent
        while parent != workspace and parent.exists():
            try:
                parent.rmdir()
            except OSError:
                break
            parent = parent.parent


def _diff_paths(workspace: Path, left: str, right: str) -> list[str]:
    with _open_repo(workspace) as repo:
        paths = {
            _decode_path(entry.path)
            for change in tree_changes(
                repo.object_store,
                left.encode("ascii"),
                right.encode("ascii"),
            )
            for entry in (change.old, change.new)
            if entry is not None and entry.path is not None
        }
    return sorted(paths)


def _tree_paths(workspace: Path, tree: str) -> list[str]:
    with _open_repo(workspace) as repo:
        return [
            _decode_path(entry.path)
            for entry in iter_tree_contents(repo.object_store, tree.encode("ascii"))
            if entry.path is not None
        ]


def _ensure_repo(workspace: Path) -> None:
    repo = _repo_dir(workspace)
    repaired_refs = False
    if all((repo / name).exists() for name in ("HEAD", "config", "objects")):
        repaired_refs = not (repo / "refs").exists()
        (repo / "refs" / "heads").mkdir(parents=True, exist_ok=True)
        (repo / "refs" / "tags").mkdir(parents=True, exist_ok=True)
    try:
        opened = Repo(repo)
    except Exception:
        if repo.is_dir():
            shutil.rmtree(repo)
        elif repo.exists():
            repo.unlink()
        shutil.rmtree(_entries_dir(workspace), ignore_errors=True)
        repo.parent.mkdir(parents=True, exist_ok=True)
        opened = Repo.init_bare(repo, mkdir=True)
    opened.close()

    with Repo(repo) as opened:
        config = opened.get_config()
        config.set((b"core",), b"bare", False)
        config.set((b"core",), b"worktree", os.fsencode(str(workspace)))
        config.set((b"core",), b"autocrlf", False)
        config.write_to_path()
    if repaired_refs:
        for entry in _entries(workspace):
            _sync_entry_refs(workspace, entry)
    exclude = repo / "info" / "exclude"
    exclude.parent.mkdir(parents=True, exist_ok=True)
    exclude.write_text("/.git/\n/.friday/\n", encoding="utf-8")


@contextmanager
def _open_repo(workspace: Path) -> Iterator[Repo]:
    with _repo_lock:
        _ensure_repo(workspace)
        with Repo(_repo_dir(workspace)) as repo:
            repo.bare = False
            repo.path = str(workspace)
            yield repo


def _stage_workspace(repo: Repo, workspace: Path) -> None:
    ignored = IgnoreFilterManager.from_repo(repo)
    paths: set[str] = {_decode_path(path) for path in repo.open_index()}
    for directory, names, files in os.walk(workspace, followlinks=False):
        base = Path(directory)
        kept = []
        for name in names:
            path = base / name
            relative = path.relative_to(workspace).as_posix()
            if ignored.is_ignored(relative + "/"):
                continue
            if path.is_symlink():
                paths.add(relative)
            else:
                kept.append(name)
        names[:] = kept
        for name in files:
            relative = (base / name).relative_to(workspace).as_posix()
            if not ignored.is_ignored(relative):
                paths.add(relative)
    if paths:
        WorkTree(repo, workspace).stage(sorted(paths))


def _decode_path(path: bytes) -> str:
    return path.decode("utf-8", "surrogateescape")


def _entry(workspace: Path, checkpoint_id: str | None) -> dict[str, Any]:
    if not checkpoint_id or not checkpoint_id.replace("-", "").isalnum():
        raise ValueError("Invalid checkpoint id.")
    value = _read_json(_entries_dir(workspace) / f"{checkpoint_id}.json")
    if not value:
        raise ValueError(f"Checkpoint not found: {checkpoint_id}")
    return value


def _latest_entry(
    workspace: Path,
    *,
    states: set[str],
    session_id: str | None = None,
) -> dict[str, Any] | None:
    values = [
        entry
        for entry in _entries(workspace)
        if entry.get("state") in states
        and (session_id is None or str(entry.get("session_id") or "") == session_id)
    ]
    return values[-1] if values else None


def _entries(workspace: Path) -> list[dict[str, Any]]:
    directory = _entries_dir(workspace)
    if not directory.exists():
        return []
    return [
        value
        for path in sorted(directory.glob("*.json"))
        if (value := _read_json(path)) is not None
    ]


def _write_entry(workspace: Path, value: dict[str, Any]) -> None:
    path = _entries_dir(workspace) / f"{value['id']}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, dir=path.parent) as file:
        json.dump(value, file, ensure_ascii=False)
        temporary = Path(file.name)
    temporary.replace(path)
    _sync_entry_refs(workspace, value)


def delete_session_checkpoints(workspace: Path, session_id: str) -> int:
    root = workspace.resolve()
    removed = [entry for entry in _entries(root) if str(entry.get("session_id") or "") == session_id]
    if not removed:
        return 0
    _remove_entries(root, removed)
    return len(removed)


def _prune_checkpoints(workspace: Path) -> None:
    entries = _entries(workspace)
    active = [entry for entry in entries if entry.get("state") in ACTIVE_STATES]
    keep_ids = {str(entry["id"]) for entry in active[-MAX_CHECKPOINTS:]}
    removed = [
        entry
        for entry in entries
        if entry.get("state") == "undone"
        or (entry.get("state") in ACTIVE_STATES and str(entry["id"]) not in keep_ids)
    ]
    if removed:
        _remove_entries(workspace, removed)


def _remove_entries(workspace: Path, removed: list[dict[str, Any]]) -> None:
    removed_ids = {str(entry["id"]) for entry in removed}
    for entry in _entries(workspace):
        if str(entry["id"]) not in removed_ids:
            _sync_entry_refs(workspace, entry)
    for entry in removed:
        checkpoint_id = str(entry["id"])
        (_entries_dir(workspace) / f"{checkpoint_id}.json").unlink(missing_ok=True)
        with _open_repo(workspace) as repo:
            for name in ("before", "after"):
                ref = f"refs/friday/{checkpoint_id}/{name}".encode("ascii")
                try:
                    del repo.refs[ref]
                except KeyError:
                    pass
    try:
        with _open_repo(workspace) as repo:
            porcelain.gc(repo, prune=True, grace_period=0)
    except PermissionError:
        # References are already removed; a later prune can collect a pack
        # temporarily locked by Windows or another process.
        pass


def _sync_entry_refs(workspace: Path, entry: dict[str, Any]) -> None:
    checkpoint_id = str(entry["id"])
    with _open_repo(workspace) as repo:
        for name, key in (("before", "before_tree"), ("after", "after_tree")):
            tree = str(entry.get(key) or "")
            if tree:
                repo.refs[f"refs/friday/{checkpoint_id}/{name}".encode("ascii")] = tree.encode("ascii")


def _read_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    return value if isinstance(value, dict) else None


def _entries_dir(workspace: Path) -> Path:
    return _checkpoint_dir(workspace) / "entries"


def _repo_dir(workspace: Path) -> Path:
    return _checkpoint_dir(workspace) / "repo.git"


def _checkpoint_dir(workspace: Path) -> Path:
    return checkpoint_dir(workspace)


def _preview(text: str, limit: int) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 3] + "..."
