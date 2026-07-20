# Memory

Friday's memory system is file-based and owned by the harness. It separates stable facts, recalled personal episodes, current task progress, and project rules.

## Storage

- `~/.friday/USER.md`: bounded stable user profile and preferences.
- `~/.friday/MEMORY.md`: bounded global cross-project facts.
- `<workspace>/.friday/MEMORY.md`: bounded project facts and lasting decisions.
- `~/.friday/memory/YYYY-MM-DD.md`: dated episodic notes captured as original user text.
- `<workspace>/.friday/sessions/*.json`: exact resumable conversation and progress snapshots.
- `<workspace>/.friday/traces/*.jsonl`: observability evidence, not normal recall material.

`friday.progress` is the only live task-state store. It holds the current objective, plan, status, next action, and verifier result. Episodic notes record what happened; they never duplicate or update live progress.

## Capture And Recall

Friday deterministically detects explicit memory signals such as "remember", "from now on", preferences, and corrections. Ordinary candidates are saved to the current dated Markdown file with hidden source, session, and occurrence-count metadata. Exact repeats increment the existing count instead of adding another bullet. An explicit request to remember something forever, permanently, or always skips the episode and is routed directly to user, global, or project memory. Credential-like content is rejected.

Before each model turn, the harness searches episodic Markdown with English terms and Chinese character pairs. It injects at most three relevant entries and labels them as background evidence; the current user statement always wins over stale or conflicting memory. This dynamic tail does not alter the stable system-prefix order.

The main agent can promote a durable fact into hot memory through Bash and the CLI. No separate memory model, database, or model tool is required:

```powershell
friday memory help
friday memory status
friday memory list user --json
friday memory search "preferred language" --json
friday memory add --scope user "Preferred language is Chinese."
friday memory update <id> "Default response language is Chinese."
friday memory remove <id>
friday memory consolidate --days 2
```

`consolidate` reads recent episodes and existing permanent memory, makes one non-streaming LLM call, then applies only validated `merge` and `promote` operations. Promotion requires a combined count of at least two. Unknown, unsupported, transient, or single notes remain untouched. Entries are ordinary Markdown bullets; hidden HTML comments carry ids, sources, timestamps, and episode counts. Friday removes those comments from the model prefix.

## Context Lifecycle

`USER.md`, global memory, and project memory are loaded into a frozen system prefix at session start. A memory change is written to disk immediately but does not rewrite the active system message. The updated hot memory enters context on the next start, resume, or compact rebuild.

`/compact` first gives Friday a chance to persist ordinary memory candidates as episodes, then rebuilds the live context from the fresh prefix, structured summary, latest ten complete user turns, and one current progress checkpoint. Only explicitly permanent requests bypass episodes. Compact summaries and temporary task progress are never stored as long-term memory.

Rule files:

- `~/.friday/AGENTS.md`: user-owned cross-project operating rules (language, toolchain, validation, and other do/don't preferences). Project rules override it.
- `AGENTS.md`: project rules (root or nested); shared with any other agent that reads `AGENTS.md`.

System-owned behavior lives in bundled `RUNTIME.md` and `TOOL_GUIDANCE.md`; it is versioned with Friday rather than copied into user rules. Rules are not memory. Memory commands accept only fixed scopes and never edit rule, model, or permission files.

Do not save secrets, command output, temporary conclusions, compact summaries, or transient task progress as memory. Reusable procedures belong in skills.
