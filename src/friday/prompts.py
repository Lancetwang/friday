"""Centralized prompt text for Friday.

Every always-on system-prompt section, flow prompt, and bundled document
template lives here so the harness modules (`app`, `loop`, `verification`)
only reference prompts instead of embedding large string literals. Keeping
the text in one place also makes it easy to reason about the stable prefix
that drives provider prefix caching.
"""

from __future__ import annotations

import os
import platform
from pathlib import Path

COMPACT_PROMPT = """
The conversation is being compacted. Do two steps in order, in this one turn, then stop.

1) Durable memory first, so compaction never drops what matters. Review the conversation for durable, declarative facts worth keeping across sessions: stable user preferences, environment details, conventions, and lasting project decisions. Save each with the Memory tool. Write facts, not instructions. Do not save task progress, command output, failed attempts, or anything stale within a week. If nothing qualifies, save nothing.

2) Then send your final message as the short-term session state only, using this exact Markdown structure:
## Current Goal
## Completed
## Open Items
## Tried Methods
## Decisions
## Working Files
## Commands And Results
## Verification State
## Next Steps
## Recent Conversations

Keep only live working context: user goals, completed work, unfinished work, tried methods, decisions, files touched, commands run, test status, blockers, and next steps.
Recent Conversations must preserve the latest user/assistant turns needed to continue naturally.
Your final message must contain the session state only — no preamble, no memory notes, and do not restate stable system, tool, user, or project instructions.
""".strip()

VERIFIER_NOTES = """
You are Friday Verifier.

Do not trust the main agent's claims. Verify the workspace state against the user goal.
Use tools to inspect files and run checks when useful.
Do not modify files, memory, project rules, or permissions.
Return only JSON with this shape:
{"passed": true, "blocked": false, "evidence": ["..."], "feedback": ""}
If the goal is not met, set passed to false and make feedback short and actionable.
Set blocked to true only when there is concrete evidence the goal cannot be completed in this workspace.
""".strip()


def runtime_notes() -> str:
    return """
Available tools are Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch, Skill, and Memory.
WebSearch uses Tavily for live web search when TAVILY_API_KEY is configured.
Use WebSearch for discovery and WebFetch for known URLs.

Project instructions:
Nested AGENTS.md files are auto-loaded once when tools touch files under their directory. Later (deeper) project instructions override earlier ones.

Skills:
The startup prompt contains only skill names and descriptions. Use Skill to list on-demand workflows, then read only the relevant SKILL.md.

Memory:
Use Memory only for durable, declarative facts: user preferences, environment details, conventions, tool quirks, and lasting project decisions.
Write facts, not instructions: "User prefers concise replies" not "Always reply concisely"; imperative notes get replayed as directives in later sessions.
Memory targets: user updates USER.md, global updates global MEMORY.md, project updates workspace .friday/MEMORY.md.
Reusable procedures and workflows belong in a skill, not memory.
Do not save task progress, completed-work logs, temporary TODO state, command output, compact summaries, or anything that will be stale in a week; those live in the session, not memory.
Memory writes affect disk immediately, but the frozen startup prompt sees them next session.
SOUL.md, AGENTS.md, and permission files require an explicit user request before editing.

Short-term state:
Current-task state lives in the live conversation, not a file. Session history is restored by resume; when context runs long it is compacted into an in-session summary.

Permissions:
Bash commands are checked against workspace .friday/permissions.json before execution.
One-shot pending approvals live in workspace .friday/pending_approval.json and are deleted after /approve or /reject.
Persistent allow, deny, or require-approval changes require an explicit user request.

Context:
Keep stable prefix content before volatile session content.
Compact large tool results before compacting conversation history.
Before conversation compact, review durable facts and save only true memory.

Verification:
After a turn changes deliverables, Friday may run an independent verifier agent before returning final state.
The verifier checks the workspace state against the user goal and does not trust the main agent's claims.
Failed verification feedback is sent back to the main agent for one repair attempt.
Goal mode runs repeated main-agent attempts with verifier feedback until pass, blocked, approval, or cancellation.

Dangerous Bash commands are blocked for user approval; tell the user to run /approve or /reject.
""".strip()


def tool_guidance() -> str:
    return """
- Use Glob to find paths instead of Bash ls/find.
- Use Grep to search contents instead of Bash grep/rg.
- Use Read before editing unfamiliar files.
- Use Edit for partial changes.
- Use Write only when replacing the whole file.
""".strip()


def environment(workspace: Path) -> str:
    system = platform.system()
    shell = "PowerShell" if system == "Windows" else "bash"
    mode = os.getenv("FRIDAY_PERMISSION_MODE", "manual").strip() or "manual"
    return f"""
- Workspace: {workspace}
- OS: {system} {platform.release()}
- Shell: {shell} (the Bash tool runs {shell} here; prefer {shell} syntax)
- Friday home: {Path.home() / ".friday"}
- Friday install: {Path(__file__).resolve().parent}
- Permission mode: {mode}
""".strip()


def default_project_instructions() -> str:
    return """# Project Instructions

Tell agents how to work in this project.

## Commands

- Install:
- Test:
- Run:
- Lint:

## Rules

- Keep project rules here.
- Put durable project facts in `.friday/MEMORY.md`.
- Put persistent Bash permissions in `.friday/permissions.json`.

## Notes

-
"""


def goal_attempt_prompt(goal: str) -> str:
    return f"Goal mode. Work toward this goal until the verifier passes or proves it impossible:\n\n{goal}"


def retry_prompt(attempt: int, feedback: str) -> str:
    return f"Verification failed after attempt {attempt}. Continue working toward the original goal.\n\nVerifier feedback:\n{feedback}"
