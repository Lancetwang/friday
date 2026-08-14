# Plugins

Friday's runtime core is a guarded model → tools → model loop and nothing
else. **Everything outside that loop is a plugin**, including the
capabilities Friday ships with: there is one registry, and the only two seams
any capability can use - the tool list the loop receives and the system
prompt the session composes - are the same for built-in and user code. The
difference between "shipped with Friday" and "added by you" is packaging,
not architecture.

## The built-in plugins

| Plugin | Contributes | Notes |
| --- | --- | --- |
| `workspace` | Read, Write, Edit, Glob, Grep, Bash, UpdatePlan | Required; cannot be disabled |
| `web` | WebSearch, WebFetch | |
| `memory` | Memory tool, plus per-turn recall and capture | Disabling silences recall/capture too |
| `skills` | Skill tool, plus the routing prompt section | Routing re-evaluates every turn |

`/plugins` in the TUI, `plugin.list` on the gateway, and `session.info` all
report this registry - name, scope (`builtin`/`project`/`user`), contributed
tools, disabled state, and any errors.

## Switching a plugin on or off

- **TUI**: `/plugins` opens the picker; `Enter` flips the selected plugin.
- **Desktop**: Settings → Plugins, one switch per plugin.
- **Anywhere**: `disabled_plugins` in `~/.friday/config.json` or the
  project's config.json, or `FRIDAY_DISABLED_PLUGINS=web,memory` in the
  environment.

All three drive the same switch (the UI toggle persists into
`disabled_plugins` and applies immediately). Disabling is real, not
cosmetic: a disabled `memory` removes the Memory tool *and* stops
recall/capture in every turn; a disabled `web` or `skills` disappears from
the agent, the prompt, and the Goal-mode verifier. The required `workspace`
pack refuses and records why. `FRIDAY_DISABLE_PLUGINS=1` (singular) skips
external plugin code entirely - the right default for hermetic evaluation
runs.

## Writing an external plugin

One ES module whose default export describes the extension:

```js
// .friday/plugins/ticket-lookup.mjs
export default {
  name: 'ticket-lookup',
  version: '1.0.0',
  description: 'Looks tickets up in the local tracker.',

  // Optional. A string, or a function re-evaluated on every prompt rebuild
  // (that is how the built-in skills plugin keeps its routing list fresh).
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
}
```

| Scope | Directory |
| --- | --- |
| Project | `<workspace>/.friday/plugins/*.mjs` |
| User | `~/.friday/plugins/*.mjs` |

Project plugins shadow user plugins with the same name. Files are re-imported
when a new session starts, so editing a plugin takes effect with `/new` - no
gateway restart needed.

## Rules the host enforces

- **Registered names win.** Built-ins assemble first, so a plugin tool whose
  name collides with an existing tool is skipped and recorded. Silently
  swapping a tool the model already knows is how injection-shaped bugs are
  born.
- **Wrappers must be transparent.** `wrapTool` must return a tool with the
  same name, description, and parameters object; anything else is discarded
  and recorded. Middleware may observe and veto, not impersonate.
- **A broken plugin never breaks Friday.** Import errors, invalid exports,
  and thrown factories are captured per plugin; the session starts without
  the broken parts.
- **The verifier assembles from built-ins only.** Goal-mode verification uses
  the read-only tools each built-in pack declares (checked loudly at build
  time), never external plugin code - verification cannot be steered by the
  code it is checking. The user's disabled list is honored there too.
- **Prompt position is fixed.** Capability and plugin sections render after
  Friday's security, runtime, and user rule sections and before the
  environment. They can guide tool choice; they cannot outrank the security
  boundary. External sections are prefixed `Plugin:` so the model can tell
  whose voice it is reading.

## Trust model

A plugin is local code executed with the same privileges as Friday itself,
like an editor extension. Installing one is an act of trust in its author.
Friday does not sandbox plugin execution; it bounds what plugins can change
about the *agent contract* (tools, prompt) rather than what their code can do
on the machine you already let Friday work on.
