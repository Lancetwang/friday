from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import threading
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any
from uuid import uuid4

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
_snapshot_lock = threading.Lock()


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
    with _snapshot_lock:
        _ensure_repo(workspace)
        _git(workspace, "add", "-u")
        untracked = _git(workspace, "ls-files", "--others", "--exclude-standard", "-z")
        if untracked:
            _git_input(
                workspace,
                untracked,
                "add",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            )
        return _git(workspace, "write-tree").strip()


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
    _git(workspace, "read-tree", target_tree)
    restored = sorted(changed & target_paths)
    if restored:
        _git_input(
            workspace,
            "\0".join(restored) + "\0",
            "checkout-index",
            "--force",
            "--stdin",
            "-z",
        )
    for relative in removed:
        parent = (workspace / Path(*PurePosixPath(relative).parts)).parent
        while parent != workspace and parent.exists():
            try:
                parent.rmdir()
            except OSError:
                break
            parent = parent.parent


def _diff_paths(workspace: Path, left: str, right: str) -> list[str]:
    output = _git(workspace, "diff", "--name-only", "-z", left, right)
    return sorted(path for path in output.split("\0") if path)


def _tree_paths(workspace: Path, tree: str) -> list[str]:
    output = _git(workspace, "ls-tree", "-r", "--name-only", "-z", tree)
    return [path for path in output.split("\0") if path]


def _ensure_repo(workspace: Path) -> None:
    repo = _repo_dir(workspace)
    git = shutil.which("git")
    if not git:
        raise RuntimeError("Friday checkpoints require Git on PATH.")

    repaired_refs = False
    if all((repo / name).exists() for name in ("HEAD", "config", "objects")):
        repaired_refs = not (repo / "refs").exists()
        (repo / "refs" / "heads").mkdir(parents=True, exist_ok=True)
        (repo / "refs" / "tags").mkdir(parents=True, exist_ok=True)

    check = subprocess.run(
        [git, f"--git-dir={repo}", "rev-parse", "--git-dir"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if check.returncode:
        if repo.is_dir():
            shutil.rmtree(repo)
        elif repo.exists():
            repo.unlink()
        shutil.rmtree(_entries_dir(workspace), ignore_errors=True)
        repo.parent.mkdir(parents=True, exist_ok=True)
        result = subprocess.run(
            [git, "init", "--bare", "--quiet", str(repo)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        if result.returncode:
            raise RuntimeError(result.stderr.strip() or "Could not initialize Friday checkpoint storage.")
    elif repaired_refs:
        for entry in _entries(workspace):
            _sync_entry_refs(workspace, entry)
    exclude = repo / "info" / "exclude"
    exclude.parent.mkdir(parents=True, exist_ok=True)
    exclude.write_text("/.git/\n/.friday/\n", encoding="utf-8")


def _git(workspace: Path, *args: str) -> str:
    return _run_git(workspace, list(args))


def _git_input(workspace: Path, value: str, *args: str) -> str:
    return _run_git(workspace, list(args), input_text=value)


def _run_git(workspace: Path, args: list[str], *, input_text: str | None = None) -> str:
    git = shutil.which("git")
    if not git:
        raise RuntimeError("Friday checkpoints require Git on PATH.")
    result = subprocess.run(
        [
            git,
            f"--git-dir={_repo_dir(workspace)}",
            f"--work-tree={workspace}",
            "-c",
            "core.bare=false",
            "-c",
            "core.autocrlf=false",
            *args,
        ],
        cwd=workspace,
        input=input_text,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or f"Git checkpoint command failed: {' '.join(args)}")
    return result.stdout


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
        _git(workspace, "update-ref", "-d", f"refs/friday/{checkpoint_id}/before")
        _git(workspace, "update-ref", "-d", f"refs/friday/{checkpoint_id}/after")
    _git(workspace, "gc", "--prune=now", "--quiet")


def _sync_entry_refs(workspace: Path, entry: dict[str, Any]) -> None:
    checkpoint_id = str(entry["id"])
    for name, key in (("before", "before_tree"), ("after", "after_tree")):
        tree = str(entry.get(key) or "")
        if tree:
            _git(workspace, "update-ref", f"refs/friday/{checkpoint_id}/{name}", tree)


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
