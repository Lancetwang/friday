# Memory

Friday separates long-term memory, short-term state, and project rules.

Long-term files:

- `~/.friday/USER.md`: stable user profile and preferences.
- `~/.friday/MEMORY.md`: global cross-project memory.
- `<workspace>/.friday/MEMORY.md`: project memory.

Short-term context is not a file. Current-task state lives in the live conversation; session history is restored with `friday resume`, and long conversations are compacted into an in-session summary that rides in the conversation itself.

Rule files:

- `~/.friday/AGENTS.md`: global rules Friday follows in every workspace (do/don't, file routing, and your own cross-project rules). Project rules override it.
- `AGENTS.md`: project rules (root or nested); shared with any other agent that reads `AGENTS.md`.

Rules are not memory. Edit rule files directly; the `Memory` tool never writes to them.

Use the `Memory` tool for durable facts only. Do not save compact summaries, temporary command output, or transient task progress as memory.

`/compact` first gives Friday a chance to save durable facts, then replaces the long conversation with a structured in-session summary message that continues the task and is restored by resume.

