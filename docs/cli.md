# CLI Commands

Top-level commands:

```powershell
friday
friday init
friday help
friday doctor [--json]
friday skill list
friday skill list --json
friday skill help
friday memory help
friday memory status
friday memory list [user|global|project|episode|all] [--json]
friday memory search <query> [--scope <scope>] [--json]
friday memory add --scope <scope> <text>
friday memory update <id> <text>
friday memory remove <id>
friday memory consolidate [--days 2] [--json]
friday trace list [--json]
friday trace show <session-id> [--json]
friday trace serve [--port 8765] [--no-open]
friday undo
friday undo --checkpoint <id>
friday checkpoint list [--json]
friday checkpoint restore <id> [--force]
friday ask "..."
friday goal "..."
friday chat
friday tui
friday feishu
friday feishu --console
friday compact
friday resume
friday resume --list
friday resume --session <id>
friday session list
friday session rename <id> <title>
friday session delete <id>
friday approve
friday approve --for-session
friday reject
friday reject --message "use another approach"
friday context
friday progress
friday reset
```

`friday doctor` performs read-only local checks for the Friday version, pinned
agent runtime, model credentials, writable data paths, and source TUI assets.
It does not call the model or consume tokens.

`friday feishu` serves the current directory to Feishu over a long connection so
a phone can drive this machine. It needs the `feishu` extra and an `open_id`
allowlist, and reads the credentials saved in Settings. The desktop switch and
`/phone` start the same bridge, so a terminal is only needed for a headless
machine. `friday feishu --console` exercises the bridge without Feishu, which is
the fastest way to tell a Friday problem from a Feishu one. See
[Phone Bridge](im-feishu.md).

Top-level `friday reset` requires confirmation and clears global Friday state.

Top-level `goal`, `compact`, `context`, `progress`, `resume`, `approve`, and
`reject` operate on persisted sessions. Use `--session <id>` when the latest
session is not the one you want.

TUI slash commands:

```text
/help
/new
/login
/model
/memory [help|status|list|search|add|update|remove|consolidate]
/context
/trace on|off
/phone [on|off]
/compact
/clear
/goal <task>
/resume
/permission
/fork
/backward
/exit
```

Typing `/` opens prefix-filtered command completion. `/login`, `/model`,
`/resume`, and `/permission` use searchable Up/Down pickers; Enter confirms and
Esc returns to the parent picker. `/model` selects the model first and then
offers only the thinking levels that model actually supports. `/resume` can
also delete a selected saved conversation. Press Esc twice while Friday is
working to stop the current response.

`/clear` deletes the current saved conversation and starts fresh. `/fork`
creates a branch from the latest Friday response, while `/backward` returns to
its parent. `/phone [on|off]` switches the Feishu bridge from the TUI only; the
plain CLI chat does not expose it. See [Phone Bridge](im-feishu.md).

Permission flags:

```powershell
friday --permission-mode manual
friday --permission-mode auto
friday --permission-mode bypass
friday --dangerously-skip-permissions
friday --permission-allow
friday --allowed-tools "Bash(git log *)"
friday --disallowed-tools "Bash(rm *)"
```

Modes:

- `manual`: default approval behavior.
- `auto`: let a separate, tool-free model review decide whether a risky command matches the current request. Hard-denied commands and explicit deny rules still win.
- `bypass`: skip interactive approval. Hard-denied commands and explicit deny rules still apply; use only in a sandbox.
