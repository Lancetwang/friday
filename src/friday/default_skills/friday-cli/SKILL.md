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
- Run `friday memory help` before managing persistent memory. Use `user` for stable profile facts, `global` for cross-project facts, `project` for lasting workspace facts, and `episode` for dated personal context.
- Use `friday memory list|search --json` for structured inspection and `friday memory add|update|remove` for changes. Run `friday memory consolidate --days 2` to merge repeated episodes and promote stable high-frequency facts. Current task state belongs to `UpdatePlan`, not memory.

Memory may store explicit durable user facts and lasting project facts; never infer a profile from one-off behavior. Do not edit Friday configuration, rules, or permissions unless the user explicitly asks.
