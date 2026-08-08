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

Turn input, output, and cache totals come from provider `usage` and are summed
across that turn's model calls. Window occupancy is separate: Friday anchors it
to the latest exact provider `prompt_tokens`; messages added after that response
are reported as a labeled local delta until the next request supplies a fresh
exact anchor. Cumulative input is never treated as the current window size.

## Trace Workbench

```powershell
friday trace list
friday trace show <session-id>
friday trace serve
```

`friday trace serve` binds to `127.0.0.1` and rejects requests whose `Host`
header is not a loopback name, so a page on the open web cannot point a hostname
it controls at `127.0.0.1` and read traces through the browser. It opens a local
three-pane WebUI:
session list, turn audit, and Trace Analyst. Each turn is one expandable row
with ordered user, model, tool, verification, approval, and compaction events.
The audit surface emphasizes status, duration, provider token usage, cache
usage, tool arguments, and tool results; message bodies stay collapsed as raw
evidence instead of being rendered as a second chat transcript. Node and flow
events remain on disk for evaluation but do not clutter the human view.
`/trace` opens the same UI from chat or TUI.

The analyst automatically receives the same bounded, redacted event projection
that the Workbench exposes through **Load audit evidence**, including public
request messages, assistant tool calls and arguments, tool results, timing, and
usage. No event selection or tool loop is required; questions appear
immediately and answers stream into the analysis pane. Analysis conversations
are stored under `analyses/` and never enter the original session or its memory.

Deleting a conversation removes its trace, analysis, checkpoints, and
session-scoped large tool outputs as one lifecycle unit. Resetting the current
project removes all traces belonging to that workspace.

The local raw trace object store may include source code, prompt payloads,
command output, and personal data, so keep the observability directory private.
The Workbench and Trace Analyst receive redacted behavior projections and do
not expose the private control prefix.
