# Memory

Friday separates long-term memory, short-term state, and project rules.

Long-term files:

- `~/.friday/USER.md`: stable user profile and preferences.
- `~/.friday/MEMORY.md`: global cross-project memory.
- `<workspace>/.friday/MEMORY.md`: project memory.

Short-term state is session-scoped rather than long-term memory. The message chain remains the single conversation context, while the session snapshot also persists the current objective, plan, status, next action, and verifier state. `friday resume` restores both.

Rule files:

- `~/.friday/AGENTS.md`: global rules Friday follows in every workspace (do/don't, file routing, and your own cross-project rules). Project rules override it.
- `AGENTS.md`: project rules (root or nested); shared with any other agent that reads `AGENTS.md`.

Rules are not memory. Edit rule files directly; the `Memory` tool never writes to them.

Use the `Memory` tool for durable facts only. Do not save compact summaries, temporary command output, or transient task progress as memory.

`UpdatePlan` updates the visible progress for non-trivial work and emits append-only trace events. `/compact` first gives Friday a chance to save durable facts, then rebuilds the live context from a structured in-session summary plus the latest ten complete user turns copied verbatim and one current progress checkpoint. Tool calls and their results inside those turns stay paired.
