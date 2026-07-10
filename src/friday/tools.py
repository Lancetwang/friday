from __future__ import annotations

import json
import os
import platform
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Annotated, Literal

from agent_core import tool

USER_LIMIT = 1500
MEMORY_LIMIT = 2500
CONTEXT_FILE_LIMIT = 8000
SKILL_LIMIT = 12000
APPROVAL_FILE = "pending_approval.json"
PERMISSIONS_FILE = "permissions.json"
INSTRUCTION_FILE_NAMES = (
    "AGENTS.md",
    ".friday/AGENTS.md",
)


def build_tools(workspace: Path, friday_dir: Path):
    workspace = workspace.resolve()
    friday_dir.mkdir(parents=True, exist_ok=True)
    user_dir = Path.home() / ".friday"
    user_dir.mkdir(parents=True, exist_ok=True)
    loaded_context_files: set[Path] = set()

    def in_workspace(path: str) -> Path:
        resolved = (workspace / path).resolve()
        if resolved != workspace and workspace not in resolved.parents:
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
        limit = max(1, line_count)
        out: list[str] = []
        size = 0
        for number, line in enumerate(lines[start - 1 : start - 1 + limit], start=start):
            rendered = f"{number}: {line}"
            if out and size + len(rendered) + 1 > max_chars:
                break
            out.append(rendered)
            size += len(rendered) + 1
        end = start + len(out) - 1 if out else start - 1
        return with_context({
            "path": str(file_path),
            "total_lines": len(lines),
            "start_line": start,
            "end_line": end,
            "truncated": end < len(lines),
            "content": "\n".join(out),
        }, [file_path])

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
            return {**approval, "approval_required": True, "message": "Command blocked. Run /approve to execute it or /reject to discard it."}
        return _run_shell(workspace, command, timeout_seconds, max_chars)

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

    @tool(description="Search the live web with Tavily when current external information is needed.", name="WebSearch")
    def web_search(
        query: Annotated[str, "Search query."],
        max_results: Annotated[int, "Maximum results to return, 1-10."] = 5,
        search_depth: Annotated[Literal["basic", "advanced"], "Search depth."] = "basic",
        topic: Annotated[Literal["general", "news", "finance"], "Search topic."] = "general",
        include_answer: Annotated[bool, "Include Tavily's answer summary."] = True,
        time_range: Annotated[str, "Optional time range: day, week, month, or year."] = "",
    ) -> dict:
        return _tavily_search(query, max_results, search_depth, topic, include_answer, time_range)

    @tool(description="Fetch a specific URL as clean Markdown with Jina Reader.", name="WebFetch")
    def web_fetch(
        url: Annotated[str, "HTTP or HTTPS URL to fetch."],
        max_chars: Annotated[int, "Maximum characters to return."] = 8000,
    ) -> dict:
        return _jina_fetch(url, max_chars)

    @tool(description="List or read on-demand SKILL.md instructions. Use list first; read only when a skill is relevant.", name="Skill")
    def skill(
        action: Annotated[Literal["list", "read"], "Skill action to perform."],
        name: Annotated[str, "Skill name to read. Leave empty when listing."] = "",
    ) -> dict:
        skills = _discover_skills(workspace, user_dir)
        if action == "list":
            return {"skills": [{"name": key, "description": item["description"], "path": str(item["path"])} for key, item in skills.items()]}
        if action == "read":
            key = name.strip().lower()
            if key not in skills:
                raise ValueError(f"Unknown skill: {name}")
            item = skills[key]
            return {"name": key, "path": str(item["path"]), "content": _read_limited(item["path"], SKILL_LIMIT)}
        raise ValueError(f"Unknown skill action: {action}")

    @tool(description="Read or update Friday memory files.", name="Memory")
    def memory(
        action: Annotated[Literal["read", "add", "replace", "remove"], "Memory action to perform."],
        target: Annotated[Literal["user", "global", "project"], "user=USER.md, global=global MEMORY.md, project=workspace MEMORY.md."],
        content: Annotated[str, "New note text, replacement text, or exact text to remove."] = "",
        old_text: Annotated[str, "Exact text to replace when action is replace."] = "",
    ) -> dict:
        path, limit = _memory_target(target, user_dir, friday_dir)
        path.parent.mkdir(parents=True, exist_ok=True)
        current = path.read_text(encoding="utf-8") if path.exists() else _memory_header(target)

        if action == "read":
            return {"target": target, "path": str(path), "content": current, "chars": len(current)}

        if not content.strip():
            raise ValueError("content is required.")
        if action == "add":
            updated = current.rstrip() + f"\n- {content.strip()}\n"
        elif action == "replace":
            if not old_text:
                raise ValueError("old_text is required for replace.")
            count = current.count(old_text)
            if count != 1:
                raise ValueError(f"Expected exactly one match, found {count}.")
            updated = current.replace(old_text, content, 1)
        elif action == "remove":
            count = current.count(content)
            if count != 1:
                raise ValueError(f"Expected exactly one match, found {count}.")
            updated = current.replace(content, "", 1)
        else:
            raise ValueError(f"Unknown memory action: {action}")

        if len(updated) > limit:
            raise ValueError(f"{target} memory would exceed {limit} characters; replace or remove old entries first.")
        _write_text(path, updated)
        return {"target": target, "path": str(path), "chars": len(updated)}

    return [read_file, write_file, edit_file, run_shell, glob_files, grep_files, web_search, web_fetch, skill, memory]


def approve_pending(workspace: Path | None = None, *, reject: bool = False) -> dict:
    root = (workspace or Path.cwd()).resolve()
    path = root / ".friday" / APPROVAL_FILE
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
    )
    return {"approved": True, "approval": approval, "result": result}


def pending_approval(workspace: Path | None = None) -> dict:
    root = (workspace or Path.cwd()).resolve()
    path = root / ".friday" / APPROVAL_FILE
    if not path.exists():
        return {"pending": False, "message": "No pending approval."}
    try:
        approval = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"pending": False, "message": "Invalid pending approval."}
    return {"pending": True, **approval}


def default_permissions() -> dict:
    return {"version": 1, "bash": {"allow": [], "deny": [], "require_approval": []}}


def skill_catalog(workspace: Path) -> str:
    skills = _discover_skills(workspace.resolve(), Path.home() / ".friday")
    if not skills:
        return ""
    lines = ["Available skills. Use the Skill tool to read a full SKILL.md only when relevant:"]
    lines.extend(f"- {name}: {item['description']}" for name, item in skills.items())
    return "\n".join(lines)


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


def _jina_fetch(url: str, max_chars: int) -> dict:
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
    limit = min(50000, max(1000, int(max_chars)))
    return {"url": target, "content": _clip(content, limit), "chars": len(content), "truncated": len(content) > limit}


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


def _run_shell(workspace: Path, command: str, timeout_seconds: int = 60, max_chars: int = 8000) -> dict:
    if platform.system() == "Windows":
        cmd = ["powershell", "-NoProfile", "-Command", command]
    else:
        cmd = ["bash", "-lc", command]
    try:
        completed = subprocess.run(
            cmd,
            cwd=workspace,
            text=True,
            capture_output=True,
            timeout=max(1, timeout_seconds),
        )
    except subprocess.TimeoutExpired as error:
        output = ((error.stdout or "") + (error.stderr or ""))[-max_chars:]
        return {"exit_code": None, "timed_out": True, "output": output}
    output = (completed.stdout + completed.stderr)[-max_chars:]
    return {"exit_code": completed.returncode, "timed_out": False, "output": output}


def _dangerous_shell(command: str) -> str:
    lowered = _shell_surface(command).lower()
    checks = [
        (r"\b(remove-item|rm|del|erase|rmdir|rd)\b", "deletes files or directories"),
        (r"\b(git\s+(reset|clean))\b", "can discard git state"),
        (r"\b(set-content|add-content|out-file|new-item|move-item|rename-item)\b", "writes or moves files"),
        (r"(^|[^><])>{1,2}(?![=>])", "redirects output to a file"),
        (r"\b(format-volume|format|mkfs|dd|shutdown|restart-computer|stop-computer)\b", "can damage the system"),
    ]
    for pattern, reason in checks:
        if re.search(pattern, lowered):
            return reason
    return ""


def _permission_decision(friday_dir: Path, command: str) -> tuple[str, str]:
    mode = os.getenv("FRIDAY_PERMISSION_MODE", "manual").strip().lower()
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


def _discover_skills(workspace: Path, user_dir: Path) -> dict[str, dict[str, str | Path]]:
    roots = [
        workspace / ".friday" / "FridaySkills",
        user_dir / "FridaySkills",
    ]
    found: dict[str, dict[str, str | Path]] = {}
    for root in roots:
        if not root.exists():
            continue
        for skill_file in sorted(root.glob("*/SKILL.md")):
            name, description = _skill_meta(skill_file)
            key = name.strip().lower() or skill_file.parent.name.lower()
            if key not in found:
                found[key] = {"description": description, "path": skill_file}
    return found


def _skill_meta(path: Path) -> tuple[str, str]:
    text = path.read_text(encoding="utf-8")
    name = path.parent.name
    description = ""
    if text.startswith("---\n"):
        end = text.find("\n---", 4)
        if end != -1:
            for line in text[4:end].splitlines():
                key, sep, value = line.partition(":")
                if sep and key.strip() == "name":
                    name = value.strip().strip("\"'")
                elif sep and key.strip() == "description":
                    description = value.strip().strip("\"'")
    if not description:
        for line in text.splitlines():
            stripped = line.strip()
            if stripped and not stripped.startswith(("#", "---")):
                description = stripped
                break
    return name, description or "No description."


def _memory_target(target: str, user_dir: Path, friday_dir: Path) -> tuple[Path, int]:
    if target == "user":
        return user_dir / "USER.md", USER_LIMIT
    if target == "global":
        return user_dir / "MEMORY.md", MEMORY_LIMIT
    if target == "project":
        return friday_dir / "MEMORY.md", MEMORY_LIMIT
    raise ValueError(f"Unknown memory target: {target}")


def _memory_header(target: str) -> str:
    if target == "user":
        return "# User Profile\n"
    if target == "global":
        return "# User Memory\n"
    return "# Project Memory\n"
