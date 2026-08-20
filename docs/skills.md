# Skills

Skills are reusable workflows stored as `SKILL.md` files.

Friday discovers skills from:

```text
~/.friday/projects/<workspace-id>/FridaySkills/<skill>/SKILL.md
<workspace>/.friday/FridaySkills/<skill>/SKILL.md
~/.friday/FridaySkills/<skill>/SKILL.md
```

The system prompt contains only each skill's `name` and `description`. When one matches a task, the `Skill` tool reads that skill's `SKILL.md`; referenced files are loaded only when the skill asks for them.

The project-state directory wins over the workspace-local directory for the
same skill name, and either project source wins over a user skill.

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

The frontmatter provides the routing fields:

- `name`: stable skill id shown to the agent.
- `description`: short routing text used before the full skill is loaded.

Friday derives `scope` and the absolute path from where the skill was discovered; they do not need to be repeated in frontmatter.

The Markdown body is progressive disclosure. It is not included in the system prompt; Friday reads it through the `Skill` tool only after choosing the skill. Other Markdown files, references, templates, and scripts remain in the skill directory and are accessed only when the selected `SKILL.md` calls for them.

Keep skills focused. A skill should teach one repeatable workflow, not become a second system prompt.
