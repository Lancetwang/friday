# CLI Commands

Top-level commands:

```powershell
friday
friday init
friday ask "..."
friday chat
friday tui
friday resume
friday approve
friday reject
friday memory
friday context
friday reset
```

Slash commands in chat/TUI:

```text
/help
/memory
/context
/compact
/goal <task>
/resume
/approve
/reject
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

