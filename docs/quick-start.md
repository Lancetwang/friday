# Quick Start

Initialize Friday files in a project:

```powershell
friday init
```

Start the terminal UI:

```powershell
friday
```

Ask once without opening chat:

```powershell
friday ask "summarize this project"
```

Run a goal loop:

```text
/goal fix the failing test and verify it passes
```

Resume recent work:

```powershell
friday resume
```

Show current context usage:

```text
/context
```

Compact the live conversation:

```text
/compact
```

Approve or reject a pending dangerous Bash command:

```text
/approve
/reject
```

Local project state is stored in `.friday/`. User state is stored in `~/.friday/`.

