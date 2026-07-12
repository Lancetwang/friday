from __future__ import annotations

import json
import os
import shutil
import tempfile
import tomllib
from datetime import datetime
from importlib.metadata import PackageNotFoundError, distribution
from importlib.resources import files
from pathlib import Path
from typing import Any

from agent_core import Agent, RunContext

from friday.config import ModelConfig, build_model, default_config_text, load_model_config
from friday.context import compact_tool_results, should_compact_conversation, should_compact_tools
from friday.prompts import (
    COMPACT_PROMPT,
    default_project_instructions,
    environment,
    runtime_notes,
    tool_guidance,
)
from friday.tools import INSTRUCTION_FILE_NAMES, PERMISSIONS_FILE, build_tools, default_permissions, skill_catalog

PROJECT_INSTRUCTIONS_LIMIT = 12000
RECENT_CONVERSATION_LIMIT = 10


def build_friday(workspace: Path | None = None, *, stream: bool = True) -> tuple[Agent, RunContext]:
    root = (workspace or Path.cwd()).resolve()
    root_env = root / ".env"
    _load_env(root_env)
    _load_env(Path.home() / ".friday" / ".env")
    ensure_user_home(Path.home())
    friday_dir = root / ".friday"
    config = load_model_config(root)
    instructions = build_instructions(root, friday_dir, config)
    agent = Agent(
        model=build_model(config),
        instructions=instructions,
        tools=build_tools(root, friday_dir),
        stream=stream,
        chat_kwargs={"temperature": 0.2, "max_tokens": config.max_output_tokens, "tool_choice": "auto"},
    )
    context = agent.new_context()
    _require_runtime(context)
    context.metadata["workspace"] = str(root)
    context.metadata["session_id"] = datetime.now().strftime("%Y%m%d%H%M%S%f")
    context.metadata["friday.model_config"] = {
        "provider": config.provider,
        "model": config.model,
        "base_url": config.base_url,
        "context_window": config.context_window,
        "max_output_tokens": config.max_output_tokens,
    }
    return agent, context


def _require_runtime(context: Any) -> None:
    expected = _pinned_core_url()
    installed = _installed_core_url()
    if not hasattr(context, "usage") or (expected and installed != expected):
        raise RuntimeError(
            "Incompatible agent-core-runtime installation. Reinstall Friday and its pinned dependencies with "
            f"`uv tool install -e \"{_source_root()}\" --force --reinstall`."
        )


def _source_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _pinned_core_url() -> str:
    pyproject = _source_root() / "pyproject.toml"
    if not pyproject.exists():
        return ""
    data = tomllib.loads(pyproject.read_text(encoding="utf-8"))
    for requirement in data.get("project", {}).get("dependencies", []):
        name, separator, url = str(requirement).partition("@")
        if separator and name.strip() == "agent-core-runtime":
            return url.strip()
    return ""


def _installed_core_url() -> str:
    try:
        direct_url = distribution("agent-core-runtime").read_text("direct_url.json")
        return str(json.loads(direct_url or "{}").get("url") or "")
    except (PackageNotFoundError, json.JSONDecodeError):
        return ""


def _load_env(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip().lstrip("\ufeff")
        if not key or key in os.environ:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        os.environ[key] = value


def build_instructions(workspace: Path, friday_dir: Path, config: ModelConfig | None = None) -> str:
    user_dir = Path.home() / ".friday"
    config = config or load_model_config(workspace)
    parts = [
        # Global, code-owned prefix: identical across every workspace and only
        # changes on upgrade, so it stays at the front for provider prefix caching.
        ("Soul", _read_optional(user_dir / "SOUL.md") or _read_optional(user_dir / "soul.md") or _read_resource("SOUL.md")),
        ("Runtime", runtime_notes()),
        ("Tool Guidance", tool_guidance()),
        # Global, user-editable layers: rules, profile, and cross-project memory.
        ("Global Rules", _read_optional(user_dir / "AGENTS.md") or _read_resource("AGENTS.md")),
        ("User Profile", _read_optional(user_dir / "USER.md") or _read_optional(user_dir / "user.md")),
        ("Global Memory", _read_optional(user_dir / "MEMORY.md")),
        # Workspace-specific tail: varies per project, kept after the global prefix.
        ("Skill Catalog", skill_catalog(workspace)),
        ("Project Instructions", "\n\n".join(_project_instruction_files(workspace))),
        ("Environment", environment(workspace, config)),
        ("Project Memory", _read_optional(friday_dir / "MEMORY.md")),
    ]
    return "\n\n".join(f"## {title}\n{body.strip()}" for title, body in parts if body.strip())


def compact_friday(agent: Agent, context: RunContext, *, stream: bool = True, on_delta: Any = None) -> tuple[Agent, RunContext, str]:
    # One in-band pass: inserted into the current conversation so it reuses the cached
    # prefix. Within this single turn the agent saves durable facts with the Memory tool
    # (so compaction never forgets them), then its final message is the structured summary.
    summary = agent.chat(
        f"{COMPACT_PROMPT}\n\nLatest turns to keep under Recent Conversations:\n{_recent_conversations(context)}",
        context=context,
        max_steps=8,
        stream=False,
        on_delta=on_delta,
    )
    workspace = Path(context.metadata["workspace"])
    new_agent, new_context = build_friday(workspace, stream=stream)
    if hasattr(context, "usage") and hasattr(new_context, "usage"):
        new_context.usage = context.usage
    # The compaction summary is in-session context, not a persisted file. It rides in
    # the conversation (saved by the next snapshot, restored by resume), after the fresh prefix.
    new_context.add_message("assistant", f"## Session Summary\n{summary.strip()}")
    return new_agent, new_context, summary


def prepare_context_for_chat(agent: Agent, context: RunContext, *, stream: bool = True) -> tuple[Agent, RunContext, str]:
    root = Path(context.metadata["workspace"])
    tools = build_tools(root, root / ".friday")
    if should_compact_conversation(context, tools):
        agent, context, summary = compact_friday(agent, context, stream=stream)
        return agent, context, f"conversation compacted: {summary}"
    if should_compact_tools(context, tools):
        count = compact_tool_results(context, tools)
        return agent, context, f"tool results compacted: {count}"
    return agent, context, ""


def resume_friday(workspace: Path | None = None, *, stream: bool = True, resume_id: str | None = None) -> tuple[Agent, RunContext, int]:
    root = (workspace or Path.cwd()).resolve()
    agent, context = build_friday(root, stream=stream)
    session = _resume_session(root, resume_id)
    if not session:
        return agent, context, 0
    context.metadata["session_id"] = str(session.get("session_id") or context.metadata.get("session_id") or "")
    saved = session.get("messages")
    if isinstance(saved, list) and saved:
        # Keep the freshly built system prefix (current rules, memory, environment)
        # and restore the saved conversation body verbatim. Only the stale leading
        # prefix is dropped; later messages (e.g. compaction summaries, approvals)
        # are kept. No summarization: the original turns come back as-is.
        body = _conversation_body(saved)
        _replace_context_messages(context, [dict(message) for message in context.get_messages()] + body)
    return agent, context, int(session.get("turns", 0) or 0)


def _conversation_body(messages: list[Any]) -> list[dict[str, Any]]:
    body = [dict(message) for message in messages if isinstance(message, dict)]
    start = 0
    while start < len(body) and body[start].get("role") == "system":
        start += 1
    return body[start:]


def _replace_context_messages(context: RunContext, messages: list[Any]) -> None:
    clean = [dict(message) for message in messages if isinstance(message, dict)]
    context.messages = clean
    if context.active_message_scope is not None:
        context.message_scopes[context.active_message_scope] = clean


def resume_choices(workspace: Path | None = None, *, limit: int = 8) -> list[dict[str, str]]:
    root = (workspace or Path.cwd()).resolve()
    choices: list[dict[str, str]] = []
    for path in reversed(_session_files(root)[-limit:]):
        data = _read_session(path)
        if not data:
            continue
        choices.append(
            {
                "assistant": _preview(str(data.get("assistant", ""))),
                "id": str(data.get("session_id") or path.stem),
                "time": str(data.get("updated") or ""),
                "turns": str(data.get("turns", 0)),
                "user": _preview(str(data.get("user", ""))),
            }
        )
    return choices


def ensure_user_home(home: Path | None = None) -> list[Path]:
    """Provision global ~/.friday defaults (model config, prompts, memory, skills).

    Idempotent and cheap, so it runs on startup to give a just-installed Friday a
    populated home without requiring an explicit init. Only missing files are created.
    """
    user_dir = (home or Path.home()) / ".friday"
    user_dir.mkdir(parents=True, exist_ok=True)
    created: list[Path] = []
    for old_name, new_name in (("soul.md", "SOUL.md"), ("user.md", "USER.md")):
        old_path = user_dir / old_name
        new_path = user_dir / new_name
        if old_path.exists() and not _exists_exact(new_path):
            temp_path = user_dir / f".{new_name}.tmp"
            old_path.replace(temp_path)
            temp_path.replace(new_path)
            created.append(new_path)
    for path, content in {
        user_dir / "SOUL.md": _read_resource("SOUL.md"),
        user_dir / "AGENTS.md": _read_resource("AGENTS.md"),
        user_dir / "USER.md": _read_resource("USER.md"),
        user_dir / "MEMORY.md": "# User Memory\n",
        user_dir / "config.json": default_config_text(),
    }.items():
        if not path.exists():
            path.write_text(content, encoding="utf-8")
            created.append(path)
    skills_dir = user_dir / "FridaySkills"
    if not skills_dir.exists():
        skills_dir.mkdir(parents=True, exist_ok=True)
        created.append(skills_dir)
    return created


def init_project(workspace: Path | None = None) -> list[Path]:
    """Create only the project's AGENTS.md.

    Everything else a project uses (memory, permissions, skills, sessions) is
    unrelated to project rules and is created lazily by the runtime when first
    needed. Global ~/.friday defaults are provisioned on startup, not here.
    """
    root = (workspace or Path.cwd()).resolve()
    path = root / "AGENTS.md"
    if path.exists():
        return []
    path.write_text(default_project_instructions(), encoding="utf-8")
    return [path]


def reset_friday(workspace: Path | None = None, *, user_home: Path | None = None, include_user: bool = True) -> list[Path]:
    root = (workspace or Path.cwd()).resolve()
    home = user_home or Path.home()
    removed = []
    project_state = root / ".friday"
    user_state = home / ".friday"
    project_config = _read_optional(project_state / "config.json")
    user_config = _read_optional(user_state / "config.json")
    if project_state.exists():
        shutil.rmtree(project_state)
        removed.append(project_state)
    if include_user and user_state.exists():
        shutil.rmtree(user_state)
        removed.append(user_state)
    ensure_user_home(home)
    if user_config:
        (user_state / "config.json").write_text(user_config, encoding="utf-8")
    if project_config:
        project_state.mkdir(parents=True, exist_ok=True)
        (project_state / "config.json").write_text(project_config, encoding="utf-8")
    return removed


def save_turn(
    workspace: Path,
    user: str,
    assistant: str,
    events: list[dict[str, Any]] | None = None,
    session_id: str | None = None,
    messages: list[dict[str, Any]] | None = None,
) -> Path:
    """Persist one snapshot per session, overwritten in place (atomic).

    The file holds the current full message list plus light index metadata, so
    a session's on-disk size tracks the live context (O(N)) instead of appending
    a full snapshot every turn (O(N^2)).
    """
    sessions = workspace / ".friday" / "sessions"
    sessions.mkdir(parents=True, exist_ok=True)
    sid = session_id or datetime.now().strftime("%Y%m%d%H%M%S%f")
    path = sessions / f"{sid}.json"
    existing = _read_session(path) or {}
    now = datetime.now().isoformat(timespec="seconds")
    snapshot = {
        "session_id": sid,
        "created": existing.get("created") or now,
        "updated": now,
        "turns": int(existing.get("turns", 0) or 0) + 1,
        "user": existing.get("user") or _preview(user, 180),
        "assistant": _preview(assistant, 220),
        "messages": messages or [],
    }
    _write_session(path, snapshot)
    return path


def _write_session(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, dir=path.parent) as file:
        json.dump(data, file, ensure_ascii=False)
        temp_path = Path(file.name)
    temp_path.replace(path)


def _read_session(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    return data if isinstance(data, dict) else None


def _session_files(workspace: Path) -> list[Path]:
    sessions = workspace / ".friday" / "sessions"
    if not sessions.exists():
        return []
    # Session ids are timestamps, so lexical filename order is chronological.
    return sorted(sessions.glob("*.json"))


def _resume_session(workspace: Path, resume_id: str | None) -> dict[str, Any] | None:
    files = _session_files(workspace)
    if not files:
        return None
    if resume_id:
        return _read_session(workspace / ".friday" / "sessions" / f"{resume_id}.json")
    return _read_session(files[-1])


def _preview(text: str, limit: int = 80) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit - 3] + "..."


def _read_resource(name: str) -> str:
    return (files("friday.prompt_templates") / name).read_text(encoding="utf-8")


def _read_optional(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.exists() else ""


def _recent_conversations(context: RunContext) -> str:
    if not hasattr(context, "get_messages"):
        return ""
    turns = []
    for message in context.get_messages():
        role = message.get("role")
        if role not in {"user", "assistant"}:
            continue
        turns.append(f"{str(role).title()}: {_preview(str(message.get('content', '')), 500)}")
    return "\n".join(turns[-RECENT_CONVERSATION_LIMIT * 2 :])


def _exists_exact(path: Path) -> bool:
    return path.exists() and any(child.name == path.name for child in path.parent.iterdir())


def _project_instruction_files(workspace: Path) -> list[str]:
    paths = []
    for parent in reversed([workspace, *workspace.parents]):
        for name in INSTRUCTION_FILE_NAMES:
            path = parent / name
            if path.exists():
                paths.append(path)
    return [f"### {path}\n{_read_limited(path, PROJECT_INSTRUCTIONS_LIMIT)}" for path in paths]


def _read_limited(path: Path, limit: int) -> str:
    text = path.read_text(encoding="utf-8")
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + f"\n\n[truncated: read {path} directly for the rest]"
