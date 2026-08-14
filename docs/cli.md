# CLI Commands

The npm package exposes one cross-platform executable, `friday`.

```text
friday                         Start the TUI in the current directory
friday tui                     Start the TUI explicitly
friday ask <prompt>            Run one non-interactive turn
friday goal <prompt>           Run with independent goal verification
friday run <instruction>       Run in evaluation/sandbox mode
friday --help
friday --version
```

Common options:

```text
--cwd <path>                   Select the workspace
--permission-mode <mode>       manual, auto, or bypass
--stdin                        Read the prompt from standard input
--json                         Print the final result as JSON
--trajectory <path>            Write an ATIF-v1.7 trajectory
```

`ask` and `goal` retain the configured permission policy. `run` defaults to
bypass mode because it is designed for an evaluator-provided sandbox; hard
denials still apply. Override it with `--permission-mode auto` when desired.

Examples:

```powershell
friday ask --cwd E:\work\project "summarize this repository"
Get-Content task.txt | friday run --stdin --json
friday run --trajectory C:\logs\trajectory.json -- "fix the failing tests"
```

TUI slash commands:

```text
/help
/new
/login
/model
/search
/memory [help|status|list|search|add|update|remove|consolidate]
/plugins
/context
/trace on|off
/compact
/clear
/goal <task>
/resume
/permission
/fork
/branches
/backward
/exit
```

Typing `/` opens prefix completion. `/login`, `/model`, `/search`, `/resume`,
and `/permission` use searchable pickers. `/clear` deletes the current saved
conversation and starts fresh; `/fork` branches from the latest response;
`/backward` returns to its parent.

`/branches` opens the fork map: the conversation tree drawn with guide lines,
the current branch marked `◉`, each fork labeled with the message index it
split from. `↑`/`↓` move linearly, `←` jumps to the parent branch, `→` dives
into the first child, `Enter` opens the selected branch, `Ctrl+D` deletes it
together with its sub-branches after confirmation (the root cannot be deleted
here), and `Esc` closes the map. `/fork` and `/backward` open it automatically
so you always see where you landed.

Keyboard shortcuts while chatting: `Ctrl+O` toggles tool-call details,
`Ctrl+T` toggles thinking content, `Esc Esc` stops the running response, and
`Ctrl+C` clears the input or exits.
