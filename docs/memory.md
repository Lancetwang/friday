# Memory

Friday separates long-term memory, short-term state, and project rules.

Long-term files:

- `~/.friday/USER.md`: stable user profile and preferences.
- `~/.friday/MEMORY.md`: global cross-project memory.
- `<workspace>/.friday/MEMORY.md`: project memory.

Short-term file:

- `<workspace>/.friday/STATE.md`: current goal, completed work, open items, tried methods, working files, verification state, next steps, and recent conversations.

Project rule files:

- `AGENTS.md`: cross-agent project guidance.
- `FRIDAY.md`: Friday-specific project guidance.
- `FRIDAY.local.md`: private local Friday guidance.

Use the `Memory` tool for durable facts only. Do not save compact summaries, temporary command output, or transient task progress as memory.

`/compact` first gives Friday a chance to save durable facts, then writes structured short-term state to `.friday/STATE.md`.

