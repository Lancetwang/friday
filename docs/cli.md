# CLI Commands

Top-level commands:

```powershell
friday
friday init
friday help
friday prompt
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

Top-level `goal`, `compact`, `context`, `progress`, `resume`, `approve`, and
`reject` operate on persisted sessions, so they have the same behavior as their
chat/TUI counterparts. Use `--session <id>` when the latest session is not the
one you want.

Slash commands in chat/TUI:

```text
/help
/prompt
/memory [help|status|list|search|add|update|remove|consolidate]
/context
/progress
/compact
/goal <task>
/resume
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
friday --permission-mode accept-edits
friday --permission-mode dont-ask
friday --permission-mode bypass
friday --dangerously-skip-permissions
friday --permission-allow
friday --allowed-tools "Bash(git log *)"
friday --disallowed-tools "Bash(rm *)"
```

Modes:

- `manual`: default approval behavior.
- `accept-edits`: allow common write/edit shell commands, still ask for destructive commands.
- `dont-ask`: deny commands that would require approval.
- `bypass`: skip approval checks. Use only in a sandbox.
