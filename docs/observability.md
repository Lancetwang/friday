# Observability

Friday records every new session under:

```text
~/.friday/observability/sessions/<session-id>/
  manifest.json
  events.jsonl
  objects/
  analyses/
```

`events.jsonl` is append-only while the conversation exists. It records turn boundaries, exact model request
and response payloads, tool calls and results, context compaction, verification,
progress, timing, and provider usage. Messages, tool schemas, and large results
are stored once in `objects/`; events keep ordered references, so the exact
request can be reconstructed without copying the growing context on every
model call. Compaction changes the resumable session state but never rewrites
the raw trace.

## Trace Workbench

```powershell
friday trace list
friday trace show <session-id>
friday trace serve
```

`friday trace serve` binds to `127.0.0.1` and opens a local three-pane WebUI:
session list, agent behavior timeline, and Trace Analyst. The timeline projects
the lossless trace into only `YOU`, `FRI`, and grouped `TOOL` entries; node and
flow events remain on disk for evaluation but do not clutter the human view.
`/trace` opens the same UI from chat or TUI.

The analyst automatically receives a bounded evidence packet for the selected
session and makes one call through Friday's configured DeepSeek-compatible
model. No event selection or tool loop is required; questions appear
immediately and answers stream into the paper-style analysis pane. Analysis
conversations are stored under `analyses/` and never enter the original
session or its memory.

Deleting a conversation removes its trace, analysis, checkpoints, and
session-scoped large tool outputs as one lifecycle unit. Resetting the current
project removes all traces belonging to that workspace.

The local raw trace object store may include source code, prompt payloads,
command output, and personal data, so keep the observability directory private.
The Workbench and Trace Analyst receive redacted behavior projections and do
not expose the private control prefix.
