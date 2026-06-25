from __future__ import annotations

import argparse
import sys
from pathlib import Path

from friday.app import build_friday, build_instructions, init_project, save_turn


def main(argv: list[str] | None = None) -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(prog="friday", description="Friday personal CLI agent.")
    parser.add_argument("--no-stream", action="store_true", help="Disable streaming output.")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("init", help="Create AGENTS.md and Friday memory files.")

    ask = sub.add_parser("ask", help="Ask once.")
    ask.add_argument("text", nargs="+")

    sub.add_parser("chat", help="Start an interactive chat.")
    sub.add_parser("memory", help="Print effective instruction context.")

    args = parser.parse_args(argv)
    command = args.command or "chat"
    stream = not args.no_stream

    if command == "init":
        created = init_project()
        print("created:" if created else "nothing to create")
        for path in created:
            print(path)
        return

    if command == "memory":
        print(build_instructions(Path.cwd().resolve(), Path.cwd().resolve() / ".friday"))
        return

    agent, context = build_friday(stream=stream)

    if command == "ask":
        text = " ".join(args.text)
        answer = _ask(agent, context, text, stream)
        _save(context, text, answer)
        return

    if command == "chat":
        print("Friday. Type 'exit' to quit.")
        while True:
            try:
                text = input("> ").strip()
            except (EOFError, KeyboardInterrupt):
                print()
                return
            if text.lower() in {"exit", "quit", "q"}:
                return
            if not text:
                continue
            answer = _ask(agent, context, text, stream)
            _save(context, text, answer)
        return

    parser.error(f"unknown command: {command}")


def _ask(agent, context, text: str, stream: bool) -> str:
    answer = agent.chat(
        text,
        context=context,
        max_steps=20,
        on_delta=_print_delta if stream else None,
    )
    if stream:
        print()
    else:
        print(answer)
    return answer


def _print_delta(text: str) -> None:
    sys.stdout.write(text)
    sys.stdout.flush()


def _save(context, user: str, assistant: str) -> None:
    workspace = Path(context.metadata["workspace"])
    events = [event.to_dict() for event in context.events[-20:]]
    save_turn(workspace, user, assistant, events)


if __name__ == "__main__":
    main()
