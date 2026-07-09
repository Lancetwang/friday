# Skills

Skills are reusable workflows stored as `SKILL.md` files.

Friday discovers skills from:

```text
<workspace>/.friday/FridaySkills/<skill>/SKILL.md
~/.friday/FridaySkills/<skill>/SKILL.md
```

Only skill names and descriptions enter the startup prompt. Full skill content is loaded on demand through the `Skill` tool.

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

The frontmatter is the skill catalog:

- `name`: stable skill id shown to the agent.
- `description`: short routing text used before the full skill is loaded.

The Markdown body is progressive disclosure. It is not included in the startup prompt; Friday reads it only after the agent chooses the skill with the `Skill` tool.

Keep skills focused. A skill should teach one repeatable workflow, not become a second system prompt.
