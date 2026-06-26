from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from agent_core import AgentEvent
from rich.console import Console
from rich.markdown import Markdown
from rich.panel import Panel
from rich.prompt import Prompt
from rich.table import Table
from rich.text import Text

from friday.app import build_friday, build_instructions, reset_friday, save_turn

BLUE = "#58a6ff"
DIM = "#7d8590"


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
            text = Prompt.ask(Text("you", style=f"bold {BLUE}")).strip()
            if text.lower() in {"exit", "quit", "q", "/exit"}:
                return
            if not text:
                continue
            if text.startswith("/"):
                self.slash(text)
                continue
            self.ask(text)

    def banner(self) -> None:
        table = Table.grid(expand=True)
        table.add_column(ratio=1)
        table.add_column(justify="right")
        table.add_row(Text("Friday", style=f"bold {BLUE}"), Text(str(Path.cwd().resolve()), style=DIM))
        table.add_row(Text("personal coding agent", style=DIM), Text("/help  /memory  /reset  /exit", style=DIM))
        self.console.print(Panel(table, border_style=BLUE, padding=(1, 2)))

    def slash(self, text: str) -> None:
        command = text[1:].strip().lower()
        if command in {"help", "?"}:
            self.console.print(Panel("/help\n/memory\n/reset\n/exit", title="Commands", border_style=BLUE))
        elif command == "memory":
            body = build_instructions(Path.cwd().resolve(), Path.cwd().resolve() / ".friday")
            self.console.print(Panel(Markdown(body), title="Effective Prompt", border_style=BLUE))
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
        self.console.print(
            Panel(
                "\n".join(str(path) for path in removed) or "nothing removed",
                title="Reset",
                border_style=BLUE,
            )
        )
        self.agent, self.context = build_friday(stream=self.stream)
        self.context.on_event = self.on_event

    def ask(self, text: str) -> None:
        self.console.print(Panel(text, title="You", border_style=BLUE))
        self.console.print(Text("Friday", style=f"bold {BLUE}"))
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
            arguments = _short_json(event.data.get("arguments", {}))
            self.console.print(f"[{BLUE}]Tool[/] [bold]{name}[/] [dim]{arguments}[/]")
        elif event.type == "tool.result":
            if event.data.get("is_error"):
                self.console.print(f"[red]Tool error[/] {event.data.get('content', '')}")
            else:
                self.console.print("[dim]Tool done[/]")


def _short_json(value: Any, limit: int = 220) -> str:
    text = json.dumps(value, ensure_ascii=False)
    return text if len(text) <= limit else text[: limit - 3] + "..."
