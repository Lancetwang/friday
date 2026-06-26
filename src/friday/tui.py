from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from agent_core import AgentEvent
from rich.console import Console
from rich.markdown import Markdown
from rich.panel import Panel
from rich.prompt import Prompt
from rich.table import Table
from rich.text import Text
from rich.theme import Theme

from friday import __version__
from friday.app import build_friday, build_instructions, reset_friday, save_turn

BLUE = "#2f81f7"
CYAN = "#39c5bb"
WHITE = "#f0f6fc"
DIM = "#9aa4b2"
BAR = "white on #30363d"


class FridayTUI:
    def __init__(self, *, stream: bool) -> None:
        self.console = Console(theme=_theme())
        self.stream = stream
        self.agent, self.context = build_friday(stream=stream)
        self.context.on_event = self.on_event

    def run(self) -> None:
        self.banner()
        while True:
            text = self._read_input()
            if text.lower() in {"exit", "quit", "q", "/exit"}:
                return
            if not text:
                continue
            self.console.print(_bar("> " + text, limit=self.console.width))
            if text.startswith("/"):
                self.slash(text)
                continue
            self.ask(text)

    def banner(self) -> None:
        body = Table.grid(expand=True)
        body.add_column(width=30)
        body.add_column(width=1)
        body.add_column(ratio=1)
        body.add_row(_robot_icon(), Text(("|\n" * 14).rstrip(), style=f"dim {CYAN}"), self._home())
        self.console.print(
            Panel(
                body,
                title=f"[bold {BLUE}] Friday [/][dim]v{__version__}[/]",
                title_align="left",
                border_style=CYAN,
                padding=(0, 2),
            )
        )

    def _home(self) -> Table:
        table = Table.grid(expand=True)
        table.add_column()
        table.add_row(Text("Tips for getting started", style=f"bold {BLUE}"))
        table.add_row(Text("Press / to use commands. Use @ in messages to mention files.", style=f"bold {WHITE}"))
        table.add_row(Text("Shift+Enter adds a new line when your terminal supports it.", style=f"bold {WHITE}"))
        table.add_row(self._rule(width_offset=44))
        table.add_row(Text("Recent activity", style=f"bold {BLUE}"))
        for item in _recent_activity(Path.cwd()):
            table.add_row(Text(item, style=f"bold {WHITE}"))
        table.add_row(self._rule(width_offset=44))
        table.add_row(Text(_status_line(), style=f"bold {BLUE}"))
        table.add_row(Text(str(Path.cwd().resolve()), style=f"bold {WHITE}"))
        return table

    def slash(self, text: str) -> None:
        command = text[1:].strip().lower()
        if command in {"help", "?"}:
            self.console.print(Text("/help  /memory  /reset  /exit", style=f"bold {BLUE}"))
        elif command == "memory":
            body = build_instructions(Path.cwd().resolve(), Path.cwd().resolve() / ".friday")
            self.console.print(Panel(_markdown(body), title="Effective Prompt", border_style=CYAN))
        elif command == "reset":
            self.reset()
        else:
            self.console.print(f"[red]unknown slash command:[/] /{command}")

    def reset(self) -> None:
        self.console.print("[yellow]This deletes project .friday and global ~/.friday.[/]")
        if Prompt.ask("Type RESET to continue", default="") != "RESET":
            self.console.print("[dim]cancelled[/]")
            return
        removed = reset_friday(include_user=True)
        self.console.print(_bar("Reset " + (", ".join(str(path) for path in removed) or "nothing removed")))
        self.agent, self.context = build_friday(stream=False)
        self.context.on_event = self.on_event

    def ask(self, text: str) -> None:
        answer = self.agent.chat(
            text,
            context=self.context,
            max_steps=20,
            stream=self.stream,
            on_delta=self.on_delta if self.stream else None,
        )
        if self.stream:
            self.console.print()
        else:
            self.console.print(_markdown(answer))
        save_turn(
            Path(self.context.metadata["workspace"]),
            text,
            answer,
            [event.to_dict() for event in self.context.events[-20:]],
        )

    def on_event(self, event: AgentEvent) -> None:
        if event.type == "tool.call":
            name = event.data.get("name", "")
            arguments = _short_json(event.data.get("arguments", {}), self.console.width - len(name) - 12)
            self.console.print(_bar(f"Tool {name} {arguments}", limit=self.console.width))
        elif event.type == "tool.result" and event.data.get("is_error"):
            self.console.print(_bar(f"Tool error {event.data.get('content', '')}", style="white on #7f1d1d"))

    def on_delta(self, text: str) -> None:
        self.console.out(text, end="")

    def _read_input(self) -> str:
        if not self.console.is_terminal:
            self.console.print(self._rule())
            return input().strip()

        self.console.print(self._rule())
        self.console.print()
        self.console.print(self._rule())
        self.console.file.write("\x1b[2A")
        self.console.file.flush()
        text = self.console.input(f"[bold {BLUE}]> [/]")
        self.console.file.write("\r\x1b[2K\x1b[1A\r\x1b[2K\x1b[1A\r\x1b[2K")
        self.console.file.flush()
        return text.strip()

    def _rule(self, *, width_offset: int = 0) -> Text:
        return Text("█" * max(20, self.console.width - width_offset), style=CYAN)


def _markdown(text: str) -> Markdown:
    return Markdown(text, code_theme="monokai", inline_code_theme="monokai", style=WHITE)


def _bar(text: str, *, style: str = BAR, limit: int = 120) -> Text:
    clipped = _middle_truncate(text.replace("\n", " "), limit)
    return Text(clipped, style=style)


def _short_json(value: Any, limit: int = 160) -> str:
    return _middle_truncate(json.dumps(value, ensure_ascii=False), max(20, limit))


def _middle_truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    keep = max(8, (limit - 3) // 2)
    return text[:keep] + "..." + text[-keep:]


def _recent_activity(workspace: Path, limit: int = 3) -> list[str]:
    sessions = workspace / ".friday" / "sessions"
    files = sorted(sessions.glob("*.jsonl"), reverse=True) if sessions.exists() else []
    items = []
    for file in files:
        for line in reversed(file.read_text(encoding="utf-8", errors="replace").splitlines()):
            try:
                items.append(json.loads(line).get("user", ""))
            except json.JSONDecodeError:
                continue
            if len(items) >= limit:
                return items
    return items or ["No recent activity yet.", "/help"]


def _status_line() -> str:
    model = os.getenv("LLM_MODEL", "model from .env")
    return f"{model} - local workspace"


def _robot_icon() -> Text:
    pattern = [
        " 11  11 ",
        " 111111 ",
        "11    11",
        "11 1  11",
        "11  1 11",
        "11    11",
        "11    11",
        " 111111 ",
    ]
    text = Text()
    for row in pattern:
        for char in row:
            text.append("[]" if char == "1" else "  ", style=f"bold {BLUE}" if char == "1" else "")
        text.append("\n")
    return text


def _theme() -> Theme:
    return Theme(
        {
            "markdown": WHITE,
            "markdown.paragraph": WHITE,
            "markdown.item": WHITE,
            "markdown.strong": f"bold {BLUE}",
            "markdown.em": CYAN,
            "markdown.h1": f"bold {BLUE}",
            "markdown.h2": f"bold {BLUE}",
            "markdown.h3": f"bold {BLUE}",
            "markdown.code": f"{WHITE} on #0b1f3a",
            "markdown.code_block": f"{WHITE} on #0b1f3a",
            "markdown.block_quote": DIM,
        }
    )
