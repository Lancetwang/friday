"""Bundled prompt templates and dynamic prompt builders."""

from __future__ import annotations

import os
import platform
from datetime import date
from importlib.resources import files
from pathlib import Path

from friday.config import ModelConfig


def prompt_template(name: str) -> str:
    return (files("friday.prompt_templates") / name).read_text(encoding="utf-8")


COMPACT_PROMPT = prompt_template("COMPACT.md").strip()
MEMORY_CONSOLIDATE_PROMPT = prompt_template("MEMORY_CONSOLIDATE.md").strip()
VERIFIER_NOTES = prompt_template("VERIFIER.md").strip()


def environment(workspace: Path, config: ModelConfig) -> str:
    system = platform.system()
    shell = "PowerShell" if system == "Windows" else "bash"
    mode = os.getenv("FRIDAY_PERMISSION_MODE", "manual").strip() or "manual"
    return prompt_template("ENVIRONMENT.md").format(
        workspace=workspace,
        current_date=date.today().isoformat(),
        system=system,
        release=platform.release(),
        shell=shell,
        friday_home=Path.home() / ".friday",
        friday_install=Path(__file__).resolve().parent,
        global_config=Path.home() / ".friday" / "config.json",
        project_config=workspace / ".friday" / "config.json",
        provider=config.provider,
        model=config.model,
        context_window=config.context_window,
        max_output_tokens=config.max_output_tokens,
        run_token_budget=config.run_token_budget,
        permission_mode=mode,
    )


def default_project_instructions() -> str:
    return prompt_template("PROJECT.md")


def goal_attempt_prompt(goal: str) -> str:
    return f"""Goal mode. Treat the original goal as persistent and do not narrow, weaken, or reinterpret it during execution.
Do not stop at a plan, progress report, or partial delivery. Completion requires an independent verifier pass.
Continue through concrete repairs until pass, approval, a proven blocker, insufficient evidence with no useful next check, repeated no-progress, or the Token Budget.

Original goal:
{goal}"""


def retry_prompt(goal: str, attempt: int, feedback: str) -> str:
    return f"""Verification requested repair after attempt {attempt}. Continue working toward the original request without weakening it.

Original request:
{goal}

Verifier feedback:
{feedback}"""
