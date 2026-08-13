# 安装

[English](install.md)

Friday 同时提供独立桌面安装包和通过 npm 安装的 TUI。普通用户优先使用桌面端。

## 桌面端（推荐）

从 [TypeScript 工作流](https://github.com/Lancetwang/friday/actions/workflows/typescript.yml)
下载当前平台的构建产物；迁移正式发布后也会进入 GitHub Releases：

- Windows x64：NSIS `.exe`
- macOS Apple Silicon：`.dmg`
- Linux x64：`.AppImage`

桌面应用自带独立 TypeScript Sidecar，不要求安装 Git、Python、Node.js、Bun 或
Rust。启动后在**设置 > 模型**中配置至少一个模型 API Key。

Windows 开发构建尚未代码签名；macOS 使用 ad-hoc 签名且尚未公证。如果首次启动
被 macOS 拦截，请到**系统设置 > 隐私与安全性 > 仍要打开**。

新版可以直接覆盖安装。会话、模型配置、记忆和设置保存在 `~/.friday/`；卸载应用
不会自动删除该目录。

## 通过 npm 安装 TUI

要求 Node.js 22 或更高版本。

```bash
npm install --global friday-agent
friday
```

npm 会生成对应平台的可执行 Shim，因此 PowerShell、cmd、bash 与 zsh 中都使用同一个
`friday` 命令。完整包已经包含 Core、Harness 与 TUI。

迁移分支评审期间 npm 包名尚未正式发布。请从 TypeScript 工作流下载并解压
`Friday-npm-packages` 构建产物，然后安装已经打好的完整包：

```bash
npm install --global ./friday-agent-0.2.0-alpha.0.tgz
friday --version
```

升级与卸载：

```bash
npm install --global friday-agent@latest
npm uninstall --global friday-agent
```

## 只安装 Agent Core

只需要嵌入模型/工具循环的 TypeScript 项目应安装公开 Core，不需要依赖 Friday 内部
Harness：

```bash
npm install friday-agent-core
```

正式发布前，同一个工作流构建产物中也包含 Core 包：

```bash
npm install ./friday-agent-core-0.2.0-alpha.0.tgz
```

## 从源码开发

源码开发要求 Git 与 Node.js 22 或更高版本：

```powershell
git clone https://github.com/Lancetwang/friday.git
cd friday
git switch codex/typescript-rewrite
npm ci
npm test
npm link
friday
```

`friday ask "Reply with OK"` 可以执行单次无交互任务；评测沙箱应使用
`friday run`，详见[评测文档](evaluation.md)。

桌面端源码开发还需要稳定版 Rust 工具链和对应平台编译工具。在仓库根目录运行：

```powershell
npm ci --prefix ui-desktop
npm run desktop:ts
```

构建当前平台的独立桌面安装包：

```powershell
npm run bundle:desktop:ts
```

模型配置和凭据可以在 TUI 或桌面 UI 中管理，保存在 `~/.friday/`。无界面运行也支持
显式传入 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`DEEPSEEK_API_KEY`、
`TAVILY_API_KEY` 与 `ANYSEARCH_API_KEY` 等进程环境变量。
