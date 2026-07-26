# Friday

[中文说明](README.zh-CN.md)

Friday is a local general-purpose CLI agent. Run `friday` from any directory to work with files, execute commands, search the web, retain useful context, and carry tasks through verification.

It uses [agent-core-runtime](https://github.com/Lancetwang/agent-core-runtime) for generic agent execution. The Friday harness owns prompts, context compaction, memory, skills, permissions, verification and goal loops, sessions, traces, CLI, and TUI behavior.

## Install

```powershell
git clone https://github.com/Lancetwang/friday.git
cd friday
npm --prefix ui-tui ci
npm --prefix ui-tui run build
uv tool install -e . --force --reinstall
```

Put the API key in `~/.friday/.env` and model settings in `~/.friday/config.json`, then run `friday` from any project directory. See [Install](docs/install.md) for prerequisites, configuration, verification, upgrades, and uninstall steps.

## Features

- General-purpose execution: work with local files and commands, search the web, and continue ordinary tasks through delivery and validation.
- Two-layer loop: the agent loop handles model-tool interaction; the independent Verify / Goal loop checks deliverables and drives evidence-based repair.
- Prefix-aware context: stable runtime rules lead the prompt, while user, project, Skill, and recalled memory layers are disclosed only when needed.
- Multi-stage compaction: lossless tool-result simplification is probed first; structured conversation compaction preserves the latest ten complete turns when required.
- Layered memory and progress: stable user facts, project knowledge, episodic recall, and resumable task progress remain separate.
- Progressive Skills: Friday lists metadata and paths first, then reads only the selected `SKILL.md` and referenced resources.
- Long-running task control: explicit objectives, plans, next actions, verifier state, semantic stop conditions, and session resume keep work on track.
- Turn checkpoints: `/undo` restores workspace files, conversation, and progress to the state before the latest Friday turn without touching the project's Git history.
- Program-enforced permissions: dangerous Bash commands stop before execution and require explicit approval.
- Bounded web research: search continues only for missing evidence, with retrieved sources separated from model inference.
- Exact accounting and traces: provider usage, model calls, tool activity, compaction, verification, and results are recorded for inspection and analysis.
- Runtime compatibility: Friday pins a tested `agent-core-runtime` revision and checks the installed environment before execution.

## Architecture

```mermaid
flowchart TD
    User["User"] --> Surface["Friday CLI / TUI"]
    Surface --> Harness["Friday harness"]

    Harness --> AgentLoop["Agent loop<br/>model -> tools -> model -> answer"]
    AgentLoop --> OuterLoop["Verify / goal loop<br/>inspect deliverable -> feedback -> retry"]
    OuterLoop --> AgentLoop

    Prefix["Prefix caching<br/>stable rules before volatile state"] --> AgentLoop
    Context["Context engineering<br/>budget -> tool compact -> conversation compact"] --> AgentLoop
    Memory["Memory management<br/>hot facts + recalled episodes + task progress"] --> AgentLoop
    Skills["Progressive skills<br/>CLI catalog -> selected files"] --> AgentLoop
    Tools["Small tool set<br/>Read / Edit / Write / Bash / Glob / Grep / Web / Plan"] --> AgentLoop
```

## Docs

- [Install](docs/install.md)
- [Quick Start](docs/quick-start.md)
- [Model Configuration](docs/model-configuration.md)
- [CLI Commands](docs/cli.md)
- [Tools](docs/tools.md)
- [Memory](docs/memory.md)
- [Skills](docs/skills.md)
- [Observability](docs/observability.md)
- [Checkpoints](docs/checkpoints.md)

## Validate

```powershell
uv run python -m unittest discover -s tests
uv run python -m compileall src tests
npm --prefix ui-tui run typecheck
```
