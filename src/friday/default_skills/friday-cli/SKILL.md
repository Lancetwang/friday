---
name: friday-cli
description: Inspect Friday's own CLI and deterministic pipelines before guessing how the harness works.
---

# Friday CLI

Use Friday's CLI for Friday-specific inspection instead of reconstructing its behavior with ad hoc commands.

- Run `friday --help` to discover current top-level commands.
- Run `friday <command> --help` before using an unfamiliar command.
- Run `friday skill list --json` to discover available skills and their `SKILL.md` paths.
- After selecting a skill, read only its `SKILL.md` and the scripts, references, or templates it names.

Do not edit Friday configuration, memory, rules, or permissions unless the user explicitly asks.
