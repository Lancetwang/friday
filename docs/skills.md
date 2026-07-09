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
# My Skill

Use when the user asks for this specific workflow.

Steps:

1. Inspect the relevant files.
2. Make the smallest safe change.
3. Run the smallest useful check.
```

Keep skills focused. A skill should teach one repeatable workflow, not become a second system prompt.

