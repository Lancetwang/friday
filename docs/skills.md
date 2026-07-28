# Skills

Skills are reusable workflows stored as `SKILL.md` files.

Friday discovers skills from:

```text
~/.friday/projects/<workspace-id>/FridaySkills/<skill>/SKILL.md
~/.friday/FridaySkills/<skill>/SKILL.md
```

The startup prompt contains only one routing instruction. Run `friday skill list --json` through Bash to list each available skill's `name`, `description`, `scope`, and `SKILL.md` path. After selecting one, use Bash to read its `SKILL.md`, referenced files, or scripts as needed.

For human-readable output:

```powershell
friday skill list
```

Project skills take precedence over same-named user skills. Friday also provisions a user-level `friday-cli` skill that explains how to inspect Friday's own commands and deterministic pipelines, including `friday skill ...` and `friday memory ...`.

Friday's own commands use the same progressive help structure:

```powershell
friday help
friday skill help
friday memory help
friday memory search --help
```

A minimal skill:

```markdown
---
name: code-review
description: Review code changes and report correctness risks, missing tests, and regressions.
---

# Code Review

Use when the user asks Friday to review code changes.

## Workflow

1. Inspect the changed files.
2. Prioritize bugs, regressions, risky behavior, and missing tests.
3. Report findings first, ordered by severity.
4. Keep summaries short.

## Checks

- Prefer `git diff` and focused file reads.
- Cite file paths and line numbers when possible.
- Do not rewrite code unless the user asks.
```

The frontmatter routing fields are returned by `friday skill list --json`:

- `name`: stable skill id shown to the agent.
- `description`: short routing text used before the full skill is loaded.
- `scope`: `project` or `user`.
- `path`: absolute path to the selected entry `SKILL.md`.

The Markdown body is progressive disclosure. It is not included in the startup prompt or listing; Friday reads it with Bash only after choosing the skill. Other Markdown files, references, templates, and scripts remain in the skill directory and are accessed only when the selected `SKILL.md` calls for them.

Keep skills focused. A skill should teach one repeatable workflow, not become a second system prompt.
