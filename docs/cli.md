# CLI Commands

Top-level commands:

```powershell
friday
friday init
friday help
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
friday compact
friday resume
friday resume --list
friday resume --session <id>
friday approve
friday approve --for-session
friday reject
friday reject --message "use another approach"
friday context
friday progress
friday reset
```

Top-level `friday reset` requires confirmation and clears global Friday state.
Interactive `/reset` clears only the current project's sessions, checkpoints,
tool artifacts, and traces.

Top-level `goal`, `compact`, `context`, `progress`, `resume`, `approve`, and
`reject` operate on persisted sessions, so they have the same behavior as their
chat/TUI counterparts. Use `--session <id>` when the latest session is not the
one you want.

Slash commands in chat/TUI:

```text
/help
/memory [help|status|list|search|add|update|remove|consolidate]
/context
/progress
/trace
/compact
/goal <task>
/resume
/undo [checkpoint-id]
/approve
/approve session
/reject
/reject use another approach
/reset
/exit
```

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
