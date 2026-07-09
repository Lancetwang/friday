from __future__ import annotations

import json
import platform
import re
import shutil
from datetime import datetime
from importlib.resources import files
from pathlib import Path
from typing import Any

from agent_core import Agent, RunContext

from friday.context import compact_tool_results, should_compact_conversation, should_compact_tools
from friday.tools import INSTRUCTION_FILE_NAMES, PERMISSIONS_FILE, build_tools, default_permissions, skill_catalog

PROJECT_INSTRUCTIONS_LIMIT = 12000
RECENT_CONVERSATION_LIMIT = 10
STATE_FILE = "STATE.md"
PRE_COMPACT_MEMORY_PROMPT = """
Before compacting this conversation, review it for durable memory.

Use the Memory tool only for stable user preferences, cross-project facts, or project decisions that should survive the compact.
Do not save transient conversation flow, command output, failed attempts, or the compact summary itself.
If nothing is worth remembering, reply with "No durable memory updates."
""".strip()

COMPACT_PROMPT = """
Compact the conversation into short-term session state for continuing the same task.

Use this exact Markdown structure:
## Current Goal
## Completed
## Open Items
## Tried Methods
## Decisions
## Working Files
## Commands And Results
## Verification State
## Next Steps
## Recent Conversations

Keep only live working context: user goals, completed work, unfinished work, tried methods, decisions, files touched, commands run, test status, blockers, and next steps.
Recent Conversations must preserve the latest user/assistant turns needed to continue naturally.
Do not write memory. Do not restate stable system, tool, user, or project instructions.
""".strip()


def build_friday(workspace: Path | None = None, *, stream: bool = True) -> tuple[Agent, RunContext]:
    root = (workspace or Path.cwd()).resolve()
    friday_dir = root / ".friday"
    _ensure_short_state(friday_dir)
    instructions = build_instructions(root, friday_dir)
    agent = Agent(
        instructions=instructions,
        tools=build_tools(root, friday_dir),
        stream=stream,
        chat_kwargs={"temperature": 0.2, "max_tokens": 1200, "tool_choice": "auto"},
    )
    context = agent.new_context()
    context.metadata["workspace"] = str(root)
    context.metadata["session_id"] = datetime.now().strftime("%Y%m%d%H%M%S%f")
    state = _read_optional(friday_dir / STATE_FILE)
    if state.strip():
        context.add_message("system", f"## Short-Term State\n{state}")
    return agent, context


def build_instructions(workspace: Path, friday_dir: Path) -> str:
    user_dir = Path.home() / ".friday"
    parts = [
        ("Soul", _read_optional(user_dir / "SOUL.md") or _read_optional(user_dir / "soul.md") or _read_resource("SOUL.md")),
        ("Runtime", _runtime_notes()),
        ("Tool Guidance", _tool_guidance()),
        ("Skill Catalog", skill_catalog(workspace)),
        ("User Profile", _read_optional(user_dir / "USER.md") or _read_optional(user_dir / "user.md")),
        ("Global Memory", _read_optional(user_dir / "MEMORY.md")),
        ("Project Instructions", "\n\n".join(_project_instruction_files(workspace))),
        ("Environment", _environment(workspace)),
        ("Project Memory", _read_optional(friday_dir / "MEMORY.md")),
    ]
    return "\n\n".join(f"## {title}\n{body.strip()}" for title, body in parts if body.strip())


def compact_friday(agent: Agent, context: RunContext, *, stream: bool = True, on_delta: Any = None) -> tuple[Agent, RunContext, str]:
    agent.chat(
        PRE_COMPACT_MEMORY_PROMPT,
        context=context,
        max_steps=6,
        stream=False,
    )
    summary = agent.chat(
        f"{COMPACT_PROMPT}\n\nLatest turns to keep under Recent Conversations:\n{_recent_conversations(context)}",
        context=context,
        max_steps=6,
        stream=False,
        on_delta=on_delta,
    )
    workspace = Path(context.metadata["workspace"])
    _write_short_state(workspace, summary)
    new_agent, new_context = build_friday(workspace, stream=stream)
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
    rows = _resume_rows(root, resume_id)
    messages = rows[-1].get("messages") if rows else None
    if isinstance(messages, list):
        _replace_context_messages(context, messages)
        context.metadata["session_id"] = str(rows[-1].get("session_id") or context.metadata.get("session_id") or "")
    elif rows:
        content = "\n\n".join(f"User: {row.get('user', '')}\nFriday: {row.get('assistant', '')}" for row in rows)
        context.add_message("system", f"## Resumed Session\n{content}")
    return agent, context, len(rows)


def _replace_context_messages(context: RunContext, messages: list[Any]) -> None:
    clean = [dict(message) for message in messages if isinstance(message, dict)]
    context.messages = clean
    if context.active_message_scope is not None:
        context.message_scopes[context.active_message_scope] = clean


def resume_choices(workspace: Path | None = None, *, limit: int = 8) -> list[dict[str, str]]:
    root = (workspace or Path.cwd()).resolve()
    groups = list(reversed(_session_groups(root)[-limit:]))
    return [
        {
            "assistant": _preview(str(group["rows"][-1].get("assistant", ""))),
            "id": str(group["id"]),
            "time": _session_time(group["rows"]),
            "turns": str(len(group["rows"])),
            "user": _preview(str(group["rows"][0].get("user", ""))),
        }
        for group in groups
    ]


def init_project(workspace: Path | None = None, *, user_home: Path | None = None) -> list[Path]:
    root = (workspace or Path.cwd()).resolve()
    home = user_home or Path.home()
    friday_dir = root / ".friday"
    friday_dir.mkdir(exist_ok=True)
    created = []
    for path, content in {
        root / "FRIDAY.md": _default_friday_project_instructions(),
        friday_dir / "MEMORY.md": "# Project Memory\n",
        friday_dir / STATE_FILE: _default_short_state(),
        friday_dir / PERMISSIONS_FILE: json.dumps(default_permissions(), ensure_ascii=False, indent=2) + "\n",
    }.items():
        if not path.exists():
            path.write_text(content, encoding="utf-8")
            created.append(path)
    user_dir = home / ".friday"
    user_dir.mkdir(parents=True, exist_ok=True)
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
        user_dir / "USER.md": _read_resource("USER.md"),
        user_dir / "MEMORY.md": "# User Memory\n",
    }.items():
        if not path.exists():
            path.write_text(content, encoding="utf-8")
            created.append(path)
    return created


def reset_friday(workspace: Path | None = None, *, user_home: Path | None = None, include_user: bool = True) -> list[Path]:
    root = (workspace or Path.cwd()).resolve()
    home = user_home or Path.home()
    removed = []
    project_state = root / ".friday"
    user_state = home / ".friday"
    if project_state.exists():
        shutil.rmtree(project_state)
        removed.append(project_state)
    if include_user and user_state.exists():
        shutil.rmtree(user_state)
        removed.append(user_state)
    init_project(root, user_home=home)
    return removed


def save_turn(
    workspace: Path,
    user: str,
    assistant: str,
    events: list[dict[str, Any]],
    session_id: str | None = None,
    messages: list[dict[str, Any]] | None = None,
) -> Path:
    sessions = workspace / ".friday" / "sessions"
    sessions.mkdir(parents=True, exist_ok=True)
    path = sessions / f"{datetime.now().strftime('%Y%m%d')}.jsonl"
    row = {
        "time": datetime.now().isoformat(timespec="seconds"),
        "user": user,
        "assistant": assistant,
        "messages": messages or [],
        "session_id": session_id or datetime.now().strftime("%Y%m%d%H%M%S%f"),
    }
    with path.open("a", encoding="utf-8") as file:
        file.write(json.dumps(row, ensure_ascii=False) + "\n")
    _append_recent_state(workspace, user, assistant)
    return path


def _recent_turns(workspace: Path, limit: int) -> list[dict[str, Any]]:
    rows = _resume_rows(workspace, None)
    return rows[-limit:]


def _resume_rows(workspace: Path, resume_id: str | None) -> list[dict[str, Any]]:
    groups = _session_groups(workspace)
    if not groups:
        return []
    group = groups[-1]
    if resume_id:
        for item in groups:
            if item["id"] == resume_id:
                group = item
                break
    return group["rows"]


def _session_groups(workspace: Path) -> list[dict[str, Any]]:
    sessions = workspace / ".friday" / "sessions"
    if not sessions.exists():
        return []
    groups: dict[str, dict[str, Any]] = {}
    for path in sorted(sessions.glob("*.jsonl")):
        lines = path.read_text(encoding="utf-8").splitlines()
        kept = []
        for line in lines:
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            session_id = row.get("session_id")
            if not session_id:
                continue
            kept.append(line)
            session_id = str(session_id)
            group = groups.setdefault(session_id, {"id": session_id, "rows": []})
            group["rows"].append(row)
        if len(kept) == len(lines):
            continue
        if kept:
            path.write_text("\n".join(kept) + "\n", encoding="utf-8")
        else:
            path.unlink()
    return sorted(groups.values(), key=lambda group: str(group["rows"][-1].get("time", "")))


def _session_time(rows: list[dict[str, Any]]) -> str:
    first = str(rows[0].get("time", ""))
    last = str(rows[-1].get("time", ""))
    return first if first == last else f"{first} - {last}"


def _preview(text: str, limit: int = 80) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit - 3] + "..."


def _read_resource(name: str) -> str:
    return (files("friday.prompt_templates") / name).read_text(encoding="utf-8")


def _read_optional(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.exists() else ""


def _ensure_short_state(friday_dir: Path) -> None:
    path = friday_dir / STATE_FILE
    if path.exists():
        return
    friday_dir.mkdir(parents=True, exist_ok=True)
    path.write_text(_default_short_state(), encoding="utf-8")


def _write_short_state(workspace: Path, content: str) -> None:
    path = workspace / ".friday" / STATE_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content.rstrip() + "\n", encoding="utf-8")


def _append_recent_state(workspace: Path, user: str, assistant: str) -> None:
    path = workspace / ".friday" / STATE_FILE
    current = path.read_text(encoding="utf-8") if path.exists() else _default_short_state()
    head = current.split("## Recent Conversations", 1)[0].rstrip()
    recent = _state_recent(current)
    recent.append(f"- User: {_preview(user, 180)}\n  Friday: {_preview(assistant, 220)}")
    recent = recent[-RECENT_CONVERSATION_LIMIT:]
    updated = f"{head}\n\n## Recent Conversations\n" + "\n".join(recent) + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(updated, encoding="utf-8")


def _state_recent(text: str) -> list[str]:
    if "## Recent Conversations" not in text:
        return []
    body = text.split("## Recent Conversations", 1)[1]
    next_section = re.search(r"\n##\s+", body)
    if next_section:
        body = body[: next_section.start()]
    items = []
    current: list[str] = []
    for line in body.splitlines():
        if line.startswith("- User:") and current:
            items.append("\n".join(current).rstrip())
            current = [line]
        elif line.strip() or current:
            current.append(line)
    if current:
        items.append("\n".join(current).rstrip())
    return [item for item in items if item.strip()]


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


def _default_short_state() -> str:
    return """# Short-Term State

## Current Goal

## Completed

## Open Items

## Tried Methods

## Decisions

## Working Files

## Commands And Results

## Verification State

## Next Steps

## Recent Conversations
"""


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


def _runtime_notes() -> str:
    return """
Available tools are Read, Write, Edit, Bash, Glob, Grep, Skill, and Memory.

Project instructions:
AGENTS.md is cross-agent project guidance. FRIDAY.md is Friday-specific project guidance. FRIDAY.local.md is private local Friday guidance.
Nested instruction files are loaded once when tools touch files under that directory. Later project instructions override earlier ones.

Skills:
The startup prompt contains only skill names and descriptions. Use Skill to list on-demand workflows, then read only the relevant SKILL.md.

Memory:
Use Memory only for durable user preferences, cross-project facts, or project decisions worth keeping.
Memory targets: user updates USER.md, global updates global MEMORY.md, project updates workspace .friday/MEMORY.md.
Memory writes affect disk immediately, but the frozen startup prompt sees them next session.
Do not save temporary task progress, raw command output, compact summaries, permission rules, or project rules as memory.
SOUL.md, AGENTS.md, FRIDAY.md, FRIDAY.local.md, and permission files require an explicit user request before editing.

Short-term state:
Use workspace .friday/STATE.md for current task state: current goal, completed work, open items, tried methods, working files, verification state, next steps, and recent conversations.
Update STATE.md when the task goal or important progress changes. It is session state, not durable memory.

Permissions:
Bash commands are checked against workspace .friday/permissions.json before execution.
One-shot pending approvals live in workspace .friday/pending_approval.json and are deleted after /approve or /reject.
Persistent allow, deny, or require-approval changes require an explicit user request.

Context:
Keep stable prefix content before volatile session content.
Compact large tool results before compacting conversation history.
Before conversation compact, review durable facts and save only true memory.

Verification:
After a turn changes deliverables, Friday may run an independent verifier agent before returning final state.
The verifier checks the workspace state against the user goal and does not trust the main agent's claims.
Failed verification feedback is sent back to the main agent for one repair attempt.
Goal mode runs repeated main-agent attempts with verifier feedback until pass, blocked, or attempt limit.

Bash runs PowerShell on Windows, so prefer PowerShell syntax.
Dangerous Bash commands are blocked for user approval; tell the user to run /approve or /reject.
""".strip()


def _tool_guidance() -> str:
    return """
- Use Glob to find paths instead of Bash ls/find.
- Use Grep to search contents instead of Bash grep/rg.
- Use Read before editing unfamiliar files.
- Use Edit for partial changes.
- Use Write only when replacing the whole file.
""".strip()


def _environment(workspace: Path) -> str:
    return f"""
- Workspace: {workspace}
- Platform: {platform.system()}
- Shell: {"PowerShell" if platform.system() == "Windows" else "bash"}
""".strip()


def _default_friday_project_instructions() -> str:
    return """# Friday Project Instructions

Tell Friday how to work in this project.

## Commands

- Install:
- Test:
- Run:
- Lint:

## Friday Rules

- Keep project-specific Friday rules here.
- Put cross-agent project rules in `AGENTS.md`.
- Put durable project facts in `.friday/MEMORY.md`.
- Put short-term task state in `.friday/STATE.md`.
- Put persistent Bash permissions in `.friday/permissions.json`.

## Notes

-
"""
