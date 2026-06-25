from __future__ import annotations

import platform
import re
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Annotated, Literal

from agent_core import tool


def build_tools(workspace: Path, friday_dir: Path):
    workspace = workspace.resolve()
    friday_dir.mkdir(parents=True, exist_ok=True)
    user_dir = Path.home() / ".friday"
    user_dir.mkdir(parents=True, exist_ok=True)

    def in_workspace(path: str) -> Path:
        resolved = (workspace / path).resolve()
        if resolved != workspace and workspace not in resolved.parents:
            raise ValueError(f"Path escapes workspace: {path}")
        return resolved

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
        return {
            "path": str(file_path),
            "total_lines": len(lines),
            "start_line": start,
            "end_line": end,
            "truncated": end < len(lines),
            "content": "\n".join(out),
        }

    @tool(description="Create or overwrite a UTF-8 text file inside the current workspace.", name="Write")
    def write_file(
        path: Annotated[str, "Path inside the workspace."],
        content: Annotated[str, "Full file content."],
    ) -> dict:
        file_path = in_workspace(path)
        _write_text(file_path, content)
        return {"path": str(file_path), "chars": len(content), "lines": len(content.splitlines())}

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
            return {
                "path": str(file_path),
                "mode": "line_range",
                "start_line": start,
                "end_line": end,
                "replacement_lines": len(replacement_lines),
                "total_lines": len(new_lines),
            }
        if not old_text:
            raise ValueError("Provide start_line/end_line or old_text.")
        count = text.count(old_text)
        if count != 1:
            raise ValueError(f"Expected exactly one match, found {count}.")
        _write_text(file_path, text.replace(old_text, replacement, 1))
        return {"path": str(file_path), "mode": "exact_text", "replacements": 1}

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
        return {"pattern": pattern, "count": len(matches), "paths": matches}

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
                        return {"pattern": pattern, "count": len(matches), "matches": matches}
        return {"pattern": pattern, "count": len(matches), "matches": matches}

    @tool(description="Read Friday memory notes.")
    def read_memory(
        scope: Annotated[Literal["project", "user"], "Memory scope to read."] = "project",
    ) -> dict:
        path = friday_dir / "MEMORY.md" if scope == "project" else user_dir / "MEMORY.md"
        return {"scope": scope, "path": str(path), "content": path.read_text(encoding="utf-8") if path.exists() else ""}

    @tool(description="Append a short note to Friday memory.")
    def remember(
        note: Annotated[str, "Short memory note to append."],
        scope: Annotated[Literal["project", "user"], "Memory scope to update."] = "project",
    ) -> dict:
        path = friday_dir / "MEMORY.md" if scope == "project" else user_dir / "MEMORY.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
        with path.open("a", encoding="utf-8") as file:
            file.write(f"\n- {stamp}: {note.strip()}\n")
        return {"scope": scope, "path": str(path)}

    return [read_file, write_file, edit_file, run_shell, glob_files, grep_files, read_memory, remember]


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
