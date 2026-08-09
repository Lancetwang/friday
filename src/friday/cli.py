from __future__ import annotations

import argparse
import getpass
import json
import os
import sys
from pathlib import Path

from friday.app import ensure_user_home, init_project, reset_friday, resume_choices
from friday.checkpoint import checkpoint_choices
from friday.context import context_report
from friday.doctor import doctor_report, format_doctor_report
from friday.config import (
    PROVIDERS,
    delete_model_profile,
    load_model_catalog,
    save_model_profile,
    select_model_profile,
)
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
from friday.progress import progress_line
from friday.session import FridaySession
from friday.skills import discover_skills
from friday.state import delete_session, rename_session
from friday.storage import friday_home, project_state_dir
from friday.tools import build_tools, set_permission_mode
from friday.trace import behavior_events, list_traces, load_trace, trace_stats
from friday.trace_web import serve_trace_ui, start_trace_server
from friday.tui_node import run_tui
from friday.turn import TurnResult


def main(argv: list[str] | None = None) -> None:
    _configure_stdio()
    argv = _help_alias(list(sys.argv[1:] if argv is None else argv))

    parser = argparse.ArgumentParser(prog="friday", description="Friday general-purpose local CLI agent.")
    parser.add_argument("--no-stream", action="store_true", help="Disable streaming output.")
    parser.add_argument("--permission-mode", choices=["manual", "auto", "bypass"], default=None)
    parser.add_argument("--cwd", type=Path, help="Use this directory as the Friday workspace.")
    parser.add_argument("--dangerously-skip-permissions", action="store_true", help="Bypass command approvals for sandboxed runs.")
    parser.add_argument("--permission-allow", "--permission_allow", action="store_true", help="Alias for --dangerously-skip-permissions.")
    parser.add_argument("--allowed-tools", "--allowedTools", action="append", default=[])
    parser.add_argument("--disallowed-tools", "--disallowedTools", action="append", default=[])
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("init", help="Create the project's AGENTS.md.")
    doctor = sub.add_parser("doctor", help="Check the local Friday installation and configuration.")
    doctor.add_argument("--json", action="store_true", help="Print machine-readable JSON.")

    skill = sub.add_parser("skill", help="Inspect reusable Friday skills.", description="Inspect reusable Friday skills.")
    skill.add_argument("--json", action="store_true", help="Print machine-readable JSON.")

    model = sub.add_parser("model", help="Configure and select model providers.")
    model_sub = model.add_subparsers(dest="model_command", required=True)
    model_list = model_sub.add_parser("list", help="List configured models.")
    model_list.add_argument("--json", action="store_true")
    model_add = model_sub.add_parser("add", help="Add or update a model configuration.")
    model_add.add_argument("name")
    model_add.add_argument("--id")
    model_add.add_argument("--provider", choices=[item["id"] for item in PROVIDERS], required=True)
    model_add.add_argument(
        "--model",
        help="Model id. Omit it for a built-in provider to discover its models through /models.",
    )
    model_add.add_argument("--base-url")
    model_add.add_argument("--no-key", action="store_true", help="Keep the existing key or configure it through an environment variable.")
    model_use = model_sub.add_parser("use", help="Select a configured model.")
    model_use.add_argument("id")
    model_remove = model_sub.add_parser("remove", help="Remove a configured model.")
    model_remove.add_argument("id")

    ask = sub.add_parser("ask", help="Ask once.")
    ask.add_argument("--stdin", action="store_true", help="Read the request from standard input.")
    ask.add_argument("text", nargs="*")

    sub.add_parser("chat", help="Start an interactive chat.")
    sub.add_parser("tui", help="Start a simple terminal UI.")
    sub.add_parser("app-server", help="Run the JSONL app server for rich clients.")
    feishu = sub.add_parser("feishu", help="Drive this workspace from Feishu over a long connection.")
    feishu.add_argument("--console", action="store_true", help="Exercise the bridge from this terminal without Feishu.")
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
    checkpoint = sub.add_parser("checkpoint", help="List or restore turn checkpoints.")
    checkpoint_sub = checkpoint.add_subparsers(dest="checkpoint_command", required=True)
    checkpoint_list = checkpoint_sub.add_parser("list", help="List restorable checkpoints.")
    checkpoint_list.add_argument("--json", action="store_true")
    checkpoint_restore = checkpoint_sub.add_parser("restore", help="Restore one checkpoint.")
    checkpoint_restore.add_argument("id")
    checkpoint_restore.add_argument("--force", action="store_true", help="Overwrite workspace changes made after Friday's last turn.")
    undo = sub.add_parser("undo", help="Undo the latest Friday turn.")
    undo.add_argument("--checkpoint", help="Restore a specific checkpoint id.")
    undo.add_argument("--force", action="store_true", help="Overwrite workspace changes made after Friday's last turn.")
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
    sessions_cli = sub.add_parser("session", help="List, rename, or delete saved conversations.")
    sessions_sub = sessions_cli.add_subparsers(dest="session_command", required=True)
    sessions_sub.add_parser("list", help="List saved conversations.")
    session_rename = sessions_sub.add_parser("rename", help="Rename a saved conversation.")
    session_rename.add_argument("id")
    session_rename.add_argument("title", nargs="+")
    session_delete = sessions_sub.add_parser("delete", help="Delete a saved conversation.")
    session_delete.add_argument("id")
    approve = sub.add_parser("approve", help="Approve one pending dangerous shell command.")
    approve.add_argument("--session", help="Continue a specific session after approval.")
    approve.add_argument("--for-session", action="store_true", help="Do not ask again during the active session.")
    reject = sub.add_parser("reject", help="Reject one pending dangerous shell command.")
    reject.add_argument("--session", help="Mark a specific session blocked after rejection.")
    reject.add_argument("--message", help="Reject and tell Friday how to continue.")
    reset = sub.add_parser("reset", help="Clear Friday memory and session state.")
    reset.add_argument("-y", "--yes", action="store_true", help="Skip reset confirmation.")

    args = parser.parse_args(argv)
    if args.cwd:
        workspace = args.cwd.expanduser().resolve()
        if not workspace.is_dir():
            parser.error(f"workspace is not a directory: {workspace}")
        os.chdir(workspace)
    _configure_permissions(args)
    command = args.command or "tui"
    stream = not args.no_stream

    if command == "init":
        created = init_project()
        print("created:" if created else "nothing to create")
        for path in created:
            print(path)
        return

    if command == "doctor":
        report = doctor_report(Path.cwd())
        print(json_dump(report) if args.json else format_doctor_report(report))
        if not report["ok"]:
            raise SystemExit(1)
        return

    if command == "skill":
        ensure_user_home()
        skills = discover_skills(Path.cwd(), friday_home())
        if args.json:
            print(json_dump({"skills": skills}))
        else:
            print("NAME\tSCOPE\tDESCRIPTION\tPATH")
            for item in skills:
                print(f"{item['name']}\t{item['scope']}\t{item['description']}\t{item['path']}")
        return

    if command == "model":
        _model_cli(args)
        return

    if command == "memory":
        _memory_cli(args, parser)
        return

    if command == "trace":
        _trace_cli(args)
        return

    if command == "checkpoint":
        if args.checkpoint_command == "list":
            choices = checkpoint_choices()
            if args.json:
                print(json_dump({"checkpoints": choices}))
            else:
                _print_checkpoint_choices(choices)
        else:
            _undo_cli(args.id, stream, args.force)
        return

    if command == "undo":
        _undo_cli(args.checkpoint, stream, args.force)
        return

    if command == "context":
        session = _session(False)
        count = session.resume(args.session)
        print(f"Context for {'session ' + str(session.context.metadata.get('session_id')) if count else 'a new session'} ({count} saved turns)")
        print(_context_report(session.context))
        return

    if command == "progress":
        session = _session(False)
        session.resume(args.session)
        print(progress_line(session.progress()))
        return

    if command == "compact":
        session = _session(stream)
        count = session.resume(args.session)
        if not count:
            print("No saved session to compact.")
            return
        summary = session.compact()
        print(f"Compacted session {session.context.metadata.get('session_id')} ({count} turns).")
        print(summary)
        return

    if command == "approve":
        session = _session(stream)
        count = session.resume(args.session)
        if args.session and not count:
            print(f"Session not found: {args.session}. Approving executes the command without an AI continuation.")
        outcome = session.approve(for_session=args.for_session)
        if not outcome["approval"].get("approved"):
            print(outcome["approval"].get("message") or "Approval was not executed.")
        return

    if command == "reject":
        session = _session(stream if args.message else False)
        session.resume(args.session)
        outcome = session.reject(args.message or "")
        if not outcome["approval"].get("rejected"):
            print(outcome["approval"].get("message") or "No pending approval.")
        return

    if command == "reset":
        if _confirm_reset(args.yes, include_user=True):
            _print_reset(reset_friday(include_user=True))
        return

    if command == "session":
        if args.session_command == "list":
            _print_resume_choices()
        elif args.session_command == "rename":
            data = rename_session(Path.cwd().resolve(), args.id, " ".join(args.title))
            print(f"Renamed {args.id}: {data['title']}")
        else:
            delete_session(Path.cwd().resolve(), args.id)
            print(f"Deleted session {args.id}.")
        return

    if command == "tui":
        run_tui()
        return

    if command == "app-server":
        from friday.app_server import main as run_app_server

        run_app_server()
        return

    if command == "feishu":
        if args.console:
            from friday.im.console import run_console_bridge

            run_console_bridge(Path.cwd().resolve())
        else:
            from friday.im.feishu import run_feishu_bridge

            run_feishu_bridge(Path.cwd().resolve())
        return

    session = _session(stream)
    if command == "resume":
        if args.list:
            _print_resume_choices()
            return
        count = session.resume(args.session)
        if args.session and not count:
            print(f"Session not found: {args.session}")
            return
        print(f"Resumed {count} turns." if count else "No saved session; starting a new chat.")
        print(f"[progress] {progress_line(session.progress())}")
        command = "chat"

    if command == "ask":
        session.chat(_request_text(args, parser, "ask"))
        return

    if command == "goal":
        session.chat(_request_text(args, parser, "goal"), goal=True)
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
                _slash(text, session)
                continue
            session.chat(text)
        return

    parser.error(f"unknown command: {command}")


def _configure_stdio() -> None:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")


def _help_alias(argv: list[str]) -> list[str]:
    if argv[:2] == ["skill", "list"]:
        argv = ["skill", *argv[2:]]
    if argv == ["help"]:
        return ["--help"]
    if len(argv) == 2 and argv[1] == "help" and argv[0] in {"skill", "memory", "model", "session", "trace"}:
        return [argv[0], "--help"]
    return argv


def _configure_permissions(args) -> None:
    mode = args.permission_mode or "manual"
    if args.dangerously_skip_permissions or args.permission_allow:
        mode = "bypass"
    set_permission_mode(mode)
    if args.allowed_tools:
        os.environ["FRIDAY_ALLOWED_TOOLS"] = json.dumps(args.allowed_tools, ensure_ascii=False)
    if args.disallowed_tools:
        os.environ["FRIDAY_DISALLOWED_TOOLS"] = json.dumps(args.disallowed_tools, ensure_ascii=False)


def _session(stream: bool) -> FridaySession:
    return FridaySession(
        stream=stream,
        on_delta=_print_delta if stream else None,
        on_progress=_print_progress,
        on_context_notice=lambda record: print(f"[context] {record.get('notice') or 'compacted'}"),
        on_turn_complete=lambda result: _print_turn(result, stream),
        on_approval=lambda result: print(_approval_status(result)),
        on_rejection=lambda result: print(f"Rejected: {result.get('command') or 'pending command'}"),
    )


def _slash(text: str, session: FridaySession) -> None:
    raw_command = text[1:].strip()
    command = raw_command.lower()
    if command in {"help", "?"}:
        print("/help, /new, /model [id], /thinking [level], /memory [help], /context, /progress, /trace, /compact, /goal <text>, /resume, /session list|rename|delete, /undo [checkpoint], /permission [manual|auto|bypass], /approve [session], /reject [guidance], /reset, /exit")
    elif command == "new":
        session.new()
        print("started a new conversation")
    elif command.startswith("memory"):
        result = run_memory_command(raw_command[len("memory") :].strip(), Path.cwd().resolve())
        print(format_memory_result(result))
    elif command == "model":
        _print_models(load_model_catalog(Path.cwd().resolve()))
    elif command.startswith("model "):
        profile_id = raw_command[len("model") :].strip()
        select_model_profile(Path.cwd().resolve(), profile_id)
        session.select_model(profile_id)
        print(f"model: {profile_id}")
    elif command.startswith("thinking"):
        requested = raw_command[len("thinking") :].strip()
        if requested:
            try:
                session.select_thinking(requested)
            except ValueError as exc:
                print(exc)
                return
        session.ensure()
        print(f"thinking effort: {session.thinking_effort}")
    elif command == "context":
        _agent, context = session.ensure()
        print(_context_report(context))
    elif command == "progress":
        print(progress_line(session.progress()))
    elif command == "trace":
        _server, url = start_trace_server()
        print(f"Trace Workbench: {url}")
    elif command == "compact":
        print(session.compact())
    elif command == "resume":
        count = session.resume()
        print(f"resumed {count} turns")
        print(f"[progress] {progress_line(session.progress())}")
    elif command == "session list":
        _print_resume_choices()
    elif command.startswith("session rename "):
        parts = raw_command.split(maxsplit=3)
        if len(parts) < 4:
            print("usage: /session rename <id> <title>")
        else:
            data = rename_session(Path.cwd().resolve(), parts[2], parts[3])
            print(f"renamed {parts[2]}: {data['title']}")
    elif command.startswith("session delete "):
        parts = raw_command.split(maxsplit=2)
        delete_session(Path.cwd().resolve(), parts[2])
        if session.context is not None and session.context.metadata.get("session_id") == parts[2]:
            session.new()
        print(f"deleted session {parts[2]}")
    elif command.startswith("undo"):
        checkpoint_id = raw_command[len("undo") :].strip() or None
        _print_undo(session.undo(checkpoint_id))
    elif command.startswith("permission"):
        requested = raw_command[len("permission") :].strip()
        aliases = {"ask": "manual", "full": "bypass"}
        if requested:
            try:
                session.select_permission_mode(aliases.get(requested, requested))
            except ValueError:
                print("usage: /permission manual|auto|bypass")
                return
        print(f"permission mode: {session.effective_permission_mode()}")
    elif command.startswith("goal"):
        goal = text.split(" ", 1)[1].strip() if " " in text else ""
        if not goal:
            print("usage: /goal describe the goal")
        else:
            session.chat(goal, goal=True)
    elif command in {"approve", "approve session"}:
        outcome = session.approve(for_session=command == "approve session")
        if not outcome["approval"].get("approved"):
            print(outcome["approval"].get("message") or "No pending approval.")
    elif command.startswith("reject"):
        outcome = session.reject(raw_command[len("reject") :].strip())
        if not outcome["approval"].get("rejected"):
            print(outcome["approval"].get("message") or "No pending approval.")
        elif not outcome["continued"]:
            _print_progress(session.progress())
    elif command == "reset":
        if _confirm_reset(False, include_user=False):
            _print_reset(session.reset())
    elif command in {"exit", "quit", "q"}:
        raise SystemExit
    else:
        print(f"unknown slash command: /{command}")


def _confirm_reset(yes: bool, *, include_user: bool) -> bool:
    targets = [project_state_dir(Path.cwd().resolve())]
    if include_user:
        targets.append(friday_home())
    scope = "project state and global Friday user state" if include_user else "the current project's Friday state"
    print(f"This will delete {scope}:")
    for path in targets:
        print(f"- {path}")
    if not yes:
        confirm = input("Type RESET to continue: ").strip()
        if confirm != "RESET":
            print("cancelled")
            return False
    return True


def _print_reset(removed: list[Path]) -> None:
    print("reset Friday")
    for path in removed:
        print(f"removed {path}")


def _print_turn(result: TurnResult, stream: bool) -> None:
    if stream:
        print()
    else:
        print(result.answer)
    goal = result.progress.get("mode") == "goal"
    for verification in result.verifications:
        status = verification.get("verdict") or ("pass" if verification.get("passed") else "failed")
        stopped = f" ({verification['stop_reason']})" if verification.get("stop_reason") else ""
        if goal:
            print(f"[goal verify] attempt {verification.get('attempt')}: {status}{stopped}")
        else:
            print(f"[verify] {status}{stopped}")


def _print_delta(text: str) -> None:
    sys.stdout.write(text)
    sys.stdout.flush()


def _print_progress(progress: dict) -> None:
    print(f"\n[progress] {progress_line(progress)}")


def json_dump(value) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2)


def _model_cli(args) -> None:
    root = Path.cwd().resolve()
    if args.model_command == "list":
        catalog = load_model_catalog(root)
        print(json_dump(catalog) if args.json else _format_models(catalog))
        return
    if args.model_command == "use":
        select_model_profile(root, args.id)
        print(f"Selected model configuration: {args.id}")
        return
    if args.model_command == "remove":
        delete_model_profile(root, args.id)
        print(f"Removed model configuration: {args.id}")
        return
    provider = next(item for item in PROVIDERS if item["id"] == args.provider)
    if not provider["builtin"] and not args.model:
        raise ValueError("--model is required for OpenAI-compatible providers.")
    if provider["builtin"] and not args.model:
        api_key = getpass.getpass(f"{provider['label']} API key (hidden): ")
        catalog = save_model_profile(
            root,
            {"id": args.id or provider["id"], "name": args.name, "provider": args.provider, "model": ""},
            api_key=api_key,
        )
        print(f"Discovered models from {provider['label']}; active: {catalog['active']}")
        return
    api_key = None if args.no_key else getpass.getpass(f"{provider['label']} API key (hidden): ")
    catalog = save_model_profile(
        root,
        {
            "id": args.id,
            "name": args.name,
            "provider": args.provider,
            "model": args.model,
            "base_url": args.base_url or provider["base_url"],
        },
        api_key=api_key,
    )
    print(f"Saved and selected: {catalog['active']}")


def _format_models(catalog: dict) -> str:
    lines = []
    for profile in catalog["profiles"]:
        active = "*" if profile["id"] == catalog["active"] else " "
        vision = " [vision]" if profile["vision"] else ""
        state = "disabled" if not profile.get("enabled") and profile["api_key_configured"] else (
            "key configured" if profile["api_key_configured"] else "key missing"
        )
        lines.append(f"{active} {profile['id']}: {profile['name']} ({profile['provider']}/{profile['model']}){vision} - {state}")
    return "\n".join(lines)


def _print_models(catalog: dict) -> None:
    print(_format_models(catalog))


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


def _undo_cli(checkpoint_id: str | None, stream: bool, force: bool) -> None:
    session = _session(stream)
    _print_undo(session.undo(checkpoint_id, force=force))


def _print_undo(restored: dict) -> None:
    changed = list(restored.get("changed_paths") or [])
    print(f"Undid: {restored.get('user') or restored.get('id')}")
    print(f"Restored {len(changed)} workspace path{'s' if len(changed) != 1 else ''}.")


def _print_checkpoint_choices(choices: list[dict]) -> None:
    if not choices:
        print("No restorable checkpoints.")
        return
    print("ID\tSTATE\tTIME\tREQUEST")
    for item in choices:
        print(f"{item['id']}\t{item['state']}\t{item['created']}\t{item['user']}")


def _memory_text(args, parser: argparse.ArgumentParser) -> str:
    text = sys.stdin.read() if args.stdin else " ".join(args.text)
    if not text.strip():
        parser.error("memory content is required as text or --stdin")
    return text


def _context_report(context) -> str:
    root = Path(context.metadata["workspace"])
    return context_report(context, build_tools(root))


def _approval_status(result: dict) -> str:
    approval = result.get("approval") if isinstance(result.get("approval"), dict) else {}
    execution = result.get("result") if isinstance(result.get("result"), dict) else {}
    command = approval.get("command") or "pending command"
    status = "timed out" if execution.get("timed_out") else f"exit {execution.get('exit_code', 'unknown')}"
    output = str(execution.get("output") or "").strip()
    return f"Approved and executed ({status}): {command}" + (f"\n{output}" if output else "")


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
    print("SESSION\tUPDATED\tSTATUS\tTURNS\tTITLE")
    for item in choices:
        title = item.get("title") or item.get("objective") or item.get("user") or item.get("assistant") or "-"
        print(f"{item['id']}\t{item['time']}\t{item['status'] or '-'}\t{item['turns']}\t{title}")


def entrypoint() -> None:
    try:
        main()
    except Exception as exc:
        if os.getenv("FRIDAY_DEBUG"):
            raise
        print(f"Friday error: {exc}", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    entrypoint()
