# Memory

Friday's memory system is file-based and owned by the Harness. Durable facts,
episodic recall, resumable conversation, and live progress are separate stores.

## Storage

- `~/.friday/USER.md`: bounded stable user profile and preferences.
- `~/.friday/MEMORY.md`: bounded global cross-project facts.
- `~/.friday/projects/<workspace-id>/MEMORY.md`: bounded project facts and lasting decisions.
- `~/.friday/memory/YYYY-MM-DD.md`: dated episodic notes captured from public user messages.
- `~/.friday/projects/<workspace-id>/sessions/*.json`: resumable messages, archived messages, progress, and session metadata.
- `~/.friday/projects/<workspace-id>/traces-ts/*.json`: observability records, not recall material.

Compaction bounds the model-facing prompt, not stored history: the session
snapshot retains archived messages so resume, UI history, and forks remain
complete. Long conversations and branches therefore continue to consume disk.
Episodic notes and trace records also have no automatic age-based expiry;
consolidation removes only episode entries used by accepted merge or promotion
operations. See [Checkpoints](checkpoints.md) for the additional cost of copied
conversation arrays and [Observability](observability.md) for trace retention.

`friday.progress` inside `RunContext.artifacts` is the live task-state record. It
holds the objective, latest request, mode, plan, status, next action, and a small
verifier summary. It is persisted in the session snapshot but is not inserted as
a standalone model message.

## Capture and recall

Before each public user turn, Friday checks the message for explicit memory
signals such as “remember”, “from now on”, preferences, and corrections.
Ordinary candidates are saved to the current dated episode with hidden source,
session, and occurrence-count metadata. Exact repeats increment the count rather
than adding another visible bullet. A request to remember something forever,
permanently, or always goes directly to user, global, or project memory.
Credential-like content is rejected.

For that same turn, Friday searches episodic Markdown with English terms and
Chinese character pairs. At most three relevant entries are prepended to the
user message and labelled as background evidence. This keeps recall in the
append-only conversation body instead of inserting and later deleting a system
message. The current user statement wins over recalled content.

Memory is evidence from an earlier point in time, not authority over current
state. Before relying on a remembered file, function, flag, date, or external
resource, the Agent is instructed to check the current workspace or source.

## Managing memory

The built-in `Memory` tool is the Agent's memory interface; it does not invoke a
second `friday` process. People can inspect the same store from the TUI:

```text
/memory help
/memory status
/memory list user
/memory search preferred language
/memory add user Preferred language is Chinese.
/memory update <id> Default response language is Chinese.
/memory remove <id>
/memory consolidate --days 2
```

`consolidate` reads recent episodes and existing permanent memory, makes one
non-streaming model call, then applies only validated `merge` and `promote`
operations. Promotion requires a combined occurrence count of at least two.
Unknown, unsupported, transient, or single notes remain untouched. Entries are
ordinary Markdown bullets; hidden HTML comments carry ids, sources, timestamps,
and episode counts, and are removed from the model-facing prefix.

Disabling the `memory` capability removes the Memory tool and also stops
automatic capture and recall for subsequent public turns.

## Context lifecycle

The system prompt contains `USER.md`, global memory, and project memory. Friday
builds it when a session is created and refreshes it before a new user turn,
before an approval continuation, when plugins or the model are reloaded, and
before a manual `/compact`. Automatic compaction inside an already running tool
loop preserves the current system prefix rather than rereading memory files.

Compaction asks the summarizer for a `## Memory` section, removes that section
from the live session summary, and reports its candidates in the compaction
record. The current Harness does not persist those candidates. Durable writes
come only from automatic user-message capture, the Memory tool, TUI memory
commands, desktop memory settings, or consolidation. `/compact` by itself does
not create long-term memory.

The desktop **Settings > General** fields manage a marked profile block inside
`USER.md`. **Settings > Memory** edits bounded user and global memory; project
and episodic memory remain available through `/memory`.

Rule files are separate from memory:

- `~/.friday/AGENTS.md`: user-owned cross-project operating rules.
- `AGENTS.md` and `.friday/AGENTS.md` from the workspace and its ancestors:
  project rules loaded into the system prompt.

System-owned behavior lives in bundled prompt files. Do not store credentials,
command output, temporary conclusions, compact summaries, or transient task
progress as durable memory. Reusable procedures belong in Skills.
