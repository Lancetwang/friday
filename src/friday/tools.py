from __future__ import annotations

import platform
import subprocess
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

    @tool(description="Read a UTF-8 text file inside the current workspace.")
    def read_file(
        path: Annotated[str, "Path inside the workspace."],
        start_line: Annotated[int, "1-based line number to start reading from."] = 1,
        max_chars: Annotated[int, "Maximum characters to return."] = 6000,
    ) -> dict:
        file_path = in_workspace(path)
        text = file_path.read_text(encoding="utf-8")
        lines = text.splitlines()
        start = max(1, start_line)
        out: list[str] = []
        size = 0
        for number, line in enumerate(lines[start - 1 :], start=start):
            rendered = f"{number}: {line}"
            if out and size + len(rendered) + 1 > max_chars:
                break
            out.append(rendered)
            size += len(rendered) + 1
        return {"path": str(file_path), "line_count": len(lines), "content": "\n".join(out)}

    @tool(description="Create or overwrite a UTF-8 text file inside the current workspace.")
    def write_file(
        path: Annotated[str, "Path inside the workspace."],
        content: Annotated[str, "Full file content."],
    ) -> dict:
        file_path = in_workspace(path)
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_text(content, encoding="utf-8")
        return {"path": str(file_path), "chars": len(content), "lines": len(content.splitlines())}

    @tool(description="Replace exact text in a UTF-8 text file inside the current workspace.")
    def edit_file(
        path: Annotated[str, "Path inside the workspace."],
        old_text: Annotated[str, "Exact text to replace."],
        new_text: Annotated[str, "Replacement text."],
    ) -> dict:
        file_path = in_workspace(path)
        text = file_path.read_text(encoding="utf-8")
        count = text.count(old_text)
        if count != 1:
            raise ValueError(f"Expected exactly one match, found {count}.")
        file_path.write_text(text.replace(old_text, new_text, 1), encoding="utf-8")
        return {"path": str(file_path), "replacements": 1}

    @tool(description="Run a shell command in the current workspace. Uses PowerShell on Windows.")
    def run_shell(
        command: Annotated[str, "Shell command to run."],
        timeout_seconds: Annotated[int, "Timeout in seconds."] = 60,
        max_chars: Annotated[int, "Maximum output characters to return."] = 8000,
    ) -> dict:
        if platform.system() == "Windows":
            cmd = ["powershell", "-NoProfile", "-Command", command]
        else:
            cmd = ["bash", "-lc", command]
        completed = subprocess.run(
            cmd,
            cwd=workspace,
            text=True,
            capture_output=True,
            timeout=timeout_seconds,
        )
        output = (completed.stdout + completed.stderr)[-max_chars:]
        return {"exit_code": completed.returncode, "output": output}

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

    return [read_file, write_file, edit_file, run_shell, read_memory, remember]
