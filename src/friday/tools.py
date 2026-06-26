from __future__ import annotations

import platform
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Annotated, Literal

from agent_core import tool

USER_LIMIT = 1500
MEMORY_LIMIT = 2500
CONTEXT_FILE_LIMIT = 8000


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

    return [read_file, write_file, edit_file, run_shell, glob_files, grep_files, memory]


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


def _context_for_paths(workspace: Path, paths: list[Path], loaded: set[Path]) -> list[dict[str, str]]:
    found = []
    for path in paths:
        resolved = path.resolve()
        current = resolved if resolved.is_dir() else resolved.parent
        for parent in reversed([current, *current.parents]):
            if parent == workspace or workspace not in parent.parents:
                continue
            context_file = parent / "AGENTS.md"
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
