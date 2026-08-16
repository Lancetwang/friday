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
/memory [add|update|status|search|consolidate ...]
/plugins
/context
/trace [on|off]
/compact
/clear
/goal <task>
/resume
/permission
/fork
/branches
/exit
```

Typing `/` opens prefix completion. Every slash command operates something
directly: `/login`, `/model`, `/search`, `/resume`, and `/permission` use
searchable pickers; `/clear` deletes the current saved conversation and
starts fresh; `/fork` branches from the latest response; `/trace` toggles
the Trace Workbench (or force it with `on`/`off`).

`/memory` opens the memory browser: every stored entry with its scope,
searchable by content. `Enter` shows the full entry, `Ctrl+D` forgets it
after confirmation. With arguments it stays a command - `/memory add user
prefers pnpm`, `/memory status`, `/memory consolidate`.

`/plugins` lists every plugin - the built-in capabilities (workspace, web,
memory, skills) and external ones - with its on/off state, tools, and
description. `Enter` switches the selected plugin on or off; the change
persists in `disabled_plugins` and takes effect immediately. The required
`workspace` pack stays on.

`/branches` opens the fork map: the conversation tree drawn with guide lines,
the current branch marked `◉`, each fork labeled with the message index it
split from. `↑`/`↓` move linearly, `←` jumps to the parent branch, `→` dives
into the first child, `Enter` opens the selected branch, `Ctrl+D` deletes it
together with its sub-branches after confirmation (the root cannot be deleted
here), and `Esc` closes the map. `/fork` opens it automatically so you always
see where you landed; moving anywhere in the tree, including back to the
parent, is arrow keys + `Enter`.

While Friday is working, typing stays live: `Enter` steers the running turn
(the message is delivered before the model's next step), and `/queue <text>`
holds a message to run automatically after the turn finishes. `Esc Esc`
interrupts; the partial turn - completed tool calls included - is kept, not
rolled back.

Keyboard shortcuts while chatting: `Ctrl+O` toggles tool-call details,
`Ctrl+T` toggles thinking content, `Esc Esc` stops the running response, and
`Ctrl+C` clears the input or exits.
