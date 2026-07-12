# Friday

[English](README.md)

Friday 是一个本地 CLI 编程 Agent。在任意项目目录运行 `friday`，即可让它读取和修改文件、执行命令、联网检索、维护项目知识，并验证最终交付结果。

底层的 [agent-core-runtime](https://github.com/Lancetwang/agent-core-runtime) 负责通用 Agent 执行。Friday Harness 负责提示词、上下文压缩、记忆、Skill、权限、验证与 Goal Loop、会话、Trace、CLI 和 TUI。

## 安装

```powershell
git clone https://github.com/Lancetwang/friday.git
cd friday
npm --prefix ui-tui ci
npm --prefix ui-tui run build
uv tool install -e . --force --reinstall
```

将 API Key 写入 `~/.friday/.env`，将模型配置写入 `~/.friday/config.json`，之后即可在任意项目目录运行 `friday`。完整的环境要求、配置、验证、升级与卸载步骤见 [安装文档](docs/install.md)。

## 特性

- 工作区感知：从哪个目录启动 `friday`，哪个目录就是当前工作区。
- 分层模型配置：供应商、模型和 Token 预算写入全局 JSON，并可由项目覆盖；密钥继续留在 `.env`。
- Harness 优先的上下文设计：稳定规则放在前面，用户与项目状态放在后面，适配 Prefix Caching。
- Agent 只负责路由：文件、嵌套规则、Skill 正文和记忆读取都按需进入上下文。
- 分层规则：全局 `~/.friday/AGENTS.md`，以及项目根目录和嵌套目录中的 `AGENTS.md`。
- 渐进式 Skill：启动提示词只保存 Skill 目录；`Skill` 动态返回结构化元数据，Bash 只读取被选中的 `SKILL.md` 和引用资源。
- 分层记忆：用户画像、全局记忆和项目记忆保存长期事实，当前任务状态留在可恢复的 Session 中。
- 多级上下文压缩：先探测工具结果压缩收益，收益不足时再执行结构化对话压缩。
- 独立验证：Verifier 不相信主 Agent 的描述，而是自己检查工作区交付物。
- 自适应验证：简单交付物只做最小充分的独立检查，只有具体可执行的 Repair 才能继续循环。
- Goal 模式：`/goal <任务>` 在通过、阻塞、证据不足、重复无进展、等待审批或 Token Budget 耗尽时停止。
- 程序级权限：危险 Bash 命令在执行前被拦截，需要用户明确批准。
- 运行级 Token 统计：汇总主 Agent 和 Verifier 的模型调用；Provider 不返回 Usage 时才标记为估算。
- 本地可观测性：模型与工具事件增量落盘，超时后仍可诊断；完整轮次另写精简 JSONL 摘要，记录 Prompt 结构、验证、耗时、Usage 和结果。
- Session 恢复：每个会话保存一个原子快照，在最新 Prefix 下恢复完整对话正文。
- 兼容的 Runtime 升级：Friday 固定经过验证的 agent-core 源，并在每轮开始前检查隔离环境是否匹配。

## 架构

```mermaid
flowchart TD
    User["用户"] --> Surface["Friday CLI / TUI"]
    Surface --> Harness["Friday Harness"]

    Harness --> AgentLoop["Agent Loop<br/>模型 -> 工具 -> 模型 -> 回答"]
    AgentLoop --> OuterLoop["Verify / Goal Loop<br/>检查交付物 -> 反馈 -> 重试"]
    OuterLoop --> AgentLoop

    Prefix["Prefix Caching<br/>稳定规则位于动态状态之前"] --> AgentLoop
    Context["Context Engineering<br/>预算 -> 工具压缩 -> 对话压缩"] --> AgentLoop
    Memory["Memory Management<br/>长期文件 + 可恢复会话状态"] --> AgentLoop
    Skills["Progressive Skills<br/>目录 -> 元数据 -> 选中资源"] --> AgentLoop
    Tools["最小工具集<br/>Read / Edit / Write / Bash / Glob / Grep / Web / Skill / Memory"] --> AgentLoop
```

## Harness

Friday 按以下顺序组装模型 Prefix：

1. `SOUL.md`：身份和工作风格。
2. Runtime 指令：工具、记忆策略、项目规则发现、Skill、权限、压缩和验证。
3. 工具使用指导。
4. 全局 `~/.friday/AGENTS.md`。
5. `~/.friday/USER.md` 用户画像。
6. 全局 `~/.friday/MEMORY.md`。
7. Skill 目录和按需路由规则。
8. 项目根目录与嵌套项目规则。
9. 实时环境信息。
10. 项目 `.friday/MEMORY.md`。

代码控制的稳定 Prefix 位于最前面，只在升级时变化。用户信息位于中间，工作区相关状态位于尾部。这样可以尽量复用 Provider Cache，同时保证路径和项目状态不会过期。

Friday 首次启动会补齐 `~/.friday/` 下缺少的默认文件。`friday init` 只负责创建项目 `AGENTS.md`，记忆、权限、Skill、Session 和 Trace 都按需创建。

## 记忆

Friday 将事实、规则与任务状态分开：

- `USER.md`：稳定的用户画像与偏好。
- `~/.friday/MEMORY.md`：跨项目长期事实。
- `<workspace>/.friday/MEMORY.md`：项目长期事实和决策。
- `AGENTS.md`：行为规则，不属于记忆。
- 实时消息与 Session：当前任务状态，不属于长期记忆。

`Memory` 工具支持按作用域读取、添加、替换和删除。在对话压缩前，Friday 会先要求 Agent 保存真正值得长期保留的事实，再生成结构化的会话摘要。压缩摘要和临时任务进度不会自动污染长期记忆。

## 上下文管理

- 默认上下文窗口为 353K，单次输出预算默认为 64K；两者均可通过全局或项目配置覆盖。
- 上下文达到 85% 时，先探测超大工具结果的压缩收益。
- 只有预计能释放至少 25% 上下文时，才执行工具结果压缩。
- 否则执行一次带当前 Prefix 的结构化对话压缩。
- 摘要保留目标、已完成内容、未完成项、尝试方法、决策、文件、命令结果、验证状态、下一步和最近对话。
- `/context` 分别显示 System Prompt、Skill 路由、工具 Schema、消息和工具结果，并展示最近一轮 Provider Usage。

## 升级

Friday 通过固定依赖，让 Agent 和 agent-core 一起升级：

```powershell
cd path\to\friday
git pull --ff-only
npm --prefix ui-tui ci
npm --prefix ui-tui run build
uv tool install -e . --force --reinstall
```

不要在 Friday 的隔离工具环境里单独升级 agent-core。如果新版 core 尚未被 Friday 固定，说明两者还没有完成兼容性验证。Friday 启动时会检查实际安装来源是否等于当前 Pin，并在执行任何一轮任务前给出重装命令。

## 文档

- [安装](docs/install.md)
- [快速开始](docs/quick-start.md)
- [模型配置](docs/model-configuration.md)
- [CLI 命令](docs/cli.md)
- [工具](docs/tools.md)
- [记忆](docs/memory.md)
- [Skills](docs/skills.md)

## 验证

```powershell
uv run python -m unittest discover -s tests
uv run python -m compileall src tests
npm --prefix ui-tui run typecheck
```
