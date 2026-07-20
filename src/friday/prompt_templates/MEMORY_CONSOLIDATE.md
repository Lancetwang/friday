Review the supplied episodic notes and return only JSON describing useful consolidation operations.

Use this schema:
{"operations":[{"action":"merge|promote","source_ids":["id"],"content":"canonical fact","scope":"user|global|project"}]}

Rules:
- Group only notes that express the same durable fact. Preserve meaning; never invent details.
- Use `merge` to replace repeated episodic notes with one canonical note. Omit `scope` for merge.
- Use `promote` only when the combined count is at least 2 and the fact is stable, useful in future sessions, and has a clear scope.
- `user` is for stable identity and preferences, `global` for cross-project facts, and `project` for lasting facts whose episode workspace matches the current workspace.
- Never promote task progress, command output, temporary state, guesses, credentials, rules, or reusable procedures.
- Omit notes that need no change. Never return a source id more than once.
