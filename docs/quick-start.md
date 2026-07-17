# Quick Start

Complete [Install](install.md) first. Then open any project and start Friday:

```powershell
cd path\to\your-project
friday
```

The directory where `friday` is launched becomes the workspace. Friday reads and writes only relative to that project unless an explicitly approved Bash command does otherwise.

## First Session

Inside the TUI:

```text
Summarize this project and tell me how to run its tests.
```

Use `/help` to see interactive commands. Press `Ctrl+O` to expand or collapse tool details.

Project initialization is optional:

```powershell
friday init
```

It creates `AGENTS.md`, where you can record project commands and rules. Friday creates `.friday/` state lazily when memory, sessions, permissions, or traces are needed.

## One-Shot And Plain Chat

Ask once without opening the TUI:

```powershell
friday ask "summarize this project"
```

Use the plain terminal chat instead of the TUI:

```powershell
friday chat
```

CLI and TUI use the same turn, context, memory, verification, approval, session, and trace implementation.

## Common Workflows

Run a verified goal loop:

```powershell
friday goal "fix the failing test and verify it passes"
```

Inside chat or the TUI, use `/goal fix the failing test and verify it passes`.

Resume a previous session:

```powershell
friday resume --list
friday resume --session <id>
```

Inside chat or the TUI, use `/resume` and select a session.

Inspect or compact context:

```powershell
friday context
friday compact
```

Inside chat or the TUI, use `/context` and `/compact`.

Inspect skills or memory progressively:

```powershell
friday help
friday skill help
friday skill list --json
friday memory help
friday memory status
```

Inside chat or the TUI, use `/memory help`, `/memory list`, and `/memory search <query>`. Use `/prompt` to print the effective prompt.

Approve or reject a pending dangerous Bash command:

```powershell
friday approve
friday reject
```

Inside chat or the TUI, use `/approve` and `/reject`.

Project state is stored in `<workspace>/.friday/`. Global configuration, user profile, memory, rules, and user skills are stored in `~/.friday/`.
