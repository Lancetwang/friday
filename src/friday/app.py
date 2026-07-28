from __future__ import annotations

import hashlib
import re
import shutil
import tomllib
from datetime import datetime
from importlib.metadata import PackageNotFoundError, version as metadata_version
from pathlib import Path
from typing import Any

from agent_core import Agent, RunContext

from friday.agent_flow import build_guarded_flow
from friday.checkpoint import restore_checkpoint
from friday.config import ModelConfig, build_model, default_config_text, load_model_config, load_model_environment
from friday.context import compact_tool_results, should_compact_conversation, should_compact_tools
from friday.prompts import (
    COMPACT_PROMPT,
    default_project_instructions,
    environment,
    prompt_template,
)
from friday.progress import current_progress
from friday.skills import ensure_default_skill, skill_routing
from friday.storage import friday_home, migrate_legacy_runtime, project_state_dir, record_project
from friday.state import (
    SessionState,
    USER_MESSAGE_TIMES_KEY,
    conversation_body,
    hydrate,
    load_session,
    recent_turns,
    resume_choices,
    save_session_state,
    save_turn,
    state_from_snapshot,
    write_session,
)
from friday.tools import INSTRUCTION_FILE_NAMES, PERMISSIONS_FILE, build_tools, default_permissions
from friday.trace import delete_workspace_traces, record_checkpoint_restore

__all__ = [
    "build_friday",
    "build_instructions",
    "compact_friday",
    "ensure_user_home",
    "init_project",
    "prepare_context_for_chat",
    "reset_friday",
    "resume_choices",
    "resume_friday",
    "save_session_state",
    "save_turn",
    "undo_friday",
]

PROJECT_INSTRUCTIONS_LIMIT = 12000
# Replace shipped placeholders only when the user's file is still byte-for-byte equivalent.
LEGACY_PROMPT_DEFAULT_HASHES = {
    "SOUL.md": {
        "51f83d12d3abf88d79a2525bd7f452ff00f5e0cc45d3ef1c75c1002a033049e4",
        "208186ffdd6f46450f9ce8583e131271408b3ffeb405912f50c31b083c978591",
    },
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
    load_model_environment(root)
    ensure_user_home()
    friday_dir = migrate_legacy_runtime(root)
    record_project(root)
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
    expected = _pinned_core_version()
    installed = _installed_core_version()
    if not hasattr(context, "usage") or (expected and installed != expected):
        raise RuntimeError(
            "Incompatible friday-agent-core installation. Reinstall Friday and its pinned dependencies with "
            f"`uv tool install -e \"{_source_root()}\" --force --reinstall`."
        )


def _source_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _pinned_core_version() -> str:
    pyproject = _source_root() / "pyproject.toml"
    if not pyproject.exists():
        return ""
    data = tomllib.loads(pyproject.read_text(encoding="utf-8"))
    for requirement in data.get("project", {}).get("dependencies", []):
        name, separator, pinned = str(requirement).partition("==")
        if separator and name.strip() == "friday-agent-core":
            return pinned.strip()
    return ""


def _installed_core_version() -> str:
    try:
        return metadata_version("friday-agent-core")
    except PackageNotFoundError:
        return ""


def build_instructions(workspace: Path, friday_dir: Path | None = None, config: ModelConfig | None = None) -> str:
    friday_dir = friday_dir or project_state_dir(workspace)
    user_dir = friday_home()
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
        ("Skills", skill_routing()),
        ("Project Instructions", "\n\n".join(_project_instruction_files(workspace))),
        ("Environment", _embedded_markdown(environment(workspace, config))),
        ("Project Memory", _embedded_markdown(_read_optional(friday_dir / "MEMORY.md") or _read_optional(workspace / ".friday" / "MEMORY.md"))),
    ]
    return "\n\n".join(f"## {title}\n{body.strip()}" for title, body in parts if body.strip())


def compact_friday(agent: Agent, context: RunContext, *, stream: bool = True, on_delta: Any = None) -> tuple[Agent, RunContext, str]:
    # One in-band pass: inserted into the current conversation so it reuses the cached
    # prefix. Within this single turn the agent saves memory candidates through Friday's
    # CLI (so compaction never forgets them), then returns the structured summary.
    recent_messages = recent_turns(context.get_messages())
    session_id = str(context.metadata.get("session_id") or "")
    progress = current_progress(context)
    user_message_times = context.metadata.get(USER_MESSAGE_TIMES_KEY, [])
    summary = agent.chat(
        COMPACT_PROMPT,
        context=context,
        max_steps=8,
        stream=False,
        on_delta=on_delta,
    )
    workspace = Path(context.metadata["workspace"])
    new_agent, new_context = build_friday(workspace, stream=stream)
    if hasattr(context, "usage") and hasattr(new_context, "usage"):
        # Deliberate aliasing: the rebuilt context accumulates into the same RunUsage
        # so run-level budget accounting survives compaction.
        new_context.usage = context.usage
    # C1 is the structured state summary. C2 keeps the latest complete turns verbatim,
    # including assistant tool calls and their matching tool results.
    hydrate(
        new_context,
        SessionState(
            session_id=session_id,
            body=[{"role": "assistant", "content": f"## Session Summary\n{summary.strip()}"}, *recent_messages],
            progress=progress,
            user_message_times=[dict(item) for item in user_message_times if isinstance(item, dict)]
            if isinstance(user_message_times, list)
            else [],
        ),
    )
    if session_id:
        save_session_state(workspace, session_id, new_context.get_messages(), current_progress(new_context))
    return new_agent, new_context, summary


def prepare_context_for_chat(agent: Agent, context: RunContext, *, stream: bool = True) -> tuple[Agent, RunContext, str]:
    root = Path(context.metadata["workspace"])
    tools = build_tools(root)
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
    snapshot = load_session(root, resume_id)
    if not snapshot:
        return agent, context, 0
    # Keep the freshly built system prefix (current rules, memory, environment)
    # and replay the saved conversation body verbatim after it. Only the stale
    # leading prefix is dropped; later messages (e.g. compaction summaries,
    # approvals) come back as-is.
    state = state_from_snapshot(snapshot)
    hydrate(context, state)
    return agent, context, state.turns


def undo_friday(
    workspace: Path | None = None,
    *,
    checkpoint_id: str | None = None,
    stream: bool = True,
    force: bool = False,
) -> tuple[Agent, RunContext, dict[str, Any]]:
    root = (workspace or Path.cwd()).resolve()
    restored = restore_checkpoint(root, checkpoint_id=checkpoint_id, force=force)
    agent, context = build_friday(root, stream=stream)
    session_id = str(restored.get("session_id") or context.metadata.get("session_id") or "")
    before_progress = restored.get("before_progress")
    hydrate(
        context,
        SessionState(
            session_id=session_id,
            body=conversation_body(restored["messages"]),
            progress=before_progress if isinstance(before_progress, dict) else {},
            user_message_times=[
                dict(item)
                for item in dict(restored.get("before_session") or {}).get("user_message_times", [])
                if isinstance(item, dict)
            ],
        ),
    )

    session_path = project_state_dir(root) / "sessions" / f"{session_id}.json"
    if restored.get("session_existed"):
        snapshot = {
            **dict(restored.get("before_session") or {}),
            "session_id": session_id,
            "messages": context.get_messages(),
            "progress": current_progress(context),
        }
        write_session(session_path, snapshot)
    elif session_path.exists():
        session_path.unlink()
    record_checkpoint_restore(session_id, str(restored["id"]), list(restored.get("changed_paths") or []))
    return agent, context, restored


def ensure_user_home(home: Path | None = None) -> list[Path]:
    """Provision global ~/.friday defaults (model config, prompts, memory, skills).

    Idempotent and cheap, so it runs on startup to give a just-installed Friday a
    populated home without requiring an explicit init. Only missing files are created.
    """
    user_dir = friday_home(home)
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
    default_skill = ensure_default_skill(user_dir)
    if default_skill is not None:
        created.append(default_skill)
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
    removed = []
    project_state = project_state_dir(root, user_home)
    legacy_project_state = root / ".friday"
    user_state = friday_home(user_home)
    project_config = _read_optional(project_state / "config.json") or _read_optional(legacy_project_state / "config.json")
    user_config = _read_optional(user_state / "config.json")
    delete_workspace_traces(root)
    if project_state.exists():
        shutil.rmtree(project_state)
        removed.append(project_state)
    if legacy_project_state.exists():
        shutil.rmtree(legacy_project_state)
        removed.append(legacy_project_state)
    if include_user and user_state.exists():
        shutil.rmtree(user_state)
        removed.append(user_state)
    ensure_user_home(user_home)
    if user_config:
        (user_state / "config.json").write_text(user_config, encoding="utf-8")
    if project_config:
        project_state.mkdir(parents=True, exist_ok=True)
        (project_state / "config.json").write_text(project_config, encoding="utf-8")
    return removed


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


def _exists_exact(path: Path) -> bool:
    return path.exists() and any(child.name == path.name for child in path.parent.iterdir())


def _project_instruction_files(workspace: Path) -> list[str]:
    documents = []
    global_rules = (friday_home() / "AGENTS.md").resolve()
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
