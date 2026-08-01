# 安装

[English](install.md)

Friday 支持两种安装方式：普通用户推荐安装 Windows 桌面端；从源码安装则提供全局 `friday` CLI 与 TUI。

## Windows 桌面端（推荐）

### 环境要求

- 64 位 Windows 10 或 Windows 11
- 至少一个模型供应商的 API Key

安装包已包含桌面客户端与 Python Sidecar，不要求用户额外安装 Git、Python、Node.js、Rust 或 `friday-agent-core`。

### 安装步骤

1. 打开 [GitHub Releases](https://github.com/Lancetwang/friday/releases)。
2. 进入最新版本，下载 Windows x64 安装程序（当前为 `Friday_0.1.0_x64-setup.exe`）。
3. 运行安装程序，然后从开始菜单或桌面快捷方式启动 Friday。
4. 打开**设置 > 模型**，展开一个供应商，填写 API Key，然后选择**保存并使用**。

Release 说明中会公布安装包的 SHA-256。Beta 版本尚未签名，如果 Windows SmartScreen 弹出提示，请先核对哈希再决定是否继续。

联网搜索是可选能力，可以在**设置 > 联网搜索**中配置 Tavily 或 AnySearch。称呼和 Friday 的回复语言位于**设置 > 通用**，与桌面界面的展示语言彼此独立。

### 升级

从 GitHub Releases 下载新版安装包并直接运行即可覆盖升级。项目、会话、模型配置、记忆与设置都保存在 `~/.friday/`，不会因升级丢失。

### 卸载

在 **Windows 设置 > 应用 > 已安装的应用**中卸载 Friday。卸载程序不会删除 `~/.friday/`；只有确认不再需要会话、记忆和配置时，才手动删除该目录。

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

桌面端开发还需要稳定版 Rust 工具链和 Microsoft C++ Build Tools。在仓库根目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File ui-desktop\scripts\start-dev.ps1
```

增量启动脚本会按需安装桌面端 npm 依赖、构建缺失的原生组件、启动 Vite 并打开调试应用。

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
