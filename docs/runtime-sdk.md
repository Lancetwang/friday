# Composable Harness SDK (v0.9.1)

`friday-agent-core` remains a dependency-free model/tool loop. It has no Friday
configuration, filesystem persistence, permissions, search, memory, Skills or
compaction dependencies. The Core's awaited `checkpoint(context, boundary)`
hook is a generic execution boundary; the Harness implements durability there.

The workspace package `friday-agent-harness` now exports a reusable SDK. It is
not yet published as a separate npm distribution. CLI and desktop still use
`FridaySession`, so these integrations exercise the same runtime.

```ts
import { FridaySession, loadModelConfig, dockerExecution } from 'friday-agent-harness'

const workspace = process.cwd()
const session = await FridaySession.create(workspace, 'example', {
  config: loadModelConfig(workspace),
  builtinCapabilities: ['workspace', 'skills', 'compaction'],
  resources: { requests: 80, tokens: 2_000_000, timeoutMs: 900_000 },
  // Optional: use a preinstalled image containing the tools your task requires.
  execution: dockerExecution({ image: 'my-agent-tools:local' }),
  plugins: [{
    name: 'domain-guidance',
    instructions: 'Validate generated domain records against the local schema.',
    activate({ signal }) {
      // Start per-session resources here; observe signal and return cleanup.
      return async () => { /* close your connections */ }
    }
  }]
})
try {
  const result = await session.chat('Inspect this workspace')
  console.log(result.status, result.text)
  await session.reloadPlugins() // requires an idle session
} finally {
  await session.close()
}
```

`builtinCapabilities: []` disables all shipped capability packs for an embedded
host. Default Friday products still require the workspace pack. `modelFactory`
can inject another `ChatModel` or a deterministic model without an API key;
`verifierConfig` selects a separate verifier profile. `ExecutionBackend` is a
host service shared by ordinary Bash, approvals and verifier Bash. It does not
enter Core and external plugins cannot replace the verifier's tool registry.

The Docker backend mounts only the workspace, uses a read-only root filesystem,
bounds memory/CPU/processes, and disables networking by default. Verifier mounts
are read-only. It requires Docker and an existing compatible image; Friday does
not pull an image or silently fall back to native execution. Long-lived managed
background services currently require the native backend. Set
`FRIDAY_EXECUTION_IMAGE=my-agent-tools:local` to select Docker in the gateway;
`FRIDAY_VERIFIER_PROFILE=profile-id` selects a saved verifier profile.

Native commands and trusted in-process plugins retain host privileges. Docker
isolates shell commands, not JavaScript plugin modules. Plugin authors must
observe abort signals and clean up resources; CPU-bound or malicious plugin
code requires an out-of-process host, which is outside this implementation.

## Durability and concurrency

Model responses are persisted before tool dispatch, and every completed tool
result is persisted before the next model request. Failures keep the user's
request, successful tool results, available usage, checkpoints and an error
trace. Unexpected EOF never becomes a successful final answer. Explicit output
truncation returns `status: 'incomplete'`; its tool calls are not executable.

A snapshot contains an execution id, status and revision. Opening an interrupted
execution adds an error result for every unfinished tool call. It does not
replay those calls: a process can die after an external side effect but before
recording its result. Inspection or an application-level idempotency key is
needed to resolve that uncertainty. Stale process locks expire after 30 seconds.

A session execution lock prevents concurrent turns in the same persisted
session. A workspace mutation lock is acquired before checkpointing the first
potentially mutating built-in tool and held through turn persistence. Read-only
turns can overlap. This coordinates cooperating Friday processes; it does not
lock out editors, external processes, or already-started background services.
Custom tools that mutate shared state must implement an equivalent preflight
boundary or use a host-controlled isolated workspace.

Model settings and credentials commit together to private `model-state.json`
under a cross-process lock. Existing `models.json` and `model-credentials.json`
are read as legacy input until the first save. They remain on disk as historical
files and must still be treated as secret where appropriate; after migration,
edit settings through Friday or the new state file.

## Budgets and model limits

A shared run ledger covers main, compaction, approval review, verification and
retry requests. Approval and Goal continuations reuse the same deadline and
ledger. Defaults are 100 model requests, 400 tool calls, 15 minutes, and the
profile's `run_token_budget` (40 million by default). The final time reserve is
30 seconds or 20% for shorter runs. A first-byte timer defaults to 60 seconds;
stream-idle timeout is 45 seconds and includes non-text transport activity.

Token accounting uses reported usage when available and conservative estimates
otherwise; the ledger marks estimates. Remaining tokens constrain the next
request's output cap. Estimates are not a billing guarantee. Anthropic cache
reads and writes both occupy the prompt window; only cache reads are cache hits.
Raw provider usage remains available in traces. Model discovery uses reported
per-model limits. Unknown new profiles use conservative 32,768/4,096 context and
output defaults; configure the actual limits for your provider.

## Storage and protocol

Sessions, forks and checkpoints share immutable pages of 32 messages under
`message-objects`. Existing inline-array snapshots remain readable; each record
migrates on its next save. `readRecord` hydrates either format, and
`readMessagePage` reads only intersecting pages. Session summary indexes are
rebuildable caches. `collectMessageObjects(workspace)` removes unreferenced
pages while holding the publication lock; session deletion also performs GC.

Traces default to 1,000 files, 30 days and 256 MiB per workspace. The SDK's
`traceRetention` overrides those values. Retention applies to trace JSON files;
separately saved analyst conversations are removed with their session. Existing
Workbench polling reuses parsed traces until their file metadata changes.

JSON-RPC accepts an optional `protocol_version: 1` and rejects unsupported
versions and invalid envelopes/parameter types before dispatch. Session events
carry `run_id`. Existing methods remain supported; new methods are
`plugin.reload`, `session.list {offset, limit}`, and
`session.messages {id, offset, limit}`. The latter pages the stored model-context
messages; `session.current` remains the hydrated UI history endpoint.
`RuntimeMethods` and `requestTyped` provide typed contracts for the primary
settings/session calls while legacy clients retain their existing request API.

Tool arguments must be JSON objects. The default portable validator covers
object properties/required/additionalProperties, enums/constants, arrays,
primitive types, bounds, patterns and combinators. `Tool.validate` can provide
another dialect, references or formats. Tool failures can throw or return an
explicit `{isError: true, ...}` envelope; error state survives provider replay.
