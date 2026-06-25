# Friday

[中文说明](README.zh-CN.md)

Friday is a personal CLI agent built on `agent-core-runtime`.

It is intentionally small: one user, one machine, local files, local memory, and OpenAI-compatible models through the core runtime.

## Shape

```mermaid
flowchart TD
    CLI["friday CLI"] --> Loader["load soul/user/AGENTS/memory"]
    Loader --> Agent["agent_core.Agent"]
    Agent --> Tools["tools"]
    Tools --> Read["read_file"]
    Tools --> Write["write_file"]
    Tools --> Edit["edit_file"]
    Tools --> Shell["run_shell"]
    Tools --> Memory["read_memory / remember"]
    Agent --> Session[".friday/sessions/*.jsonl"]
```

## Install

```powershell
uv sync
Copy-Item .env.example .env
```

Fill `.env`:

```text
LLM_API_KEY=...
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-v4-flash
```

## Use

```powershell
uv run friday init
uv run friday ask "summarize this project"
uv run friday chat
uv run friday memory
```

LLM output streams by default. Use `--no-stream` before the command:

```powershell
uv run friday --no-stream ask "hello"
```

## Files

- `src/friday/prompts/soul.md`: Friday's base personality and operating rules.
- `~/.friday/user.md`: your personal preferences.
- `~/.friday/MEMORY.md`: global memory.
- `AGENTS.md`: project instructions, compatible with Codex-style project guidance.
- `.friday/MEMORY.md`: project memory.
- `.friday/sessions/*.jsonl`: local chat logs.

## Validate

```powershell
uv run python -m unittest discover -s tests
uv run python -m compileall src tests
```
