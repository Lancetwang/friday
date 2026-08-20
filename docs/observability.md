# Observability

Friday writes project-scoped trace records under:

```text
~/.friday/projects/<workspace-id>/traces-ts/
  <turn-timestamp>-<id>.json
  analyses/
    <session-id>/
      <analysis-id>.json
```

Each top-level JSON file is one completed, suspended, cancelled, verification,
or continuation record. It contains the session id, mode, status, bounded user
and assistant text, turn metrics, the current progress snapshot, and ordered
events. Trace files are written atomically per record; there is no
`events.jsonl`, manifest, or shared trace object store in the current format.

Default event data is redacted and bounded: strings are capped, arrays and
objects are limited, and deeply nested values are replaced. Normal model events
record request shape, tool names, response shape, and usage rather than the
complete prompt and response. Tool calls, tool results, approvals, guards,
compaction records, progress changes, and verification verdicts remain ordered
by each event's monotonic sequence number.

Turn input, output, and cache totals come from provider `usage` recorded between
that turn's start and finish. In-turn compaction and automatic permission review
can add usage without producing a normal Agent request event. Goal totals add
the independent verifier's separately measured usage. Title generation, memory
consolidation, and Trace Analyst calls run outside the traced Agent turn and do
not appear as normal Agent request rows.

Window occupancy is a different measurement: Friday anchors it to the latest
exact provider prompt count and estimates only the local message/tool-schema
delta until the next normal Agent response. Do not infer either occupancy or
total model-call count solely from the visible request rows.

## Trace Workbench

In the desktop app, select **Observability**. In the TUI, use `/trace`,
`/trace on`, or `/trace off`. Both surfaces ask the active gateway to start or
stop the same local Workbench; there is no separate `friday trace` CLI command.

The server binds to `127.0.0.1`, accepts only loopback `Host` headers, applies a
restrictive Content Security Policy, and disables caching. The Workbench groups
turn records by session and renders a flat execution log of user, assistant,
tool, verification, approval, guard, and compaction activity. Selecting a row
shows its stored data.

Trace Analyst receives a bounded, redacted JSON projection of the selected
session: at most 180,000 characters overall, 12,000 per projected item, and 12
stored analysis messages. Its conversations are saved under `analyses/` and do
not enter the original Agent session or memory.

Deleting a conversation removes its trace records, analyses, checkpoints, and
session tool-spill directory. Resetting a project removes the project-scoped
trace directory with the rest of that project's Friday state.

The default projection bounds each trace record, but Friday does not currently
apply a project-wide trace count or byte quota. Records remain until their
conversation is deleted or the project is reset. Exact payload mode can make
individual records much larger.

## Exact payload mode

Set `FRIDAY_TRACE_PAYLOADS=1` before starting Friday to additionally retain the
exact redacted request and response payload observations emitted by the main
Core Agent:

```powershell
$env:FRIDAY_TRACE_PAYLOADS = '1'
friday
```

Payload strings are not clipped, although secret-looking fields and values are
redacted. This mode persists payload observations attached to the main
session's Core `Agent`. Direct Harness calls such as compaction, title
generation, automatic permission review, memory consolidation, and Trace
Analyst do not create those observations. The independent verifier uses its own
`RunContext`, so its Core observations are not attached to or persisted with
the main session.

Exact payload mode can store the complete system prompt and workspace content,
and the local Workbench and Analyst projection can inspect a bounded form of
those events. Keep the entire `traces-ts` directory private. Redaction is a
defence against accidental credential capture, not a guarantee that traces
contain no sensitive source code or personal data.
