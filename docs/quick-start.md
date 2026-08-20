# Quick Start

[中文](quick-start.zh-CN.md)

Complete one path in [Install](install.md) first.

## Desktop App

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

Project instructions are optional. Add an `AGENTS.md` to the project root when you want to record commands or rules. Runtime state stays under `~/.friday/projects/`; opening a project does not create a `.friday/` directory inside it.

## One-Shot And Evaluation Runs

Ask once without opening the TUI:

```powershell
friday ask "summarize this project"
```

Run a verified goal loop:

```powershell
friday goal "fix the failing test and verify it passes"
```

Evaluators and isolated sandboxes use the headless command. It can write an ATIF trajectory:

```powershell
friday run --trajectory C:\logs\trajectory.json -- "fix the failing tests"
```

The desktop app, CLI, and TUI share the same turn, context, memory, verification, approval, session, and trace implementation.

## Interactive Commands

Inside the TUI, use slash commands for session and runtime operations:

```text
/resume
/memory status
/context
/compact
/permission
/fork
/branches
```

Project state is stored under `~/.friday/projects/<workspace-id>/`. Global configuration, model credentials, user profile, memory, rules, and user skills live directly under `~/.friday/`.
