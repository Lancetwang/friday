from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from friday.app import build_friday, build_instructions, compact_friday, ensure_user_home, init_project, reset_friday, resume_choices, resume_friday
from friday.context import context_report
from friday.memory import (
    add_memory,
    consolidate_memory,
    format_memory_result,
    list_memories,
    memory_status,
    remove_memory,
    run_memory_command,
    search_memories,
    update_memory,
)
from friday.progress import current_progress, finish_progress, progress_line
from friday.skills import discover_skills
from friday.tui_node import run_tui
from friday.tools import allow_permissions_for_session, approve_pending, build_tools
from friday.trace import behavior_events, list_traces, load_trace, trace_stats
from friday.trace_web import serve_trace_ui, start_trace_server
from friday.turn import run_turn


def main(argv: list[str] | None = None) -> None:
    _configure_stdio()
    argv = _help_alias(list(sys.argv[1:] if argv is None else argv))

    parser = argparse.ArgumentParser(prog="friday", description="Friday general-purpose local CLI agent.")
    parser.add_argument("--no-stream", action="store_true", help="Disable streaming output.")
    parser.add_argument("--permission-mode", choices=["manual", "accept-edits", "dont-ask", "bypass"], default=None)
    parser.add_argument("--dangerously-skip-permissions", action="store_true", help="Bypass command approvals for sandboxed runs.")
    parser.add_argument("--permission-allow", "--permission_allow", action="store_true", help="Alias for --dangerously-skip-permissions.")
    parser.add_argument("--allowed-tools", "--allowedTools", action="append", default=[])
    parser.add_argument("--disallowed-tools", "--disallowedTools", action="append", default=[])
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("init", help="Create the project's AGENTS.md.")

    skill = sub.add_parser("skill", help="Inspect reusable Friday skills.", description="Inspect reusable Friday skills.")
    skill_sub = skill.add_subparsers(dest="skill_command", required=True)
    skill_list = skill_sub.add_parser("list", help="List skill metadata and SKILL.md paths.")
    skill_list.add_argument("--json", action="store_true", help="Print machine-readable JSON.")

    ask = sub.add_parser("ask", help="Ask once.")
    ask.add_argument("--stdin", action="store_true", help="Read the request from standard input.")
    ask.add_argument("text", nargs="*")

    sub.add_parser("chat", help="Start an interactive chat.")
    sub.add_parser("tui", help="Start a simple terminal UI.")
    sub.add_parser("prompt", help="Print the effective instruction context.")
    memory = sub.add_parser("memory", help="Inspect and manage Friday memory.", description="Inspect and manage Friday memory.")
    memory_sub = memory.add_subparsers(dest="memory_command")
    memory_status_parser = memory_sub.add_parser("status", help="Show memory counts, sizes, and paths.")
    memory_status_parser.add_argument("--json", action="store_true")
    memory_list = memory_sub.add_parser("list", help="List memory entries.")
    memory_list.add_argument("scope", nargs="?", choices=["all", "user", "global", "project", "episode"], default="all")
    memory_list.add_argument("--json", action="store_true")
    memory_search = memory_sub.add_parser("search", help="Search Markdown memory.")
    memory_search.add_argument("query", nargs="+")
    memory_search.add_argument("--scope", choices=["all", "user", "global", "project", "episode"], default="all")
    memory_search.add_argument("--max-results", type=int, default=5)
    memory_search.add_argument("--json", action="store_true")
    memory_add = memory_sub.add_parser("add", help="Add one memory entry.")
    memory_add.add_argument("--scope", choices=["user", "global", "project", "episode"], required=True)
    memory_add.add_argument("--stdin", action="store_true")
    memory_add.add_argument("text", nargs="*")
    memory_add.add_argument("--json", action="store_true")
    memory_update = memory_sub.add_parser("update", help="Replace one memory entry by id.")
    memory_update.add_argument("id")
    memory_update.add_argument("--stdin", action="store_true")
    memory_update.add_argument("text", nargs="*")
    memory_update.add_argument("--json", action="store_true")
    memory_remove = memory_sub.add_parser("remove", help="Remove one memory entry by id.")
    memory_remove.add_argument("id")
    memory_remove.add_argument("--json", action="store_true")
    memory_consolidate = memory_sub.add_parser("consolidate", help="Merge and promote recent episodic notes with one LLM call.")
    memory_consolidate.add_argument("--days", type=int, default=2)
    memory_consolidate.add_argument("--json", action="store_true")
    trace = sub.add_parser("trace", help="Inspect recorded sessions or open the local Trace Workbench.")
    trace_sub = trace.add_subparsers(dest="trace_command", required=True)
    trace_list = trace_sub.add_parser("list", help="List recorded sessions.")
    trace_list.add_argument("--json", action="store_true")
    trace_show = trace_sub.add_parser("show", help="Print one session timeline.")
    trace_show.add_argument("session")
    trace_show.add_argument("--json", action="store_true")
    trace_serve = trace_sub.add_parser("serve", help="Open the local Trace Workbench.")
    trace_serve.add_argument("--port", type=int, default=8765)
    trace_serve.add_argument("--no-open", action="store_true")
    context = sub.add_parser("context", help="Print context usage for a saved session.")
    context.add_argument("--session", help="Inspect a specific session id.")
    progress = sub.add_parser("progress", help="Print progress for a saved Friday session.")
    progress.add_argument("--session", help="Inspect a specific session id.")
    compact = sub.add_parser("compact", help="Compact a saved Friday session.")
    compact.add_argument("--session", help="Compact a specific session id.")
    goal = sub.add_parser("goal", help="Run a verified goal to completion or a clear stop condition.")
    goal.add_argument("--stdin", action="store_true", help="Read the goal from standard input.")
    goal.add_argument("text", nargs="*")
    resume = sub.add_parser("resume", help="Resume saved Friday session context.")
    resume.add_argument("--list", action="store_true", help="List recent resumable sessions.")
    resume.add_argument("--session", help="Resume a specific session id.")
    approve = sub.add_parser("approve", help="Approve one pending dangerous shell command.")
    approve.add_argument("--session", help="Continue a specific session after approval.")
    approve.add_argument("--for-session", action="store_true", help="Do not ask again during the active session.")
    reject = sub.add_parser("reject", help="Reject one pending dangerous shell command.")
    reject.add_argument("--session", help="Mark a specific session blocked after rejection.")
    reject.add_argument("--message", help="Reject and tell Friday how to continue.")
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

    if command == "skill":
        ensure_user_home(Path.home())
        skills = discover_skills(Path.cwd(), Path.home() / ".friday")
        if args.json:
            print(json_dump({"skills": skills}))
        else:
            print("NAME\tSCOPE\tDESCRIPTION\tPATH")
            for item in skills:
                print(f"{item['name']}\t{item['scope']}\t{item['description']}\t{item['path']}")
        return

    if command == "prompt":
        print(build_instructions(Path.cwd().resolve(), Path.cwd().resolve() / ".friday"))
        return

    if command == "memory":
        _memory_cli(args, parser)
        return

    if command == "trace":
        _trace_cli(args)
        return

    if command == "context":
        _agent, context, count = resume_friday(stream=False, resume_id=args.session)
        print(f"Context for {'session ' + str(context.metadata.get('session_id')) if count else 'a new session'} ({count} saved turns)")
        print(_context_report(context))
        return

    if command == "progress":
        _agent, context, _count = resume_friday(stream=False, resume_id=args.session)
        print(progress_line(current_progress(context)))
        return

    if command == "compact":
        agent, context, count = resume_friday(stream=stream, resume_id=args.session)
        if not count:
            print("No saved session to compact.")
            return
        _agent, context, summary = compact_friday(agent, context, stream=stream)
        print(f"Compacted session {context.metadata.get('session_id')} ({count} turns).")
        print(summary)
        return

    if command == "approve":
        result = approve_pending()
        if not result.get("approved"):
            print(result.get("message") or "Approval was not executed.")
            return
        print(_approval_status(result))
        agent, context, count = resume_friday(stream=stream, resume_id=args.session)
        if count:
            if args.for_session:
                allow_permissions_for_session(context)
            progress = current_progress(context)
            if progress.get("mode") == "goal":
                _goal(
                    agent,
                    context,
                    str(progress.get("objective") or "Continue the approved goal."),
                    stream,
                    approval_result=result,
                    user_label="/approve",
                    continuation=True,
                )
            else:
                _ask(
                    agent,
                    context,
                    _approval_followup_prompt(),
                    stream,
                    approval_result=result,
                    user_label="/approve",
                    continuation=True,
                )
        elif args.session:
            print(f"Session not found: {args.session}. The command was executed, but no AI continuation ran.")
        return

    if command == "reject":
        result = approve_pending(reject=True)
        if not result.get("rejected"):
            print(result.get("message") or "No pending approval.")
            return
        print(f"Rejected: {result.get('command') or 'pending command'}")
        _agent, context, count = resume_friday(stream=stream if args.message else False, resume_id=args.session)
        if count:
            if args.message:
                _continue_with_guidance(_agent, context, args.message, result, stream)
            else:
                finish_progress(context, "blocked", [{"verdict": "blocked", "feedback": "User rejected the pending command."}])
        return

    if command == "reset":
        _reset(args.yes)
        return

    if command == "tui":
        run_tui()
        return

    if command == "resume":
        if args.list:
            _print_resume_choices()
            return
        agent, context, count = resume_friday(stream=stream, resume_id=args.session)
        if args.session and not count:
            print(f"Session not found: {args.session}")
            return
        print(f"Resumed {count} turns." if count else "No saved session; starting a new chat.")
        print(f"[progress] {progress_line(current_progress(context))}")
        command = "chat"
    else:
        agent, context = build_friday(stream=stream)

    if command == "ask":
        text = _request_text(args, parser, "ask")
        _ask(agent, context, text, stream)
        return

    if command == "goal":
        _goal(agent, context, _request_text(args, parser, "goal"), stream)
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


def _help_alias(argv: list[str]) -> list[str]:
    if argv == ["help"]:
        return ["--help"]
    if len(argv) == 2 and argv[1] == "help" and argv[0] in {"skill", "memory", "trace"}:
        return [argv[0], "--help"]
    return argv


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
    raw_command = text[1:].strip()
    command = raw_command.lower()
    if command in {"help", "?"}:
        print("/help, /prompt, /memory [help], /context, /progress, /trace, /compact, /goal <text>, /resume, /approve [session], /reject [guidance], /reset, /exit")
    elif command == "prompt":
        print(build_instructions(Path.cwd().resolve(), Path.cwd().resolve() / ".friday"))
    elif command.startswith("memory"):
        result = run_memory_command(raw_command[len("memory") :].strip(), Path.cwd().resolve())
        print(format_memory_result(result))
    elif command == "context":
        print(_context_report(context))
    elif command == "progress":
        print(progress_line(current_progress(context)))
    elif command == "trace":
        _server, url = start_trace_server()
        print(f"Trace Workbench: {url}")
    elif command == "compact":
        agent, context, summary = compact_friday(agent, context, stream=stream)
        print("compacted conversation:")
        print(summary)
    elif command == "resume":
        agent, context, count = resume_friday(stream=stream)
        print(f"resumed {count} turns")
        print(f"[progress] {progress_line(current_progress(context))}")
    elif command.startswith("goal"):
        goal = text.split(" ", 1)[1].strip() if " " in text else ""
        if not goal:
            print("usage: /goal describe the goal")
        else:
            agent, context, _ = _goal(agent, context, goal, stream)
    elif command in {"approve", "approve session"}:
        result = approve_pending()
        print(json_dump(result))
        if result.get("approved"):
            if command == "approve session":
                allow_permissions_for_session(context)
            agent, context, _ = _ask(
                agent,
                context,
                _approval_followup_prompt(),
                stream,
                approval_result=result,
                user_label="/approve",
                continuation=True,
            )
    elif command.startswith("reject"):
        instruction = raw_command[len("reject") :].strip()
        result = approve_pending(reject=True)
        print(json_dump(result))
        if result.get("rejected"):
            if instruction:
                agent, context, _ = _continue_with_guidance(agent, context, instruction, result, stream)
            else:
                progress = finish_progress(context, "blocked", [{"verdict": "blocked", "feedback": "User rejected the pending command."}])
                _print_progress(progress)
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


def _ask(agent, context, text: str, stream: bool, *, approval_result=None, user_label: str | None = None, continuation: bool = False):
    result = run_turn(
        agent,
        context,
        text,
        stream=stream,
        on_delta=_print_delta if stream else None,
        on_progress=_print_progress,
        on_context_notice=lambda notice: print(f"[context] {notice.split(':', 1)[0]}"),
        approval_result=approval_result,
        user_label=user_label,
        continuation=continuation,
    )
    if stream:
        print()
    else:
        print(result.answer)
    for verification in result.verifications:
        status = verification.get("verdict") or ("pass" if verification.get("passed") else "failed")
        stopped = f" ({verification['stop_reason']})" if verification.get("stop_reason") else ""
        print(f"[verify] {status}{stopped}")
    return result.agent, result.context, result.answer


def _goal(agent, context, text: str, stream: bool, *, approval_result=None, user_label: str | None = None, continuation: bool = False):
    result = run_turn(
        agent,
        context,
        text,
        goal=True,
        stream=stream,
        on_delta=_print_delta if stream else None,
        on_progress=_print_progress,
        on_context_notice=lambda notice: print(f"[context] {notice.split(':', 1)[0]}"),
        approval_result=approval_result,
        user_label=user_label,
        continuation=continuation,
    )
    if stream:
        print()
    else:
        print(result.answer)
    for verification in result.verifications:
        status = verification.get("verdict") or ("passed" if verification.get("passed") else "blocked" if verification.get("blocked") else "failed")
        stopped = f" ({verification['stop_reason']})" if verification.get("stop_reason") else ""
        print(f"[goal verify] attempt {verification.get('attempt')}: {status}{stopped}")
    return result.agent, result.context, result.answer


def _print_delta(text: str) -> None:
    sys.stdout.write(text)
    sys.stdout.flush()


def _print_progress(progress: dict) -> None:
    print(f"\n[progress] {progress_line(progress)}")


def json_dump(value) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2)


def _memory_cli(args, parser: argparse.ArgumentParser) -> None:
    root = Path.cwd().resolve()
    action = args.memory_command or "status"
    if action == "status":
        result = memory_status(root)
    elif action == "list":
        result = {"memories": list_memories(root, scope=args.scope)}
    elif action == "search":
        result = {"memories": search_memories(root, " ".join(args.query), scope=args.scope, max_results=args.max_results)}
    elif action == "add":
        result = add_memory(root, args.scope, _memory_text(args, parser))
    elif action == "update":
        result = update_memory(root, args.id, _memory_text(args, parser))
    elif action == "remove":
        result = remove_memory(root, args.id)
    elif action == "consolidate":
        result = consolidate_memory(root, days=args.days)
    else:
        parser.error(f"unknown memory command: {action}")
        return
    print(json_dump(result) if getattr(args, "json", False) else format_memory_result(result))


def _trace_cli(args) -> None:
    if args.trace_command == "serve":
        serve_trace_ui(port=args.port, open_browser=not args.no_open)
        return
    if args.trace_command == "list":
        traces = list_traces()
        if args.json:
            print(json_dump({"sessions": traces}))
            return
        print("SESSION\tUPDATED\tSTATUS\tTURNS\tWORKSPACE")
        for item in traces:
            print(f"{item['session_id']}\t{item.get('updated_at', '')}\t{item.get('status', '')}\t{item.get('turns', 0)}\t{item.get('workspace', '')}")
        return
    manifest, events = load_trace(args.session)
    behaviors = behavior_events(events)
    if args.json:
        print(json_dump({"manifest": manifest, "stats": trace_stats(events), "events": behaviors}))
        return
    print(json_dump({"manifest": manifest, "stats": trace_stats(events)}))
    for behavior in behaviors:
        event_ids = ",".join(str(seq) for seq in behavior["seqs"])
        if behavior["kind"] == "tool":
            detail = json_dump(behavior.get("arguments", {}))
            result = str(behavior.get("result") or "")
            print(f"[event:{event_ids}] TOOL {behavior['name']} {detail}" + (f" -> {result}" if result else ""))
        else:
            print(f"[event:{event_ids}] {behavior['label']} {behavior['text']}")


def _memory_text(args, parser: argparse.ArgumentParser) -> str:
    text = sys.stdin.read() if args.stdin else " ".join(args.text)
    if not text.strip():
        parser.error("memory content is required as text or --stdin")
    return text


def _context_report(context) -> str:
    root = Path(context.metadata["workspace"])
    return context_report(context, build_tools(root, root / ".friday"))


def _approval_followup_prompt() -> str:
    return "The approved command has executed. Report the result to the user and continue only if another action is needed."


def _approval_status(result: dict) -> str:
    approval = result.get("approval") if isinstance(result.get("approval"), dict) else {}
    execution = result.get("result") if isinstance(result.get("result"), dict) else {}
    command = approval.get("command") or "pending command"
    status = "timed out" if execution.get("timed_out") else f"exit {execution.get('exit_code', 'unknown')}"
    output = str(execution.get("output") or "").strip()
    return f"Approved and executed ({status}): {command}" + (f"\n{output}" if output else "")


def _continue_with_guidance(agent, context, instruction: str, result: dict, stream: bool):
    progress = current_progress(context)
    approval_result = {**result, "instruction": instruction}
    if progress.get("mode") == "goal":
        objective = str(progress.get("objective") or "Continue the goal.")
        prompt = f"{objective}\n\nHuman guidance after declining the pending command: {instruction}"
        return _goal(
            agent,
            context,
            prompt,
            stream,
            approval_result=approval_result,
            user_label=instruction,
            continuation=True,
        )
    return _ask(
        agent,
        context,
        instruction,
        stream,
        approval_result=approval_result,
        user_label=instruction,
        continuation=True,
    )


def _request_text(args, parser: argparse.ArgumentParser, command: str) -> str:
    text = sys.stdin.read() if args.stdin else " ".join(args.text)
    if not text.strip():
        parser.error(f"{command} requires text or --stdin")
    return text


def _print_resume_choices() -> None:
    choices = resume_choices()
    if not choices:
        print("No recent sessions.")
        return
    print("SESSION\tUPDATED\tSTATUS\tTURNS\tOBJECTIVE")
    for item in choices:
        objective = item.get("objective") or item.get("user") or item.get("assistant") or "-"
        print(f"{item['id']}\t{item['time']}\t{item['status'] or '-'}\t{item['turns']}\t{objective}")


if __name__ == "__main__":
    main()
