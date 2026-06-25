# Friday

[English README](README.md)

Friday 是一个基于 `agent-core-runtime` 的个人 CLI agent。

它不做多人系统，也不做平台化抽象：一个用户、一台机器、本地文件、本地记忆，通过 core runtime 调 OpenAI-compatible 模型。

## 结构

```mermaid
flowchart TD
    CLI["friday CLI"] --> Loader["加载 soul/user/AGENTS/memory"]
    Loader --> Agent["agent_core.Agent"]
    Agent --> Tools["工具"]
    Tools --> Read["read_file"]
    Tools --> Write["write_file"]
    Tools --> Edit["edit_file"]
    Tools --> Shell["run_shell"]
    Tools --> Memory["read_memory / remember"]
    Agent --> Session[".friday/sessions/*.jsonl"]
```

## 安装

```powershell
uv sync
Copy-Item .env.example .env
```

填写 `.env`：

```text
LLM_API_KEY=...
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-v4-flash
```

## 使用

```powershell
uv run friday init
uv run friday ask "summarize this project"
uv run friday chat
uv run friday memory
```

LLM 默认流式输出。关闭流式：

```powershell
uv run friday --no-stream ask "hello"
```

## 文件

- `src/friday/prompts/soul.md`：Friday 的基础人格和运行规则。
- `~/.friday/user.md`：你的个人偏好。
- `~/.friday/MEMORY.md`：全局记忆。
- `AGENTS.md`：项目指令，兼容 Codex 风格的项目指导。
- `.friday/MEMORY.md`：项目记忆。
- `.friday/sessions/*.jsonl`：本地聊天日志。

## 验证

```powershell
uv run python -m unittest discover -s tests
uv run python -m compileall src tests
```
