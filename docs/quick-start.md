# Quick Start

[中文](quick-start.zh-CN.md)

Complete one path in [Install](install.md) first.

## Windows Desktop

1. Launch Friday and configure a provider under **Settings > Models**.
2. Start a personal conversation directly, or add a project with the **+** button beside Projects.
3. You can also drag a directory anywhere onto the Friday window to open it as a tracked project.
4. Create or select a conversation and enter a request.

For example:

```text
Summarize this project and tell me how to run its tests.
```

Projects and conversations are persistent and isolated. Closing a project removes it from the sidebar without deleting its files or stored sessions. Model profiles, web search, interface language, and user preferences are available under Settings.

## CLI And TUI

Open any project and start Friday:

```powershell
cd path\to\your-project
friday
```

The launch directory becomes the workspace. Use `/help` for interactive commands and `Ctrl+O` to expand or collapse tool details.

Project initialization is optional:

```powershell
friday init
```

It creates `AGENTS.md`, where project commands and rules can be recorded. Runtime state stays under `~/.friday/projects/`; opening a project does not create a `.friday/` directory inside it.

## One-Shot And Plain Chat

Ask once without opening the TUI:

```powershell
friday ask "summarize this project"
```

Use the plain terminal chat instead of the TUI:

```powershell
friday chat
```

The desktop app, CLI, and TUI share the same turn, context, memory, verification, approval, session, and trace implementation.

## Common CLI Workflows

Run a verified goal loop:

```powershell
friday goal "fix the failing test and verify it passes"
```

Resume or undo work:

```powershell
friday resume --list
friday resume --session <id>
friday undo
```

Inspect context, skills, or memory:

```powershell
friday context
friday compact
friday skill list --json
friday memory status
```

Approve or reject a pending dangerous command:

```powershell
friday approve
friday approve --for-session
friday reject
friday reject --message "use another approach"
```

Project state is stored under `~/.friday/projects/<workspace-id>/`. Global configuration, model credentials, user profile, memory, rules, and user skills live directly under `~/.friday/`.
