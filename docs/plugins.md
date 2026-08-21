# Plugins

Friday's reusable Core accepts a model, a tool list, and a `RunContext`, then
runs the guarded model → tools → model loop. The Harness has one capability
registry for narrow product-level contributions around that loop: tools,
prompt sections, transparent tool wrappers, and singleton memory and context-
compaction providers. Friday's built-in capability packs and external plugins
both participate in that registry.

The registry is deliberately narrower than the Harness itself. Sessions,
permissions, checkpoints, traces, and Goal verification remain ordinary
Harness services. Memory and compaction are replaceable singleton services:
the Harness fixes when they run and how their outputs enter a turn, while the
selected provider owns storage/retrieval or context-rewrite policy. The public
plugin contract does not expose arbitrary session-lifecycle hooks, and Core
imports none of it.

## The built-in plugins

| Plugin | Contributes | Notes |
| --- | --- | --- |
| `workspace` | Read, Write, Edit, Glob, Grep, Bash, UpdatePlan | Required; cannot be disabled |
| `web` | WebSearch, WebFetch | |
| `memory` | Memory tool, durable profile/memory prompt, and memory provider | The provider owns per-turn recall/capture and consolidation |
| `skills` | Skill tool, plus the routing prompt section | Routing re-evaluates every turn |
| `compaction` | Automatic and manual context compaction provider | Compatibility default: insert-and-compact at 85% |

`/plugins` in the TUI, `plugin.list` on the gateway, and `session.info` all
report this registry - name, scope (`builtin`/`project`/`user`), contributed
capabilities, tools, disabled state, and any errors.

## Switching a plugin on or off

- **TUI**: `/plugins` opens the picker; `Enter` flips the selected plugin.
- **Desktop**: Settings → Plugins, one switch per plugin.
- **Anywhere**: `disabled_plugins` in `~/.friday/config.json` or the
  project's config.json, or `FRIDAY_DISABLED_PLUGINS=web,memory` in the
  environment.

The effective disabled set is the union of both JSON layers and the environment
list. A UI toggle persists the choice in JSON, then reloads the active session;
Friday rejects the change until all requests in that gateway are idle.
Only that active session is rebuilt. Other cached sessions and other gateway
processes keep their assembled registry until a later toggle rebuilds them or
they are recreated. An environment-disabled plugin cannot be re-enabled from a
UI running in that environment.

Disabling is real, not cosmetic: a disabled `memory` removes the Memory tool,
its durable profile/memory prompt section, future recall/capture, and model-backed
consolidation. It does not delete memory files or rewrite recall already embedded
in the append-only conversation; administrative inspection and editing remain
available. A disabled `web` removes WebSearch and WebFetch from the main Agent
and Goal-mode verifier. A disabled `skills` removes the Skill tool and routing
prompt from the main Agent, and the Skill tool from the verifier. Disabling
`compaction` removes the provider for both automatic and manual compaction. At
the configured threshold Friday then stops tool use safely and asks the user to
enable a provider; the TUI's `/compact` and Desktop's **Compact now** both
report that none is enabled. The required `workspace` pack refuses and records
why.
`FRIDAY_DISABLE_PLUGINS=1` (singular) skips external plugin code entirely - the
right default for hermetic evaluation runs.

## Configuring compaction

The desktop exposes **Settings → Compaction**, including **Compact now** for
the active conversation. The TUI accepts:

```text
/compaction
/compaction auto on|off
/compaction threshold 50..95
/compaction strategy insert|two-stage
```

The corresponding `config.json` shape is:

```json
{
  "compaction": {
    "automatic": true,
    "threshold_percent": 85,
    "strategy": "insert"
  }
}
```

Global values in `~/.friday/config.json` are the base; project values override
them. UI changes are saved to the project configuration. `automatic: false`
keeps the provider and manual compaction available, but stops tool use at the
threshold and asks the user to compact manually. This is intentionally
different from disabling the plugin.

`insert` is the compatibility strategy and runs the existing semantic
insert/transcript/offline compaction path. `two-stage` first considers complete
old assistant-call/result batches. It protects the latest three batches and
replaces an old result only when its receipt saves at least 512 characters.
Receipts contain the tool, outcome, original character count, and SHA-256
digest. The exact result remains in durable session data and is restored for
the UI, resume, and forks. The candidate is transactional: unless receipts
alone reduce occupancy to 15 percentage points below the configured threshold
(never below 40%), Friday restores every original result before semantic
compaction reads the history.

## Writing an external plugin

The installed `friday-agent` package exposes the stable authoring contract at
`friday-agent/plugin`. Import it as a type while developing; the resulting
module has no runtime dependency on that subpath. Compile TypeScript to one
`.mjs` or `.js` ES module before placing it in a plugin directory.

```ts
// ticket-lookup.ts
import type { FridayPlugin } from 'friday-agent/plugin'

export default {
  name: 'ticket-lookup',
  version: '1.0.0',
  description: 'Looks tickets up in the local tracker.',

  // Optional. A string, or a function re-evaluated on every prompt rebuild.
  // Rendered as `## Plugin: ticket-lookup` after Friday's own rules.
  instructions: 'Use the Ticket tool whenever the user names a ticket id.',

  // Optional: extra tools. Same Tool shape friday-agent-core uses.
  tools({ workspace }) {
    return [{
      name: 'Ticket',
      description: 'Fetch one ticket by id from the local tracker.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Ticket id.' } },
        required: ['id'],
        additionalProperties: false
      },
      async execute(args) {
        return lookupTicket(String(args.id))
      }
    }]
  },

  // Optional: middleware over every assembled tool, built-in and plugin alike.
  wrapTool({ workspace }, tool) {
    return {
      ...tool,
      async execute(args, signal, onProgress) {
        const started = Date.now()
        try {
          return await tool.execute(args, signal, onProgress)
        } finally {
          console.error(`[audit] ${tool.name} ${Date.now() - started}ms`)
        }
      }
    }
  }
} satisfies FridayPlugin
```

| Scope | Directory |
| --- | --- |
| Project | `<workspace>/.friday/plugins/*.mjs` or `*.js` |
| User | `~/.friday/plugins/*.mjs` or `*.js` |

Files with either extension must contain an ES module. Project plugins shadow
user plugins with the same name. Files are re-imported when a new session
starts, so editing a plugin takes effect with `/new` - no gateway restart
needed.

### Memory service contract

A memory plugin may contribute a singleton `memory` service:

```js
export default {
  name: 'my-memory',
  memory: {
    async prepare({ workspace, sessionId, text }) {
      const recall = await searchMyStore(workspace, text)
      const capture = await captureInMyStore(workspace, sessionId, text)
      return { recall, capture }
    },
    async consolidate({ workspace, days, signal, review }) {
      const candidates = await recentCandidates(workspace, days)
      const operations = await review({ candidates })
      return applyValidatedOperations(operations, signal)
    }
  }
}
```

`prepare()` runs once before each public user turn; internal repair turns and
approval continuations do not recall or capture again. Its optional `recall`
string is prepended to that same user message, preserving the existing append-
only conversation shape. Its optional `capture` object is an observability
receipt emitted as `memory.updated`; the provider performs any durable write
itself. `consolidate()` is optional. The Harness supplies the requested window,
an abort signal, and a security-scoped model `review(payload)` callback, while
the provider owns candidate selection and validated storage changes.

Memory is a singleton. Built-ins register first, so an additional provider is
reported as a plugin error instead of silently taking over. To use an external
provider, disable the built-in `memory` plugin and leave the external one
enabled. The Harness still owns turn timing, user-message placement, events,
and the consolidation command; the provider owns memory behavior.

### Compaction service contract

`compact(request)` receives the live `RunContext`, assembled tools, model
configuration, effective compaction settings, a text-only-capable `ChatModel`,
an `archive(messages)` callback, `force` for manual `/compact`, and an optional
`AbortSignal`. It returns `{ record?, summary? }`; a record carries the before
and after occupancy. The Harness replaces those occupancy fields with its own
measurement and emits `context.compacted` if the provider did not already emit
one. An implementation that removes model-visible messages must pass the exact
originals to `archive` so history remains resumable.

Compaction is a singleton. Built-ins register first, so an additional provider
is reported as a plugin error instead of silently taking over. To use an
external provider such as `my-compactor`, disable the built-in `compaction`
plugin and leave `my-compactor` enabled. The host still owns threshold checks,
manual dispatch, persistence, and the final context-window guard; the provider
owns only the rewrite policy.

## Rules the host enforces

- **Registered names win.** Built-ins assemble first, so a plugin tool whose
  name collides with an existing tool is skipped and recorded. Silently
  swapping a tool the model already knows is how injection-shaped bugs are
  born.
- **Wrappers must be transparent.** `wrapTool` must return a tool with the
  same name, description, and parameters object; anything else is discarded
  and recorded. Middleware may observe and veto, not impersonate.
- **One compactor wins.** The first enabled `compact()` provider owns the
  singleton service. Later providers are left visible but receive a conflict
  error; registration order never changes silently.
- **One memory provider wins.** The first enabled `memory` service owns recall,
  capture, and optional consolidation. Later providers stay visible with a
  conflict error; disable the current owner before selecting another.
- **Load failures are isolated.** Import errors, invalid exports, and thrown
  factories are captured per plugin; the session starts without the broken
  parts. Plugins are still trusted process-local code, so this is not
  protection against a module that blocks or terminates the process.
- **The verifier assembles from built-ins only.** Goal-mode verification uses
  only the tool names the host declares for built-in packs, never external
  plugin code. Missing declarations fail when the verifier tools are assembled.
  The user's disabled list is honored there too. Its Bash tool has an extra
  mutation filter, but this is command screening rather than an OS sandbox.
- **External modules cannot claim host privileges.** `required` and
  `verifierTools` are stripped while loading external plugins; only the host
  can make a pack mandatory or expose tools to the verifier.
- **Prompt position is fixed.** Capability and plugin sections render after
  Friday's security, runtime, and user rule sections and before the
  environment. They can guide tool choice; they cannot outrank the security
  boundary. External sections are prefixed `Plugin:` so the model can tell
  whose voice it is reading.

## Trust model

A plugin is local code executed with the same privileges as Friday itself,
like an editor extension. Installing one is an act of trust in its author.
Friday does not sandbox plugin execution; it narrows the supported extension
surface (tools, prompt sections, wrappers, memory, and compaction) rather than
limiting what trusted plugin code can do on the machine you already let Friday
work on.
