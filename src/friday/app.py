from __future__ import annotations

import json
from datetime import datetime
from importlib.resources import files
from pathlib import Path
from typing import Any

from agent_core import Agent, RunContext

from friday.tools import build_tools


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
    parts = [
        ("Soul", _read_resource("soul.md")),
        ("Runtime", _runtime_notes()),
        ("User", _read_optional(Path.home() / ".friday" / "user.md")),
        ("User Memory", _read_optional(Path.home() / ".friday" / "MEMORY.md")),
        ("Project Instructions", "\n\n".join(_project_instruction_files(workspace))),
        ("Project Memory", _read_optional(friday_dir / "MEMORY.md")),
    ]
    return "\n\n".join(f"## {title}\n{body.strip()}" for title, body in parts if body.strip())


def init_project(workspace: Path | None = None) -> list[Path]:
    root = (workspace or Path.cwd()).resolve()
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
    user_file = Path.home() / ".friday" / "user.md"
    user_file.parent.mkdir(exist_ok=True)
    if not user_file.exists():
        user_file.write_text("# User Profile\n\nPreferred language, style, and long-term preferences.\n", encoding="utf-8")
        created.append(user_file)
    return created


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
    return (files("friday.prompts") / name).read_text(encoding="utf-8")


def _read_optional(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.exists() else ""


def _project_instruction_files(workspace: Path) -> list[str]:
    paths = []
    for parent in [workspace, *workspace.parents]:
        for name in ("AGENTS.md", ".friday/AGENTS.md"):
            path = parent / name
            if path.exists():
                paths.append(path)
    return [f"### {path}\n{path.read_text(encoding='utf-8')}" for path in reversed(paths)]


def _runtime_notes() -> str:
    return """
Available tools are read_file, write_file, edit_file, run_shell, read_memory, and remember.
Use read_file before editing unfamiliar files.
Use remember only for durable facts or preferences worth keeping.
For Windows shell commands, prefer PowerShell syntax.
""".strip()
