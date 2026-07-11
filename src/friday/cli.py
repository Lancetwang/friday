from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from friday.app import build_friday, build_instructions, compact_friday, init_project, reset_friday, resume_friday
from friday.context import context_report
from friday.tui_node import run_tui
from friday.tools import approve_pending, build_tools
from friday.turn import run_turn


def main(argv: list[str] | None = None) -> None:
    _configure_stdio()

    parser = argparse.ArgumentParser(prog="friday", description="Friday personal CLI agent.")
    parser.add_argument("--no-stream", action="store_true", help="Disable streaming output.")
    parser.add_argument("--permission-mode", choices=["manual", "accept-edits", "dont-ask", "bypass"], default=None)
    parser.add_argument("--dangerously-skip-permissions", action="store_true", help="Bypass command approvals for sandboxed runs.")
    parser.add_argument("--permission-allow", "--permission_allow", action="store_true", help="Alias for --dangerously-skip-permissions.")
    parser.add_argument("--allowed-tools", "--allowedTools", action="append", default=[])
    parser.add_argument("--disallowed-tools", "--disallowedTools", action="append", default=[])
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("init", help="Create the project's AGENTS.md.")

    ask = sub.add_parser("ask", help="Ask once.")
    ask.add_argument("text", nargs="+")

    sub.add_parser("chat", help="Start an interactive chat.")
    sub.add_parser("tui", help="Start a simple terminal UI.")
    sub.add_parser("memory", help="Print effective instruction context.")
    sub.add_parser("context", help="Print current context usage.")
    sub.add_parser("resume", help="Resume recent Friday session context.")
    sub.add_parser("approve", help="Approve one pending dangerous shell command.")
    sub.add_parser("reject", help="Reject one pending dangerous shell command.")
    reset = sub.add_parser("reset", help="Clear Friday memory and session state.")
    reset.add_argument("-y", "--yes", action="store_true", help="Skip reset confirmation.")

    args = parser.parse_args(argv)
    _configure_permissions(args)
    command = args.command or "tui"
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

    if command == "context":
        agent, context = build_friday(stream=stream)
        print(_context_report(context))
        return

    if command == "approve":
        print(json_dump(approve_pending()))
        return

    if command == "reject":
        print(json_dump(approve_pending(reject=True)))
        return

    if command == "reset":
        _reset(args.yes)
        return

    if command == "tui":
        run_tui()
        return

    if command == "resume":
        agent, context, count = resume_friday(stream=stream)
        print(f"resumed {count} turns")
        command = "chat"
    else:
        agent, context = build_friday(stream=stream)

    if command == "ask":
        text = " ".join(args.text)
        _ask(agent, context, text, stream)
        return

    if command == "chat":
        print("Friday. Type /help for commands.")
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
            if text.startswith("/"):
                agent, context = _slash(text, stream, agent, context)
                continue
            agent, context, _ = _ask(agent, context, text, stream)
        return

    parser.error(f"unknown command: {command}")


def _configure_stdio() -> None:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")


def _configure_permissions(args) -> None:
    mode = args.permission_mode or "manual"
    if args.dangerously_skip_permissions or args.permission_allow:
        mode = "bypass"
    os.environ["FRIDAY_PERMISSION_MODE"] = mode
    if args.allowed_tools:
        os.environ["FRIDAY_ALLOWED_TOOLS"] = json.dumps(args.allowed_tools, ensure_ascii=False)
    if args.disallowed_tools:
        os.environ["FRIDAY_DISALLOWED_TOOLS"] = json.dumps(args.disallowed_tools, ensure_ascii=False)


def _slash(text: str, stream: bool, agent, context):
    command = text[1:].strip().lower()
    if command in {"help", "?"}:
        print("/help, /memory, /context, /compact, /goal <text>, /resume, /approve, /reject, /reset, /exit")
    elif command == "memory":
        print(build_instructions(Path.cwd().resolve(), Path.cwd().resolve() / ".friday"))
    elif command == "context":
        print(_context_report(context))
    elif command == "compact":
        agent, context, summary = compact_friday(agent, context, stream=stream)
        print("compacted conversation:")
        print(summary)
    elif command == "resume":
        agent, context, count = resume_friday(stream=stream)
        print(f"resumed {count} turns")
    elif command.startswith("goal"):
        goal = text.split(" ", 1)[1].strip() if " " in text else ""
        if not goal:
            print("usage: /goal describe the goal")
        else:
            agent, context, _ = _goal(agent, context, goal, stream)
    elif command == "approve":
        result = approve_pending()
        print(json_dump(result))
        if result.get("approved"):
            agent, context, _ = _ask(
                agent,
                context,
                _approval_followup_prompt(),
                stream,
                approval_result=result,
                user_label="/approve",
            )
    elif command == "reject":
        print(json_dump(approve_pending(reject=True)))
    elif command == "reset":
        if _reset(False):
            agent, context = build_friday(stream=stream)
    elif command in {"exit", "quit", "q"}:
        raise SystemExit
    else:
        print(f"unknown slash command: /{command}")
    return agent, context


def _reset(yes: bool) -> bool:
    targets = [
        Path.cwd().resolve() / ".friday",
        Path.home() / ".friday",
    ]
    print("This will delete Friday project state and global Friday user state:")
    for path in targets:
        print(f"- {path}")
    if not yes:
        confirm = input("Type RESET to continue: ").strip()
        if confirm != "RESET":
            print("cancelled")
            return False
    removed = reset_friday(include_user=True)
    print("reset Friday")
    for path in removed:
        print(f"removed {path}")
    return True


def _ask(agent, context, text: str, stream: bool, *, approval_result=None, user_label: str | None = None):
    result = run_turn(
        agent,
        context,
        text,
        stream=stream,
        on_delta=_print_delta if stream else None,
        on_context_notice=lambda notice: print(f"[context] {notice.split(':', 1)[0]}"),
        approval_result=approval_result,
        user_label=user_label,
    )
    if stream:
        print()
    else:
        print(result.answer)
    for verification in result.verifications:
        print(f"[verify] {'passed' if verification.get('passed') else 'failed'}")
        if verification.get("feedback"):
            print(verification["feedback"])
    return result.agent, result.context, result.answer


def _goal(agent, context, text: str, stream: bool):
    result = run_turn(
        agent,
        context,
        text,
        goal=True,
        stream=stream,
        on_delta=_print_delta if stream else None,
        on_context_notice=lambda notice: print(f"[context] {notice.split(':', 1)[0]}"),
    )
    if stream:
        print()
    else:
        print(result.answer)
    for verification in result.verifications:
        status = "passed" if verification.get("passed") else "blocked" if verification.get("blocked") else "failed"
        print(f"[goal verify] attempt {verification.get('attempt')}: {status}")
        if verification.get("feedback"):
            print(verification["feedback"])
    return result.agent, result.context, result.answer


def _print_delta(text: str) -> None:
    sys.stdout.write(text)
    sys.stdout.flush()


def json_dump(value) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2)


def _context_report(context) -> str:
    root = Path(context.metadata["workspace"])
    return context_report(context, build_tools(root, root / ".friday"))


def _approval_followup_prompt() -> str:
    return "The approved command has executed. Report the result to the user and continue only if another action is needed."


if __name__ == "__main__":
    main()
