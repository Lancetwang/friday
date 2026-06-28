from __future__ import annotations

import json
import platform
import shutil
from datetime import datetime
from importlib.resources import files
from pathlib import Path
from typing import Any

from agent_core import Agent, RunContext

from friday.tools import build_tools, skill_catalog

PROJECT_INSTRUCTIONS_LIMIT = 12000
PRE_COMPACT_MEMORY_PROMPT = """
Before compacting this conversation, review it for durable memory.

Use the Memory tool only for stable user preferences, cross-project facts, or project decisions that should survive the compact.
Do not save transient conversation flow, command output, failed attempts, or the compact summary itself.
If nothing is worth remembering, reply with "No durable memory updates."
""".strip()

COMPACT_PROMPT = """
Summarize the conversation so far for continuing the same task.

Keep only live working context: user goals, decisions, files touched, commands run, test status, blockers, and next steps.
Do not write memory. Do not restate stable system, tool, user, or project instructions.
""".strip()


def build_friday(workspace: Path | None = None, *, stream: bool = True) -> tuple[Agent, RunContext]:
    root = (workspace or Path.cwd()).resolve()
    friday_dir = root / ".friday"
    instructions = build_instructions(root, friday_dir)
    agent = Agent(
        instructions=instructions,
        tools=build_tools(root, friday_dir),
        stream=stream,
        chat_kwargs={"temperature": 0.2, "max_tokens": 1200, "tool_choice": "auto"},
    )
    context = agent.new_context()
    context.metadata["workspace"] = str(root)
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
        COMPACT_PROMPT,
        context=context,
        max_steps=6,
        stream=False,
        on_delta=on_delta,
    )
    workspace = Path(context.metadata["workspace"])
    new_agent, new_context = build_friday(workspace, stream=stream)
    new_context.add_message("system", f"## Conversation Summary\n{summary}")
    return new_agent, new_context, summary


def init_project(workspace: Path | None = None, *, user_home: Path | None = None) -> list[Path]:
    root = (workspace or Path.cwd()).resolve()
    home = user_home or Path.home()
    friday_dir = root / ".friday"
    friday_dir.mkdir(exist_ok=True)
    created = []
    for path, content in {
        root / "AGENTS.md": "# Project Instructions\n\nDescribe how Friday should work in this project.\n",
        friday_dir / "MEMORY.md": "# Project Memory\n",
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


def save_turn(workspace: Path, user: str, assistant: str, events: list[dict[str, Any]]) -> Path:
    sessions = workspace / ".friday" / "sessions"
    sessions.mkdir(parents=True, exist_ok=True)
    path = sessions / f"{datetime.now().strftime('%Y%m%d')}.jsonl"
    row = {
        "time": datetime.now().isoformat(timespec="seconds"),
        "user": user,
        "assistant": assistant,
        "events": events,
    }
    with path.open("a", encoding="utf-8") as file:
        file.write(json.dumps(row, ensure_ascii=False) + "\n")
    return path


def _read_resource(name: str) -> str:
    return (files("friday.prompt_templates") / name).read_text(encoding="utf-8")


def _read_optional(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.exists() else ""


def _exists_exact(path: Path) -> bool:
    return path.exists() and any(child.name == path.name for child in path.parent.iterdir())


def _project_instruction_files(workspace: Path) -> list[str]:
    paths = []
    for parent in [workspace, *workspace.parents]:
        for name in ("AGENTS.md", ".friday/AGENTS.md"):
            path = parent / name
            if path.exists():
                paths.append(path)
    return [f"### {path}\n{_read_limited(path, PROJECT_INSTRUCTIONS_LIMIT)}" for path in reversed(paths)]


def _read_limited(path: Path, limit: int) -> str:
    text = path.read_text(encoding="utf-8")
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + f"\n\n[truncated: read {path} directly for the rest]"


def _runtime_notes() -> str:
    return """
Available tools are Read, Write, Edit, Bash, Glob, Grep, Skill, and Memory.
Use Skill to list on-demand workflows, then read only the relevant SKILL.md.
Use Memory only for durable user preferences, cross-project facts, or project decisions worth keeping.
Memory targets: user updates USER.md, global updates global MEMORY.md, project updates workspace .friday/MEMORY.md.
Memory writes affect disk immediately, but the frozen startup prompt sees them next session.
Bash runs PowerShell on Windows, so prefer PowerShell syntax.
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
