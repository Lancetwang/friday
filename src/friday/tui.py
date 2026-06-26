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

from friday import __version__
from friday.app import build_friday, build_instructions, reset_friday, save_turn

BLUE = "#2f81f7"
CYAN = "#39c5bb"
DIM = "#9aa4b2"
BAR = "white on #30363d"


class FridayTUI:
    def __init__(self, *, stream: bool) -> None:
        self.console = Console()
        self.stream = stream
        self.agent, self.context = build_friday(stream=stream)
        self.context.on_event = self.on_event
        self._streaming = False

    def run(self) -> None:
        self.banner()
        while True:
            text = self.console.input(f"[bold {BLUE}]> [/]").strip()
            if text.lower() in {"exit", "quit", "q", "/exit"}:
                return
            if not text:
                continue
            if text.startswith("/"):
                self.slash(text)
                continue
            self.ask(text)

    def banner(self) -> None:
        body = Table.grid(expand=True)
        body.add_column(width=30)
        body.add_column(width=1)
        body.add_column(ratio=1)
        body.add_row(Text(_logo(), style=f"bold {BLUE}"), Text("│", style=CYAN), self._home())
        self.console.print(
            Panel(
                body,
                title=f"[bold {BLUE}] Friday Code [/][dim]v{__version__}[/]",
                title_align="left",
                border_style=CYAN,
                padding=(0, 2),
            )
        )

    def _home(self) -> Table:
        table = Table.grid(expand=True)
        table.add_column()
        table.add_row(Text("Tips for getting started", style=f"bold {BLUE}"))
        table.add_row(Text("Press / to use commands. Use @ in messages to mention files.", style="bold"))
        table.add_row(Text("Use Shift+Enter in your terminal for multiline input when supported.", style="bold"))
        table.add_row(Text("─" * max(20, self.console.width - 44), style=f"dim {CYAN}"))
        table.add_row(Text("Recent activity", style=f"bold {BLUE}"))
        for item in _recent_activity(Path.cwd()):
            table.add_row(Text(item, style="bold"))
        table.add_row(Text("─" * max(20, self.console.width - 44), style=f"dim {CYAN}"))
        table.add_row(Text(_status_line(), style=f"bold {BLUE}"))
        table.add_row(Text(str(Path.cwd().resolve()), style="bold"))
        return table

    def slash(self, text: str) -> None:
        command = text[1:].strip().lower()
        if command in {"help", "?"}:
            self.console.print(Text("/help  /memory  /reset  /exit", style=f"bold {BLUE}"))
        elif command == "memory":
            body = build_instructions(Path.cwd().resolve(), Path.cwd().resolve() / ".friday")
            self.console.print(Panel(Markdown(body), title="Effective Prompt", border_style=CYAN))
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
        self.agent, self.context = build_friday(stream=self.stream)
        self.context.on_event = self.on_event

    def ask(self, text: str) -> None:
        self.console.print(_bar("> " + text))
        self.console.print("• ", style=f"dim {BLUE}", end="")
        answer = self.agent.chat(
            text,
            context=self.context,
            max_steps=20,
            on_delta=self.on_delta if self.stream else None,
        )
        if self.stream:
            self.console.print()
        else:
            self.console.print(Markdown(answer))
        self.console.print(Text("─" * self.console.width, style=CYAN))
        save_turn(
            Path(self.context.metadata["workspace"]),
            text,
            answer,
            [event.to_dict() for event in self.context.events[-20:]],
        )

    def on_delta(self, text: str) -> None:
        self._streaming = True
        self.console.out(text, end="")

    def on_event(self, event: AgentEvent) -> None:
        if event.type == "tool.call":
            if self._streaming:
                self.console.print()
                self._streaming = False
            name = event.data.get("name", "")
            arguments = _short_json(event.data.get("arguments", {}), self.console.width - len(name) - 12)
            self.console.print(_bar(f"Tool {name} {arguments}"))
        elif event.type == "tool.result" and event.data.get("is_error"):
            self.console.print(_bar(f"Tool error {event.data.get('content', '')}", style="white on #7f1d1d"))


def _bar(text: str, *, style: str = BAR) -> Text:
    clipped = _middle_truncate(text.replace("\n", " "), 120)
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
    return f"{model} · local workspace"


def _logo() -> str:
    return """
███████╗
██╔════╝
█████╗
██╔══╝
██║
╚═╝
""".strip("\n")
