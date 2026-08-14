# Plugins

Friday's runtime core is deliberately small: a guarded model → tools → model
loop. Everything the product adds - workspace tools, web access, memory,
skills, plans - reaches the agent through two seams: the tool list the loop
receives and the system prompt the session composes. Plugins are user code
that travels through those same seams, so extending Friday does not mean
patching its core.

## What a plugin is

One ES module whose default export describes the extension:

```js
// .friday/plugins/ticket-lookup.mjs
export default {
  name: 'ticket-lookup',
  version: '1.0.0',
  description: 'Looks tickets up in the local tracker.',

  // Optional: appended to the system prompt as `## Plugin: ticket-lookup`.
  instructions: 'Use the Ticket tool whenever the user names a ticket id.',

  // Optional: extra tools for the agent. Same Tool shape friday-agent-core uses.
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
        // Runs with Friday's own privileges. Throwing reports a tool error.
        return lookupTicket(String(args.id))
      }
    }]
  },

  // Optional: middleware over every tool, built-in and plugin alike.
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

## Where plugins live

| Scope | Directory |
| --- | --- |
| Project | `<workspace>/.friday/plugins/*.mjs` |
| User | `~/.friday/plugins/*.mjs` |

Project plugins shadow user plugins with the same name. Files are re-imported
when a new session starts, so editing a plugin takes effect with `/new` -
no gateway restart needed. Set `FRIDAY_DISABLE_PLUGINS=1` to run without
plugins, which evaluation environments should do unless the evaluation is
about a plugin.

## Rules the host enforces

- **Built-ins cannot be replaced.** A plugin tool whose name collides with a
  registered tool is skipped and the collision is recorded on the plugin's
  error list. Silently swapping a tool the model already knows is how
  injection-shaped bugs are born.
- **Wrappers must be transparent.** `wrapTool` must return a tool with the
  same name, description, and parameters object; anything else is discarded
  and recorded. Middleware may observe and veto, not impersonate.
- **A broken plugin never breaks Friday.** Import errors, invalid exports,
  and thrown factories are captured per plugin and shown in `/plugins` and
  `plugin.list`; the session starts without the broken parts.
- **The verifier stays clean.** Goal-mode verification runs with the built-in
  read-only tool set; plugin tools and wrappers are never applied to it, so
  independent verification cannot be steered by the code it is checking.
- **Prompt position is fixed.** Plugin instructions render after Friday's
  security, runtime, and user rule sections and before the environment
  section. They can guide tool choice; they cannot outrank the security
  boundary.

## Trust model

A plugin is local code executed with the same privileges as Friday itself,
like an editor extension. Installing one is an act of trust in its author.
Friday does not sandbox plugin execution; it bounds what plugins can change
about the *agent contract* (tools, prompt) rather than what their code can do
on the machine you already let Friday work on.

## Inspecting

- TUI: `/plugins`
- Gateway: `{"method": "plugin.list"}` → `{ plugins: [{ name, version, description, scope, source, tools, has_instructions, errors }] }`
- `session.info` includes the same report under `plugins` for the live session.

## Direction

The plugin surface is intentionally the same one built-ins use. The intended
end state is a thin execution core plus a host that assembles capabilities,
with built-in tool packs (workspace, web, memory, skills) registered through
the same interface plugins use - so the difference between "shipped with
Friday" and "added by you" is packaging, not architecture.
