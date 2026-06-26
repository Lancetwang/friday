from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any

from agent_core import AgentEvent
from rich.console import Console
from rich.live import Live
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
        self._answer_parts: list[str] = []
        self._live: Live | None = None
        self.show_tool_details = False

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
        self.console.print(
            Panel(
                self._home(),
                title=f"[bold {BLUE}] Friday [/][dim]v{__version__}[/]",
                subtitle=f"[dim]{_command_help()}[/]",
                title_align="left",
                border_style=CYAN,
                padding=(0, 1),
            )
        )

    def _home(self) -> Table:
        table = Table.grid(expand=True)
        table.add_column()
        table.add_row(Text(_status_line(self.stream), style=f"bold {BLUE}"))
        table.add_row(Text(str(Path.cwd().resolve()), style=f"bold {WHITE}"))
        table.add_row(Text("Recent", style=f"bold {BLUE}"))
        for item in _recent_activity(Path.cwd()):
            table.add_row(Text(item, style=f"bold {WHITE}"))
        return table

    def slash(self, text: str) -> None:
        command = text[1:].strip().lower()
        if command in {"help", "?"}:
            self.console.print(Text(_command_help(), style=f"bold {BLUE}"))
        elif command == "details":
            self.show_tool_details = not self.show_tool_details
            state = "on" if self.show_tool_details else "off"
            self.console.print(_bar(f"tool details {state}", limit=self.console.width))
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
        self.agent, self.context = build_friday(stream=self.stream)
        self.context.on_event = self.on_event

    def ask(self, text: str) -> None:
        self._answer_parts = []
        answer = self.agent.chat(
            text,
            context=self.context,
            max_steps=20,
            stream=self.stream,
            on_delta=self.on_delta if self.stream else None,
        )
        if self.stream:
            if self._live is not None:
                self._live.update(_markdown(answer))
                self._live.stop()
                self._live = None
            else:
                self.console.print(_markdown(answer))
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
            self._stop_live()
            name = event.data.get("name", "")
            text = f"Tool {name}"
            if self.show_tool_details:
                arguments = _short_json(event.data.get("arguments", {}), self.console.width - len(name) - 12)
                text = f"{text} {arguments}"
            self.console.print(_bar(text, limit=self.console.width))
        elif event.type == "tool.result" and event.data.get("is_error"):
            self._stop_live()
            self.console.print(_bar(f"Tool error {event.data.get('content', '')}", style="white on #7f1d1d"))

    def on_delta(self, text: str) -> None:
        self._answer_parts.append(text)
        if self._live is None:
            self._live = Live(_markdown(""), console=self.console, refresh_per_second=12)
            self._live.start()
        self._live.update(_markdown("".join(self._answer_parts)))

    def _read_input(self) -> str:
        if not self.console.is_terminal:
            self.console.print(self._rule())
            return input().strip()

        self.console.print(Text(_status_line(self.stream), style=f"dim {CYAN}"))
        text = self.console.input(f"[bold {BLUE}]> [/]")
        return text.strip()

    def _rule(self, *, width_offset: int = 0) -> Text:
        return Text("\u2501" * max(20, self.console.width - width_offset), style=CYAN)

    def _stop_live(self) -> None:
        if self._live is not None:
            self._live.stop()
            self._live = None


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


def _status_line(stream: bool = True) -> str:
    model = os.getenv("LLM_MODEL", "model from .env")
    branch = _git_branch(Path.cwd())
    mode = "stream" if stream else "plain"
    return f"{model} - {branch} - {mode}"


def _git_branch(workspace: Path) -> str:
    try:
        result = subprocess.run(
            ["git", "branch", "--show-current"],
            cwd=workspace,
            capture_output=True,
            text=True,
            timeout=1,
        )
    except Exception:
        return "no git"
    if result.returncode != 0:
        return "no git"
    branch = result.stdout.strip()
    return branch or "detached"


def _command_help() -> str:
    return "/help  /details  /memory  /reset  /exit"


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
