# Friday

[中文说明](README.zh-CN.md)

Friday is a local CLI coding agent. Run `friday` in any workspace to read and edit files, execute commands, search the web, retain project knowledge, and verify delivered changes.

It uses [agent-core-runtime](https://github.com/Lancetwang/agent-core-runtime) for generic agent execution. The Friday harness owns prompts, context compaction, memory, skills, permissions, verification and goal loops, sessions, traces, CLI, and TUI behavior.

## Install

```powershell
git clone https://github.com/Lancetwang/friday.git
cd friday
npm --prefix ui-tui ci
npm --prefix ui-tui run build
uv tool install -e . --force --reinstall
```

Put model settings in `~/.friday/.env`, then run `friday` from any project directory. See [Install](docs/install.md) for prerequisites, configuration, verification, upgrades, and uninstall steps.

## Features

- Workspace-aware startup: the directory where `friday` is launched becomes the active workspace.
- Harness-first context: stable runtime rules lead the prompt; user and project state are layered later for prefix caching.
- Agent-as-router: files, nested rules, skill bodies, and memory reads enter context only when needed.
- Layered rules: global `~/.friday/AGENTS.md` plus root and nested project `AGENTS.md` files.
- Progressive skills: the prompt keeps only skill locations; `Skill` lists structured metadata dynamically, then Bash reads only the selected `SKILL.md` and referenced resources.
- Layered memory: user profile, global memory, and project memory store durable facts; current task state remains in the resumable session.
- Multi-stage context compression: Friday probes structured tool-result compaction first, then falls back to structured conversation compact when the gain is insufficient.
- Independent verification: a verifier agent inspects the workspace without trusting the main agent's claims.
- Goal mode: `/goal <task>` repeats execution and verification until pass, concrete blockage, approval, or cancellation.
- Program-enforced permissions: dangerous Bash commands are stopped before execution and require explicit approval.
- Exact runtime accounting: provider usage is accumulated across main-agent and verifier calls, with marked estimates only when usage is unavailable.
- Local observability: each turn records a compact JSONL trace with prompt shape, model calls, tools, verification, timing, usage, and result.
- Session resume: one atomic snapshot per session restores the conversation under a freshly rebuilt prefix.
- Compatible runtime upgrades: Friday pins a tested agent-core source and checks the isolated tool environment before a turn starts.

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
    Memory["Memory management<br/>durable files + resumable session state"] --> AgentLoop
    Skills["Progressive skills<br/>locations -> metadata -> selected files"] --> AgentLoop
    Tools["Small tool set<br/>Read / Edit / Write / Bash / Glob / Grep / Web / Skill / Memory"] --> AgentLoop
```

## Harness

Friday assembles the model prefix in this order:

1. `SOUL.md`: identity and operating style.
2. Runtime instructions: tools, memory policy, project-rule discovery, skills, permissions, compact, and verification.
3. Tool guidance.
4. Global `~/.friday/AGENTS.md` rules.
5. `~/.friday/USER.md` profile.
6. Global `~/.friday/MEMORY.md`.
7. Skill locations and on-demand routing guidance.
8. Root and nested project instructions.
9. Live environment details.
10. Project `.friday/MEMORY.md`.

The code-owned prefix stays first and changes only on upgrade. User layers follow it, while workspace-specific state stays near the tail. This preserves the largest useful provider-cache prefix without letting live paths or project state go stale.

Friday provisions missing global defaults under `~/.friday/`. `friday init` is intentionally project-scoped and creates only `AGENTS.md`; memory, permissions, skills, sessions, and traces are created lazily.

## Memory

Friday separates facts, rules, and task state:

- `USER.md`: stable user profile and preferences.
- `~/.friday/MEMORY.md`: durable cross-project facts.
- `<workspace>/.friday/MEMORY.md`: durable project facts and decisions.
- `AGENTS.md`: operating rules, not memory.
- Live messages and session snapshots: current task state, not long-term memory.

The `Memory` tool can read, add, replace, or remove scoped entries. Before conversation compact, Friday asks the agent to save only durable facts, then emits a structured in-session summary for task continuity. Compact summaries and temporary progress never become long-term memory automatically.

## Context Management

- The default context window is 128K tokens and can be changed with `FRIDAY_CONTEXT_WINDOW`.
- At 85% usage, Friday probes oversized structured tool results.
- Tool results are compacted only when the probe predicts at least 25% context gain.
- Otherwise Friday performs one in-band structured compact pass, preserving the existing prefix.
- The compact schema keeps goals, completed work, open items, attempts, decisions, files, command results, verification state, next steps, and recent conversations.
- `/context` separates system prompt, skill routing, tool schemas, messages, and tool results, and shows latest-turn provider usage when available.

## Upgrade

Friday and agent-core are upgraded together through Friday's pinned dependency:

```powershell
cd path\to\friday
git pull --ff-only
npm --prefix ui-tui ci
npm --prefix ui-tui run build
uv tool install -e . --force --reinstall
```

Do not independently upgrade agent-core inside the tool environment. If a newer core is not pinned by Friday yet, it has not been compatibility-tested for this agent. Friday checks the installed direct dependency against its current pin at startup and gives the reinstall command before any turn runs.

## Docs

- [Install](docs/install.md)
- [Quick Start](docs/quick-start.md)
- [CLI Commands](docs/cli.md)
- [Tools](docs/tools.md)
- [Memory](docs/memory.md)
- [Skills](docs/skills.md)

## Validate

```powershell
uv run python -m unittest discover -s tests
uv run python -m compileall src tests
npm --prefix ui-tui run typecheck
```
