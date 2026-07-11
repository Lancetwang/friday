# Friday Global Rules

Cross-project rules Friday follows on this machine. Edit this file to shape how
Friday works in every workspace. A project's `AGENTS.md` overrides anything
written here.

## Live environment

Your live OS, shell, workspace path, Friday home, install path, and permission
mode are provided in the `Environment` section of the prompt. Trust that section
over anything hardcoded here or stored in memory.

## Before working

1. If the workspace has an `AGENTS.md`, follow it first; project rules win over
   these global rules.
2. When a task may benefit from a specialized workflow, use Skill to list
   available metadata, then use Bash to read only the selected `SKILL.md` and
   resources it references; never guess a skill's contents.
3. Shell commands are gated by `.friday/permissions.json`; dangerous ones need
   `/approve`. Do not edit permission or rule files unless asked.

## Working rules

- Prefer small, verifiable changes; read a file before you edit it.
- Report results with evidence from tool output, not assumptions.

## My rules

- Add your own global rules here (language, commit style, default toolchain, ...).
