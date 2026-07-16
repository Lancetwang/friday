from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
import tomllib
from datetime import datetime
from importlib.metadata import PackageNotFoundError, distribution
from pathlib import Path
from typing import Any

from agent_core import Agent, RunContext

from friday.agent_flow import build_guarded_flow
from friday.config import ModelConfig, build_model, default_config_text, load_model_config
from friday.context import compact_tool_results, should_compact_conversation, should_compact_tools
from friday.prompts import (
    COMPACT_PROMPT,
    default_project_instructions,
    environment,
    prompt_template,
)
from friday.progress import append_progress_checkpoint, current_progress, is_progress_checkpoint, restore_progress
from friday.tools import INSTRUCTION_FILE_NAMES, PERMISSIONS_FILE, build_tools, default_permissions, skill_catalog

PROJECT_INSTRUCTIONS_LIMIT = 12000
RECENT_CONVERSATION_LIMIT = 10
# Replace shipped placeholders only when the user's file is still byte-for-byte equivalent.
LEGACY_PROMPT_DEFAULT_HASHES = {
    "AGENTS.md": {
        "08c4491f352700d7eb7fc987cbda46e85442e947bdecb07df444f132875ca280",
        "80737c0191f8c9b795c6b6f000f7bcf7ab7b53a3a0d03dd46ba6d8fee456ef3a",
        "54ec6cc42c104c49ede0ef74780db5df2aedf9f2b37a33916b87e2fa59ac94d2",
        "8e1df4cd31007379deb05e847db4f0c0d02f86ec3710269f5cf3a0f578c7cf86",
    },
    "USER.md": {"926239d7d488e0686f4c53b2d00d129433ccb4b5a1340b926e1f93d1cb3c7cdf"},
}


def build_friday(workspace: Path | None = None, *, stream: bool = True) -> tuple[Agent, RunContext]:
    root = (workspace or Path.cwd()).resolve()
    root_env = root / ".env"
    _load_env(root_env)
    _load_env(Path.home() / ".friday" / ".env")
    ensure_user_home(Path.home())
    friday_dir = root / ".friday"
    config = load_model_config(root)
    instructions = build_instructions(root, friday_dir, config)
    tools = build_tools(root, friday_dir)
    agent = Agent(
        flow=build_guarded_flow(
            build_model(config),
            tools,
            chat_kwargs={"stream": stream, "temperature": 0.2, "max_tokens": config.max_output_tokens, "tool_choice": "auto"},
        ),
        instructions=instructions,
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
        "run_token_budget": config.run_token_budget,
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
        ("Soul", _embedded_markdown(_read_optional(user_dir / "SOUL.md") or _read_optional(user_dir / "soul.md") or prompt_template("SOUL.md"))),
        ("Runtime", _embedded_markdown(prompt_template("RUNTIME.md"))),
        ("Tool Guidance", _embedded_markdown(prompt_template("TOOL_GUIDANCE.md"))),
        # Global, user-editable layers: rules, profile, and cross-project memory.
        ("Global Rules", _embedded_markdown(_read_optional(user_dir / "AGENTS.md") or prompt_template("AGENTS.md"))),
        ("User Profile", _embedded_markdown(_read_optional(user_dir / "USER.md") or _read_optional(user_dir / "user.md"))),
        ("Global Memory", _embedded_markdown(_read_optional(user_dir / "MEMORY.md"))),
        # Workspace-specific tail: varies per project, kept after the global prefix.
        ("Skill Catalog", skill_catalog(workspace)),
        ("Project Instructions", "\n\n".join(_project_instruction_files(workspace))),
        ("Environment", _embedded_markdown(environment(workspace, config))),
        ("Project Memory", _embedded_markdown(_read_optional(friday_dir / "MEMORY.md"))),
    ]
    return "\n\n".join(f"## {title}\n{body.strip()}" for title, body in parts if body.strip())


def compact_friday(agent: Agent, context: RunContext, *, stream: bool = True, on_delta: Any = None) -> tuple[Agent, RunContext, str]:
    # One in-band pass: inserted into the current conversation so it reuses the cached
    # prefix. Within this single turn the agent saves durable facts with the Memory tool
    # (so compaction never forgets them), then its final message is the structured summary.
    recent_messages = _recent_turn_messages(context)
    session_id = str(context.metadata.get("session_id") or "")
    progress = current_progress(context)
    summary = agent.chat(
        COMPACT_PROMPT,
        context=context,
        max_steps=8,
        stream=False,
        on_delta=on_delta,
    )
    workspace = Path(context.metadata["workspace"])
    new_agent, new_context = build_friday(workspace, stream=stream)
    if session_id:
        new_context.metadata["session_id"] = session_id
    if hasattr(context, "usage") and hasattr(new_context, "usage"):
        new_context.usage = context.usage
    # C1 is the structured state summary. C2 keeps the latest complete turns verbatim,
    # including assistant tool calls and their matching tool results.
    new_context.add_message("assistant", f"## Session Summary\n{summary.strip()}")
    _replace_context_messages(
        new_context,
        [*map(dict, new_context.get_messages()), *recent_messages],
    )
    restore_progress(new_context, progress)
    append_progress_checkpoint(new_context)
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
    restore_progress(context, session.get("progress"))
    append_progress_checkpoint(context)
    return agent, context, int(session.get("turns", 0) or 0)


def _conversation_body(messages: list[Any]) -> list[dict[str, Any]]:
    body = [dict(message) for message in messages if isinstance(message, dict) and not is_progress_checkpoint(message)]
    start = 0
    while start < len(body) and body[start].get("role") == "system":
        start += 1
    return body[start:]


def _replace_context_messages(context: RunContext, messages: list[Any]) -> None:
    clean = [dict(message) for message in messages if isinstance(message, dict)]
    context.messages = clean
    if context.active_message_scope is not None:
        context.message_scopes[context.active_message_scope] = [dict(message) for message in clean]


def resume_choices(workspace: Path | None = None, *, limit: int = 8) -> list[dict[str, str]]:
    root = (workspace or Path.cwd()).resolve()
    choices: list[dict[str, str]] = []
    for path in reversed(_session_files(root)[-limit:]):
        data = _read_session(path)
        if not data:
            continue
        progress = data.get("progress") if isinstance(data.get("progress"), dict) else {}
        choices.append(
            {
                "assistant": _preview(str(data.get("assistant", ""))),
                "id": str(data.get("session_id") or path.stem),
                "objective": _preview(str(progress.get("objective", ""))),
                "status": str(progress.get("status", "")),
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
    for name, fingerprints in LEGACY_PROMPT_DEFAULT_HASHES.items():
        path = user_dir / name
        if path.exists() and _text_fingerprint(path.read_text(encoding="utf-8")) in fingerprints:
            path.write_text(prompt_template(name), encoding="utf-8")
    for path, content in {
        user_dir / "SOUL.md": prompt_template("SOUL.md"),
        user_dir / "AGENTS.md": prompt_template("AGENTS.md"),
        user_dir / "USER.md": prompt_template("USER.md"),
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
    progress: dict[str, Any] | None = None,
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
        "progress": progress if isinstance(progress, dict) else existing.get("progress", {}),
    }
    _write_session(path, snapshot)
    return path


def save_progress(workspace: Path, session_id: str, progress: dict[str, Any]) -> Path:
    sessions = workspace / ".friday" / "sessions"
    sessions.mkdir(parents=True, exist_ok=True)
    path = sessions / f"{session_id}.json"
    existing = _read_session(path) or {}
    now = datetime.now().isoformat(timespec="seconds")
    snapshot = {
        **existing,
        "session_id": session_id,
        "created": existing.get("created") or now,
        "updated": now,
        "turns": int(existing.get("turns", 0) or 0),
        "user": existing.get("user") or _preview(str(progress.get("objective") or ""), 180),
        "assistant": existing.get("assistant") or "",
        "messages": existing.get("messages") or [],
        "progress": progress,
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


def _read_optional(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.exists() else ""


def _text_fingerprint(text: str) -> str:
    normalized = text.replace("\r\n", "\n").strip()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _embedded_markdown(text: str, *, heading_offset: int = 1) -> str:
    lines = re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL).strip().splitlines()
    if lines and re.match(r"^#\s+", lines[0]):
        lines = lines[1:]

    fence = ""
    output = []
    for line in lines:
        stripped = line.lstrip()
        marker = stripped[:3] if stripped.startswith(("```", "~~~")) else ""
        if marker:
            fence = "" if fence == marker else marker if not fence else fence
        elif not fence:
            match = re.match(r"^(#{1,6})(\s+.*)$", line)
            if match:
                level = min(6, len(match.group(1)) + heading_offset)
                line = "#" * level + match.group(2)
        output.append(line)
    return "\n".join(output).strip()


def _recent_turn_messages(context: RunContext) -> list[dict[str, Any]]:
    if not hasattr(context, "get_messages"):
        return []
    messages = [dict(message) for message in context.get_messages() if isinstance(message, dict) and not is_progress_checkpoint(message)]
    user_indices = [index for index, message in enumerate(messages) if message.get("role") == "user"]
    if not user_indices:
        return []
    return messages[user_indices[-RECENT_CONVERSATION_LIMIT] :]


def _exists_exact(path: Path) -> bool:
    return path.exists() and any(child.name == path.name for child in path.parent.iterdir())


def _project_instruction_files(workspace: Path) -> list[str]:
    documents = []
    global_rules = (Path.home() / ".friday" / "AGENTS.md").resolve()
    for parent in reversed([workspace, *workspace.parents]):
        for name in INSTRUCTION_FILE_NAMES:
            path = parent / name
            if path.exists() and path.resolve() != global_rules:
                body = _embedded_markdown(_read_limited(path, PROJECT_INSTRUCTIONS_LIMIT), heading_offset=2)
                if body:
                    documents.append(f"### {path}\n{body}")
    return documents


def _read_limited(path: Path, limit: int) -> str:
    text = path.read_text(encoding="utf-8")
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + f"\n\n[truncated: read {path} directly for the rest]"
