from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import signal
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Annotated, Literal

from agent_core import RunContext, get_current_context, tool

from friday.progress import update_plan
from friday.storage import friday_home, migrate_legacy_runtime, project_state_dir

CONTEXT_FILE_LIMIT = 8000
APPROVAL_FILE = "pending_approval.json"
PERMISSIONS_FILE = "permissions.json"
SESSION_PERMISSIONS_ALLOWED = "friday.permissions_allowed"
PERMISSION_MODES = {"manual", "accept-edits", "dont-ask", "bypass"}
INSTRUCTION_FILE_NAMES = (
    "AGENTS.md",
    ".friday/AGENTS.md",
)


def build_tools(workspace: Path, friday_dir: Path | None = None):
    workspace = workspace.resolve()
    friday_dir = (friday_dir or migrate_legacy_runtime(workspace)).resolve()
    user_dir = friday_home()
    user_dir.mkdir(parents=True, exist_ok=True)
    loaded_context_files: set[Path] = set()

    def in_workspace(path: str) -> Path:
        raw = Path(path)
        if not raw.is_absolute() and raw.parts[:2] == (".friday", "tool-results"):
            raw = friday_dir.joinpath(*raw.parts[1:])
        resolved = (workspace / raw).resolve()
        if (
            resolved != workspace
            and workspace not in resolved.parents
            and resolved != friday_dir
            and friday_dir not in resolved.parents
        ):
            raise ValueError(f"Path escapes workspace: {path}")
        return resolved

    def with_context(result: dict, paths: list[Path]) -> dict:
        context = _context_for_paths(workspace, paths, loaded_context_files)
        if context:
            result["context"] = context
        return result

    @tool(description="Read a UTF-8 text file inside the current workspace.", name="Read")
    def read_file(
        path: Annotated[str, "Path inside the workspace."],
        start_line: Annotated[int, "1-based line number to start reading from."] = 1,
        line_count: Annotated[int, "Maximum number of lines to read."] = 120,
        max_chars: Annotated[int, "Maximum characters to return."] = 6000,
    ) -> dict:
        file_path = in_workspace(path)
        text = file_path.read_text(encoding="utf-8")
        lines = text.splitlines()
        start = max(1, start_line)
        selected = lines[start - 1 : start - 1 + max(1, line_count)]
        content = "\n".join(f"{number}: {line}" for number, line in enumerate(selected, start=start))
        preview, artifact = _bounded_tool_output(friday_dir, "read", content, max_chars, ".txt")
        end = start + len(selected) - 1 if selected else start - 1
        result = {
            "path": str(file_path),
            "total_lines": len(lines),
            "start_line": start,
            "end_line": end,
            "truncated": end < len(lines),
            "content": preview,
        }
        if artifact:
            result.update({"output_truncated": True, **artifact})
        return with_context(result, [file_path])

    @tool(description="Create or overwrite a UTF-8 text file inside the current workspace.", name="Write")
    def write_file(
        path: Annotated[str, "Path inside the workspace."],
        content: Annotated[str, "Full file content."],
    ) -> dict:
        file_path = in_workspace(path)
        _write_text(file_path, content)
        return with_context({"path": str(file_path), "chars": len(content), "lines": len(content.splitlines())}, [file_path])

    @tool(description="Edit a UTF-8 text file by line range or exact text inside the current workspace.", name="Edit")
    def edit_file(
        path: Annotated[str, "Path inside the workspace."],
        replacement: Annotated[str, "Replacement text."],
        start_line: Annotated[int, "1-based first line to replace. Use with end_line."] = 0,
        end_line: Annotated[int, "1-based last line to replace, inclusive. Use 0 to insert before start_line."] = 0,
        old_text: Annotated[str, "Exact text to replace when not using line range."] = "",
    ) -> dict:
        file_path = in_workspace(path)
        text = file_path.read_text(encoding="utf-8")
        if start_line > 0:
            newline = "\n" if text.endswith("\n") else ""
            lines = text.splitlines()
            start = min(start_line, len(lines) + 1)
            end = min(max(end_line, start - 1), len(lines))
            replacement_lines = replacement.splitlines()
            new_lines = [*lines[: start - 1], *replacement_lines, *lines[end:]]
            _write_text(file_path, _join_lines(new_lines, bool(new_lines) and bool(newline)))
            return with_context({
                "path": str(file_path),
                "mode": "line_range",
                "start_line": start,
                "end_line": end,
                "replacement_lines": len(replacement_lines),
                "total_lines": len(new_lines),
            }, [file_path])
        if not old_text:
            raise ValueError("Provide start_line/end_line or old_text.")
        count = text.count(old_text)
        if count != 1:
            raise ValueError(f"Expected exactly one match, found {count}.")
        _write_text(file_path, text.replace(old_text, replacement, 1))
        return with_context({"path": str(file_path), "mode": "exact_text", "replacements": 1}, [file_path])

    @tool(description="Run a shell command in the current workspace. Uses PowerShell on Windows.", name="Bash")
    def run_shell(
        command: Annotated[str, "Shell command to run."],
        timeout_seconds: Annotated[int, "Timeout in seconds."] = 60,
        max_chars: Annotated[int, "Maximum output characters to return."] = 8000,
    ) -> dict:
        decision, reason = _permission_decision(friday_dir, command)
        if decision == "deny":
            return {"blocked": True, "message": f"Command denied by {PERMISSIONS_FILE}: {reason}"}
        if decision == "approval":
            approval = _write_approval(friday_dir, command, timeout_seconds, max_chars, reason)
            return {**approval, "approval_required": True, "message": "Execution paused for human approval."}
        return _run_shell(workspace, command, timeout_seconds, max_chars, friday_dir)

    @tool(description="Find files and directories by glob pattern inside the current workspace.", name="Glob")
    def glob_files(
        pattern: Annotated[str, "Glob pattern such as '**/*.py'."],
        max_results: Annotated[int, "Maximum paths to return."] = 200,
    ) -> dict:
        matches = []
        for path in sorted(workspace.glob(pattern)):
            resolved = path.resolve()
            if resolved != workspace and workspace not in resolved.parents:
                continue
            matches.append(str(resolved.relative_to(workspace)))
            if len(matches) >= max(1, max_results):
                break
        return with_context({"pattern": pattern, "count": len(matches), "paths": matches}, [workspace / path for path in matches])

    @tool(description="Search UTF-8 text files by regular expression inside the current workspace.", name="Grep")
    def grep_files(
        pattern: Annotated[str, "Python regular expression to search for."],
        path_glob: Annotated[str, "Files to search, for example '**/*.py'."] = "**/*",
        max_results: Annotated[int, "Maximum matches to return."] = 100,
        max_chars: Annotated[int, "Maximum characters per matched line."] = 240,
    ) -> dict:
        regex = re.compile(pattern)
        matches = []
        for path in sorted(workspace.glob(path_glob)):
            if not path.is_file():
                continue
            resolved = path.resolve()
            if resolved != workspace and workspace not in resolved.parents:
                continue
            try:
                lines = path.read_text(encoding="utf-8").splitlines()
            except UnicodeDecodeError:
                continue
            for number, line in enumerate(lines, start=1):
                if regex.search(line):
                    matches.append(
                        {
                            "path": str(resolved.relative_to(workspace)),
                            "line": number,
                            "text": line[:max_chars],
                        }
                    )
                    if len(matches) >= max(1, max_results):
                        return with_context(
                            {"pattern": pattern, "count": len(matches), "matches": matches},
                            [workspace / match["path"] for match in matches],
                        )
        return with_context(
            {"pattern": pattern, "count": len(matches), "matches": matches},
            [workspace / match["path"] for match in matches],
        )

    @tool(description="Search the live web when current external information is needed.", name="WebSearch")
    def web_search(
        query: Annotated[str, "Search query."],
        max_results: Annotated[int, "Maximum results to return, 1-10."] = 5,
        search_depth: Annotated[Literal["basic", "advanced"], "Search depth."] = "basic",
        topic: Annotated[Literal["general", "news", "finance"], "Search topic."] = "general",
        include_answer: Annotated[bool, "Include a provider answer summary when available."] = True,
        time_range: Annotated[str, "Optional time range: day, week, month, or year."] = "",
    ) -> dict:
        return _web_search(query, max_results, search_depth, topic, include_answer, time_range)

    @tool(description="Fetch a specific URL as clean Markdown with Jina Reader.", name="WebFetch")
    def web_fetch(
        url: Annotated[str, "HTTP or HTTPS URL to fetch."],
        max_chars: Annotated[int, "Maximum characters to return."] = 8000,
    ) -> dict:
        return _jina_fetch(workspace, url, max_chars, friday_dir)

    @tool(description="Create or update the visible plan for the current non-trivial session goal.", name="UpdatePlan")
    def update_session_plan(
        plan: Annotated[list[dict], "Full plan. Each item has step and status=pending|in_progress|completed|blocked."],
        objective: Annotated[str, "Updated effective objective when the user's request changed."] = "",
        explanation: Annotated[str, "Short reason for a plan or scope change."] = "",
        next_action: Annotated[str, "Immediate next action or blocker."] = "",
    ) -> dict:
        context = get_current_context()
        if context is None:
            raise RuntimeError("UpdatePlan requires an active agent run.")
        return update_plan(
            context,
            plan,
            objective=objective,
            explanation=explanation,
            next_action=next_action,
        )

    return [read_file, write_file, edit_file, run_shell, glob_files, grep_files, web_search, web_fetch, update_session_plan]


def approve_pending(workspace: Path | None = None, *, reject: bool = False) -> dict:
    root = (workspace or Path.cwd()).resolve()
    friday_dir = migrate_legacy_runtime(root)
    path = friday_dir / APPROVAL_FILE
    if not path.exists():
        return {"approved": False, "message": "No pending approval."}
    approval = json.loads(path.read_text(encoding="utf-8"))
    path.unlink()
    if reject:
        return {"approved": False, "rejected": True, "command": approval.get("command", "")}
    result = _run_shell(
        root,
        str(approval.get("command", "")),
        int(approval.get("timeout_seconds", 60)),
        int(approval.get("max_chars", 8000)),
        friday_dir,
    )
    return {"approved": True, "approval": approval, "result": result}


def pending_approval(workspace: Path | None = None) -> dict:
    root = (workspace or Path.cwd()).resolve()
    path = migrate_legacy_runtime(root) / APPROVAL_FILE
    if not path.exists():
        return {"pending": False, "message": "No pending approval."}
    try:
        approval = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"pending": False, "message": "Invalid pending approval."}
    return {"pending": True, **approval}


def allow_permissions_for_session(context: RunContext) -> None:
    context.metadata[SESSION_PERMISSIONS_ALLOWED] = True


def default_permissions() -> dict:
    return {"version": 1, "bash": {"allow": [], "deny": [], "require_approval": []}}


def _web_search(query: str, max_results: int, search_depth: str, topic: str, include_answer: bool, time_range: str) -> dict:
    tavily = _tavily_search(query, max_results, search_depth, topic, include_answer, time_range)
    if "error" not in tavily:
        return {"provider": "tavily", **tavily}

    anysearch = _anysearch_search(query, max_results)
    if "error" not in anysearch:
        return {"provider": "anysearch", **anysearch}

    return {
        "error": "All WebSearch providers failed.",
        "providers": {
            "tavily": tavily["error"],
            "anysearch": anysearch["error"],
        },
    }


def _tavily_search(query: str, max_results: int, search_depth: str, topic: str, include_answer: bool, time_range: str) -> dict:
    api_key = os.getenv("TAVILY_API_KEY", "").strip()
    if not api_key:
        return {"error": "TAVILY_API_KEY is not configured."}
    payload = {
        "query": query,
        "search_depth": search_depth,
        "topic": topic,
        "max_results": min(10, max(1, int(max_results))),
        "include_answer": bool(include_answer),
        "include_raw_content": False,
        "include_images": False,
    }
    if time_range.strip():
        payload["time_range"] = time_range.strip()
    request = urllib.request.Request(
        "https://api.tavily.com/search",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        return {"error": f"Tavily HTTP {error.code}", "detail": error.read().decode("utf-8", errors="replace")[:1000]}
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        return {"error": f"Tavily search failed: {error}"}
    return {
        "query": data.get("query", query),
        "answer": data.get("answer", ""),
        "results": [_tavily_result(item) for item in data.get("results", []) if isinstance(item, dict)],
    }


def _tavily_result(item: dict) -> dict:
    return {
        "title": item.get("title", ""),
        "url": item.get("url", ""),
        "content": _clip(" ".join(str(item.get("content", "")).split()), 800),
        "score": item.get("score"),
        "published_date": item.get("published_date", ""),
    }


def _anysearch_search(query: str, max_results: int) -> dict:
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "search",
            "arguments": {"query": query, "max_results": min(10, max(1, int(max_results)))},
        },
    }
    headers = {"Content-Type": "application/json", "X-Anysearch-Client": "friday/0.1"}
    api_key = os.getenv("ANYSEARCH_API_KEY", "").strip()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    request = urllib.request.Request(
        "https://api.anysearch.com/mcp",
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        return {"error": f"AnySearch HTTP {error.code}", "detail": error.read().decode("utf-8", errors="replace")[:1000]}
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        return {"error": f"AnySearch search failed: {error}"}

    if not isinstance(data, dict):
        return {"error": "AnySearch API error: invalid response"}
    if isinstance(data.get("error"), dict):
        return {"error": f"AnySearch API error: {data['error'].get('message', 'unknown error')}"}
    result = data.get("result", {})
    if not isinstance(result, dict):
        return {"error": "AnySearch API error: invalid result"}
    content = result.get("content", [])
    text = next((str(item.get("text", "")) for item in content if isinstance(item, dict) and item.get("type") == "text"), "")
    if result.get("isError") or not text:
        return {"error": f"AnySearch API error: {_clip(text, 1000) or 'missing text result'}"}

    results = _anysearch_results(text)
    response = {"query": query, "answer": "", "results": results}
    if not results:
        response["content"] = _clip(text, 4000)
    return response


def _anysearch_results(text: str) -> list[dict]:
    blocks = re.split(r"(?m)^###\s+\d+\.\s+", text)[1:]
    results = []
    for block in blocks:
        title, _, body = block.partition("\n")
        url_match = re.search(r"(?m)^-\s+\*\*URL\*\*:\s*(\S+)\s*$", body)
        if not url_match:
            continue
        content = " ".join((body[: url_match.start()] + body[url_match.end() :]).split())
        if content.startswith("- "):
            content = content[2:]
        results.append(
            {
                "title": title.strip(),
                "url": url_match.group(1),
                "content": _clip(content, 800),
                "score": None,
                "published_date": "",
            }
        )
    return results


def _jina_fetch(workspace: Path, url: str, max_chars: int, friday_dir: Path | None = None) -> dict:
    target = url.strip()
    if urllib.parse.urlsplit(target).scheme not in {"http", "https"}:
        return {"error": "WebFetch URL must start with http:// or https://."}
    request = urllib.request.Request(
        "https://r.jina.ai/" + urllib.parse.quote(target, safe=":/?&=%"),
        headers=_jina_headers(),
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            content = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as error:
        return {"error": f"Jina HTTP {error.code}", "detail": error.read().decode("utf-8", errors="replace")[:1000]}
    except (urllib.error.URLError, TimeoutError) as error:
        return {"error": f"Jina fetch failed: {error}"}
    limit = min(50000, max(1, int(max_chars)))
    preview, artifact = _bounded_tool_output(friday_dir or project_state_dir(workspace), "webfetch", content, limit, ".md")
    return {
        "url": target,
        "content": preview,
        "chars": len(content),
        "truncated": bool(artifact),
        **artifact,
    }


def _jina_headers() -> dict[str, str]:
    headers = {"Accept": "text/markdown", "User-Agent": "FridayAgent/0.1"}
    api_key = os.getenv("JINA_API_KEY", "").strip()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


def _clip(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[: limit - 3] + "..."


def _bounded_tool_output(
    friday_dir: Path,
    kind: str,
    content: str,
    max_chars: int,
    suffix: str,
) -> tuple[str, dict[str, str]]:
    limit = max(1, int(max_chars))
    if len(content) <= limit:
        return content, {}
    digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
    context = get_current_context()
    session_id = str(context.metadata.get("session_id") or "") if context is not None else ""
    artifact_dir = friday_dir / "tool-results"
    if session_id and re.fullmatch(r"[A-Za-z0-9_-]+", session_id):
        artifact_dir /= session_id
    path = artifact_dir / f"{kind}-{digest[:16]}{suffix}"
    if not path.exists():
        _write_text(path, content)
    output_path = str(path.resolve())
    return _head_tail_preview(content, limit, output_path), {"full_output_path": output_path}


def _head_tail_preview(content: str, limit: int, full_output_path: str) -> str:
    marker = f"\n\n[Full output: {full_output_path}]\n\n"
    if limit <= len(marker) + 2:
        return content[:limit]
    room = limit - len(marker)
    head = (room + 1) // 2
    tail = room - head
    return content[:head] + marker + content[-tail:]


def _join_lines(lines: list[str], trailing_newline: bool) -> str:
    if not lines:
        return ""
    return "\n".join(lines) + ("\n" if trailing_newline else "")


def _write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, dir=path.parent) as file:
        file.write(content)
        temp_path = Path(file.name)
    temp_path.replace(path)


def _run_shell(
    workspace: Path,
    command: str,
    timeout_seconds: int = 60,
    max_chars: int = 8000,
    friday_dir: Path | None = None,
) -> dict:
    if platform.system() == "Windows":
        utf8_command = "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding;" + command
        cmd = ["powershell", "-NoProfile", "-Command", utf8_command]
    else:
        cmd = ["bash", "-lc", command]
    process = subprocess.Popen(
        cmd,
        cwd=workspace,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
        start_new_session=os.name != "nt",
    )
    try:
        output, _ = process.communicate(timeout=max(1, timeout_seconds))
    except subprocess.TimeoutExpired as error:
        _terminate_process_tree(process)
        try:
            output, _ = process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            output = _timeout_output(error)
        return _shell_result(workspace, output, max_chars, exit_code=None, timed_out=True, friday_dir=friday_dir)
    return _shell_result(
        workspace,
        output,
        max_chars,
        exit_code=process.returncode,
        timed_out=False,
        friday_dir=friday_dir,
    )


def _shell_result(
    workspace: Path,
    output: str | None,
    max_chars: int,
    *,
    exit_code: int | None,
    timed_out: bool,
    friday_dir: Path | None,
) -> dict:
    content = output or ""
    preview, artifact = _bounded_tool_output(friday_dir or project_state_dir(workspace), "bash", content, max_chars, ".txt")
    result = {"exit_code": exit_code, "timed_out": timed_out, "output": preview}
    if artifact:
        result.update({"chars": len(content), "truncated": True, **artifact})
    return result


def _terminate_process_tree(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
                check=False,
            )
        else:
            os.killpg(process.pid, signal.SIGKILL)
    except (OSError, subprocess.SubprocessError):
        process.kill()


def _timeout_output(error: subprocess.TimeoutExpired) -> str:
    output = error.output or ""
    return output.decode("utf-8", errors="replace") if isinstance(output, bytes) else output


def _dangerous_shell(command: str) -> str:
    lowered = _shell_surface(command).lower()
    checks = [
        (r"\b(remove-item|rm|del|erase|rmdir|rd)\b", "deletes files or directories"),
        (r"\b(git\s+(reset|clean))\b", "can discard git state"),
        (r"\b(set-content|add-content|out-file|new-item|move-item|rename-item)\b", "writes or moves files"),
        (r"\b(format-volume|format(?!-)|mkfs|dd|shutdown|restart-computer|stop-computer)\b", "can damage the system"),
    ]
    for pattern, reason in checks:
        if re.search(pattern, lowered):
            return reason
    for match in re.finditer(r"(?<![><])>{1,2}\s*([^|;&\s]+)", lowered):
        if match.group(1) not in {"$null", "nul", "/dev/null"}:
            return "redirects output to a file"
    return ""


def permission_mode() -> str:
    mode = os.getenv("FRIDAY_PERMISSION_MODE", "manual").strip().lower()
    return mode if mode in PERMISSION_MODES else "manual"


def set_permission_mode(mode: str) -> str:
    normalized = mode.strip().lower()
    if normalized not in PERMISSION_MODES:
        raise ValueError(f"Unknown permission mode: {mode}")
    os.environ["FRIDAY_PERMISSION_MODE"] = normalized
    return normalized


def _permission_decision(friday_dir: Path, command: str) -> tuple[str, str]:
    mode = permission_mode()
    if mode == "bypass":
        return "allow", "permission mode bypass"
    permissions = _read_permissions(friday_dir)
    bash = permissions.get("bash", {}) if isinstance(permissions, dict) else {}
    if not isinstance(bash, dict):
        bash = {}
    deny = [*list(bash.get("deny", []) if isinstance(bash.get("deny", []), list) else []), *_env_bash_rules("FRIDAY_DISALLOWED_TOOLS")]
    allow = [*list(bash.get("allow", []) if isinstance(bash.get("allow", []), list) else []), *_env_bash_rules("FRIDAY_ALLOWED_TOOLS")]
    if _matches_any(command, deny):
        return "deny", "matched deny rule"
    context = get_current_context()
    if context is not None and context.metadata.get(SESSION_PERMISSIONS_ALLOWED):
        return "allow", "approved for the current session"
    if _matches_any(command, allow):
        return "allow", "matched allow rule"
    if _matches_any(command, bash.get("require_approval", [])):
        return _approval_or_deny(mode, "matched approval rule")
    reason = _dangerous_shell(command)
    if mode == "accept-edits" and reason in {"writes or moves files", "redirects output to a file"}:
        return "allow", "permission mode accept-edits"
    if reason:
        return _approval_or_deny(mode, reason)
    return "allow", "safe by default"


def _approval_or_deny(mode: str, reason: str) -> tuple[str, str]:
    if mode == "dont-ask":
        return "deny", f"{reason}; permission mode dont-ask"
    return "approval", reason


def _env_bash_rules(name: str) -> list[str]:
    try:
        specs = json.loads(os.getenv(name, "[]"))
    except json.JSONDecodeError:
        return []
    rules = []
    for item in specs if isinstance(specs, list) else []:
        if not isinstance(item, str):
            continue
        spec = item.strip()
        lowered = spec.lower()
        if lowered == "bash":
            rules.append("*")
        elif lowered.startswith("bash(") and spec.endswith(")"):
            rules.append(spec[5:-1].rstrip("* ").strip())
    return rules


def _read_permissions(friday_dir: Path) -> dict:
    path = friday_dir / PERMISSIONS_FILE
    if not path.exists():
        return default_permissions()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return default_permissions()
    return data if isinstance(data, dict) else default_permissions()


def _matches_any(command: str, rules) -> bool:
    if not isinstance(rules, list):
        return False
    raw = command.strip().lower()
    surface = _shell_surface(command).strip().lower()
    for item in rules:
        if not isinstance(item, str):
            continue
        rule = item.strip().lower()
        if rule == "*":
            return True
        if rule and (raw == rule or raw.startswith(rule + " ") or surface == rule or surface.startswith(rule + " ")):
            return True
    return False


def _shell_surface(command: str) -> str:
    result = []
    quote = ""
    escaped = False
    for char in command:
        if escaped:
            result.append(" " if quote else char)
            escaped = False
            continue
        if char == "\\":
            result.append(" " if quote else char)
            escaped = True
            continue
        if quote:
            if char == quote:
                quote = ""
            result.append(" ")
            continue
        if char in {"'", '"'}:
            quote = char
            result.append(" ")
        else:
            result.append(char)
    return "".join(result)


def _write_approval(friday_dir: Path, command: str, timeout_seconds: int, max_chars: int, reason: str) -> dict:
    friday_dir.mkdir(parents=True, exist_ok=True)
    approval = {
        "id": str(int(time.time())),
        "command": command,
        "max_chars": max_chars,
        "reason": reason,
        "timeout_seconds": timeout_seconds,
    }
    _write_text(friday_dir / APPROVAL_FILE, json.dumps(approval, ensure_ascii=False, indent=2))
    return approval


def _context_for_paths(workspace: Path, paths: list[Path], loaded: set[Path]) -> list[dict[str, str]]:
    found = []
    for path in paths:
        resolved = path.resolve()
        current = resolved if resolved.is_dir() else resolved.parent
        if current != workspace and workspace in current.parents:
            parents = [parent for parent in [current, *current.parents] if parent != workspace and workspace in parent.parents]
            for parent in reversed(parents):
                for name in INSTRUCTION_FILE_NAMES:
                    context_file = parent / name
                    if context_file.exists() and context_file not in loaded:
                        loaded.add(context_file)
                        found.append(
                            {
                                "path": str(context_file.relative_to(workspace)),
                                "content": _read_limited(context_file, CONTEXT_FILE_LIMIT),
                            }
                        )
    return found


def _read_limited(path: Path, limit: int) -> str:
    text = path.read_text(encoding="utf-8")
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + f"\n\n[truncated: read {path} directly for the rest]"
