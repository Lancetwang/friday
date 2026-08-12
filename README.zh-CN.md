# Friday

<p align="center">
  <img src=".github/friday-social-preview.png" alt="Friday - 本地通用 Agent" width="100%">
</p>

<p align="center">
  <a href="https://github.com/Lancetwang/friday/releases"><img src="https://img.shields.io/github/v/release/Lancetwang/friday?sort=semver&style=flat-square&label=release" alt="GitHub Release"></a>
  <a href="https://www.python.org/downloads/"><img src="https://img.shields.io/badge/Python-3.12%2B-3776AB?style=flat-square&logo=python&logoColor=white" alt="Python 3.12+"></a>
  <a href="https://docs.astral.sh/uv/"><img src="https://img.shields.io/badge/package%20manager-uv-DE5FE9?style=flat-square&logo=uv&logoColor=white" alt="uv"></a>
  <a href="https://github.com/Lancetwang/friday/releases"><img src="https://img.shields.io/badge/platform-Windows%20x64-0078D4?style=flat-square&logo=windows11&logoColor=white" alt="Windows x64"></a>
  <a href="https://github.com/Lancetwang/friday/releases"><img src="https://img.shields.io/badge/platform-macOS%20ARM%20%7C%20Intel-000000?style=flat-square&logo=apple&logoColor=white" alt="macOS Apple Silicon 与 Intel"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-22A699?style=flat-square" alt="MIT License"></a>
</p>

<p align="center"><a href="README.md">English</a></p>

Friday 是一个本地通用 Agent，提供 Windows 与 macOS 桌面端，并为 Windows、macOS 和 Linux 提供 TUI 与 CLI。它可以处理文件和命令、联网检索、记住用户与项目上下文，并持续执行任务直到完成或明确受阻。

底层的 [agent-core-runtime](https://github.com/Lancetwang/agent-core-runtime) 负责通用 Agent 执行。Friday Harness 负责提示词、上下文压缩、记忆、Skill、权限、验证与 Goal Loop、会话、Trace，以及桌面端、CLI 和 TUI。两者之间的边界契约见[架构文档](docs/architecture.md)。

## 安装

### 桌面端（推荐）

打开 [GitHub Releases](https://github.com/Lancetwang/friday/releases)，按设备下载 Windows x64 安装程序、macOS Apple Silicon DMG 或 macOS Intel DMG。安装包已包含 Friday 和 Python Runtime，不要求用户额外安装 Git、Python、Node.js 或 Rust。

启动 Friday 后，在**设置 > 模型**中配置至少一个模型供应商的 API Key。联网搜索 Key 和用户偏好也可以在设置中完成。

### 从源码安装

```powershell
git clone https://github.com/Lancetwang/friday.git
cd friday
npm --prefix ui-tui ci
npm --prefix ui-tui run build
uv tool install -e . --force --reinstall
```

源码安装会提供全局 `friday` CLI 与 TUI。源码目录需要保留，所有 Python 依赖，包括 [`friday-agent-core`](https://pypi.org/project/friday-agent-core/)，都会自动从 PyPI 解析。

也可以不安装、直接在源码目录启动：macOS/Linux 用 `./friday`，Windows 用 `friday.cmd`，会把启动时所在目录作为工作区并启动 TUI，使用源码目录自带的 uv 环境。若 `uv tool install` 之后全局 `friday` 命令找不到，运行 `uv tool update-shell` 并重开终端。

两种安装方式的环境要求、配置、升级与卸载步骤见[中文安装文档](docs/install.zh-CN.md)。

## 特性

- 通用任务执行：处理本地文件与命令、联网检索，并让普通任务持续推进到交付与验证。
- 两层 Loop：Agent Loop 负责模型与工具交互；独立的 Verify / Goal Loop 检查交付物并依据证据驱动修正。
- Prefix 友好的上下文：稳定 Runtime 规则位于前部，用户、项目、Skill 和召回记忆按需渐进披露。
- 多级上下文压缩：先探测无损工具结果简化，必要时再进行结构化对话压缩并保留最近十个完整 Turn。
- 分层记忆与进度：稳定用户事实、项目知识、情景召回和可恢复任务进度彼此独立。
- 渐进式 Skill：先返回元数据和路径，只读取被选中的 `SKILL.md` 及其引用资源。
- 长程任务控制：显式目标、计划、下一步、验证状态、语义停止条件和 Session 恢复共同防止任务迷失。
- Turn 级检查点：`/undo` 同时恢复最近一次 Friday 执行前的工作区文件、对话和任务进度，不改动项目自身的 Git 历史。
- 程序级权限：危险 Bash 命令在执行前停止并请求明确批准。
- 有预算的联网检索：只为缺失证据继续搜索，并区分检索事实与模型推断。
- 精确统计与 Trace：记录 Provider Usage、模型调用、工具过程、压缩、验证和结果，支持检查与分析。
- Runtime 兼容性：固定经过验证的 [`friday-agent-core`](https://pypi.org/project/friday-agent-core/) 版本，并在执行前检查安装环境。

## 架构

```mermaid
flowchart TD
    User["用户"] --> Surface["Friday Desktop / CLI / TUI"]
    Surface --> Harness["Friday Harness"]

    Harness --> AgentLoop["Agent Loop<br/>模型 -> 工具 -> 模型 -> 回答"]
    AgentLoop --> OuterLoop["Verify / Goal Loop<br/>检查交付物 -> 反馈 -> 重试"]
    OuterLoop --> AgentLoop

    Prefix["Prefix Caching<br/>稳定规则位于动态状态之前"] --> AgentLoop
    Context["Context Engineering<br/>预算 -> 工具压缩 -> 对话压缩"] --> AgentLoop
    Memory["Memory Management<br/>常驻事实 + 情景召回 + 任务进度"] --> AgentLoop
    Skills["Progressive Skills<br/>CLI 索引 -> 选中资源"] --> AgentLoop
    Tools["最小工具集<br/>Read / Edit / Write / Bash / Glob / Grep / Web / Plan"] --> AgentLoop
```

## 文档

- [文档索引](docs/index.md) — 全部指南
- [安装](docs/install.zh-CN.md) ([English](docs/install.md))
- [更新日志](CHANGELOG.md)
- [快速开始](docs/quick-start.zh-CN.md) ([English](docs/quick-start.md))
- [架构](docs/architecture.md)
- [模型配置](docs/model-configuration.md)
- [CLI 命令](docs/cli.md)
- [工具](docs/tools.md)
- [记忆](docs/memory.md)
- [Skills](docs/skills.md)
- [验证](docs/verification.md)
- [手机接入（飞书）](docs/im-feishu.md)
- [可观测性](docs/observability.md)
- [检查点与撤回](docs/checkpoints.md)

## 验证

```powershell
uv run python -m unittest discover -s tests
uv run python -m compileall src tests
npm --prefix ui-tui run typecheck
```

## 开源协议

Friday 使用 [MIT License](LICENSE) 发布。
