# Friday Project Instructions

Friday is the application harness for a small personal CLI agent built on `agent-core-runtime`.

## Harness

- Keep the startup prompt stable for prefix caching.
- Treat the agent as a router, not a place to paste every workflow or long file.
- Load full skills through the Skill tool only when relevant.
- Keep context, memory, tools, permissions, approval, resume, and compaction as separate systems.

## Memory

- Save durable user preferences, cross-project facts, and project decisions with the Memory tool.
- Do not save compact summaries as memory.
- Keep `.friday/MEMORY.md` for project memory, not project rules.

## Context

- Keep stable prefix content before volatile session content.
- Compact large tool results before compacting conversation history.
- Use conversation compact only when tool compaction is not enough.

## Permissions

- Keep persistent Bash permissions in `.friday/permissions.json`.
- Keep one-shot pending approvals in `.friday/pending_approval.json`.
- Do not edit permission files unless the user explicitly asks.
