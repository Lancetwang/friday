---
name: friday-cli
description: Use Friday's deterministic CLI to inspect skills, memory, sessions, traces, and harness state.
---

# Friday CLI

Use the CLI from broad discovery to the narrow operation you need:

1. Run `friday --help` for top-level capabilities.
2. Run `friday <command> --help` for that capability's exact arguments.
3. Prefer `--json` when another command or script will consume the result.

For skills, run `friday skill --json`, select by `name` and `description`, then read only its returned `SKILL.md` and referenced resources. For memory, start with `friday memory --help`; persistent facts belong there, while current task progress does not.

Use CLI operations instead of editing files under `~/.friday` directly. Do not change memory, configuration, rules, or permissions unless the user requested that change.
