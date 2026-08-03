# 安装

[English](install.md)

Friday 支持两种安装方式：普通用户推荐安装 Windows 或 macOS 桌面端；从源码安装则在 Windows、macOS 和 Linux 上提供全局 `friday` CLI 与 TUI。

## 桌面端（推荐）

### 环境要求

- 64 位 Windows 10/11，或 macOS 11 及以上版本
- 至少一个模型供应商的 API Key

安装包已包含桌面客户端与 Python Sidecar，不要求用户额外安装 Git、Python、Node.js、Rust 或 `friday-agent-core`。

### 安装步骤

1. 打开 [GitHub Releases](https://github.com/Lancetwang/friday/releases)。
2. Windows 下载 `Friday_0.1.0_x64-setup.exe`；Apple Silicon Mac 下载 `Friday_0.1.0_arm64.dmg`；Intel Mac 下载 `Friday_0.1.0_x64.dmg`。
3. Windows 运行安装程序；macOS 打开 DMG，将 Friday 拖入“应用程序”。
4. 打开**设置 > 模型**，展开一个供应商，填写 API Key，然后选择**保存并使用**。

Release 资源会公布 SHA-256。Windows 安装包尚未进行代码签名；macOS 版本使用 ad-hoc 签名，尚未公证。请先核对哈希。如果 macOS 阻止首次启动，请打开**系统设置 > 隐私与安全性**并选择**仍要打开**。

联网搜索是可选能力，可以在**设置 > 联网搜索**中配置 Tavily 或 AnySearch。称呼和 Friday 的回复语言位于**设置 > 通用**，与桌面界面的展示语言彼此独立。

### 升级

从 GitHub Releases 下载新版安装包并直接运行即可覆盖升级。项目、会话、模型配置、记忆与设置都保存在 `~/.friday/`，不会因升级丢失。

### 卸载

Windows 可在**设置 > 应用 > 已安装的应用**中卸载 Friday；macOS 可从“应用程序”中移除 `Friday.app`。卸载不会删除 `~/.friday/`；只有确认不再需要会话、记忆和配置时，才手动删除该目录。

## 从源码安装

### 环境要求

- Git
- Python 3.12 或更高版本
- [uv](https://docs.astral.sh/uv/)
- Node.js 20 或更高版本及 npm

安装前可以先检查：

```powershell
git --version
uv --version
python --version
node --version
npm --version
```

### 安装 CLI 与 TUI

```powershell
git clone https://github.com/Lancetwang/friday.git
cd friday
npm --prefix ui-tui ci
npm --prefix ui-tui run build
uv tool install -e . --force --reinstall
```

`uv tool install` 会创建隔离的 Python 环境，并安装当前 Friday 固定且验证过的 `friday-agent-core` 版本。可编辑安装会让全局 `friday` 命令继续引用该源码目录，因此不要在安装后删除仓库。

如果终端找不到 `friday`，运行 `uv tool update-shell`，重新打开终端后再执行 `friday --help`。

### 配置源码安装

创建一份全局配置，让 Friday 可以在任意工作目录使用：

```powershell
New-Item -ItemType Directory -Force "$HOME\.friday" | Out-Null
Copy-Item .env.example "$HOME\.friday\.env"
Copy-Item config.example.json "$HOME\.friday\config.json"
notepad "$HOME\.friday\.env"
notepad "$HOME\.friday\config.json"
```

macOS 或 Linux：

```bash
mkdir -p "$HOME/.friday"
cp .env.example "$HOME/.friday/.env"
cp config.example.json "$HOME/.friday/config.json"
${EDITOR:-vi} "$HOME/.friday/.env"
${EDITOR:-vi} "$HOME/.friday/config.json"
```

密钥写入 `.env`：

```text
LLM_API_KEY=your-key
TAVILY_API_KEY=optional-web-search-key
ANYSEARCH_API_KEY=optional-web-search-fallback-key
JINA_API_KEY=optional-web-fetch-key
```

供应商配置、Token 限制、配置优先级和桌面端密钥存储方式见[模型配置](model-configuration.md)。

### 验证源码安装

在 Friday 仓库之外的目录运行：

```powershell
friday --help
friday doctor
friday ask "Reply with OK and do not use tools"
friday
```

`friday doctor` 会在不调用模型的情况下检查本地 Runtime、模型凭据、目录写入权限和 TUI 资源；下一个命令验证模型连接，最后一个命令以当前目录为工作区启动 TUI。

### 从源码运行桌面端

桌面端开发还需要稳定版 Rust 工具链。Windows 需要 Microsoft C++ Build Tools，macOS 需要 Xcode Command Line Tools。在仓库根目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File ui-desktop\scripts\start-dev.ps1
```

增量启动脚本会按需安装桌面端 npm 依赖、构建缺失的原生组件、启动 Vite 并打开调试应用。

macOS 下运行：

```bash
npm --prefix ui-desktop ci
npm --prefix ui-desktop run desktop
```

### 升级源码安装

Friday 会固定一个兼容性经过验证的 `friday-agent-core` 版本。请一起更新 Friday 与对应 Runtime：

```powershell
cd path\to\friday
git pull --ff-only
npm --prefix ui-tui ci
npm --prefix ui-tui run build
uv tool install -e . --force --reinstall
```

启动时 Friday 会检查 Runtime 版本；如果源码与工具环境不一致，会直接给出重新安装命令。

### 卸载源码安装

```powershell
uv tool uninstall friday-agent
```

之后可以删除源码目录。`~/.friday/` 中的用户数据仍会保留，除非手动删除。
