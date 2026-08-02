# Install

[中文](install.zh-CN.md)

Friday can be installed as a packaged Windows app or from source. The Windows app is the shortest path for normal use; the source installation provides the global `friday` CLI and TUI.

## Windows App (Recommended)

### Requirements

- 64-bit Windows 10 or Windows 11
- A model provider API key

Git, Python, Node.js, Rust, and a separate `friday-agent-core` installation are not required. The installer contains the desktop client and its Python sidecar.

### Install

1. Open [GitHub Releases](https://github.com/Lancetwang/friday/releases).
2. Open the newest release and download its Windows x64 setup executable (currently `Friday_0.1.0_x64-setup.exe`).
3. Run the installer, then launch Friday from the Start menu or desktop shortcut.
4. Open **Settings > Models**, expand a provider, enter its API key, and select **Save and use**.

The release notes publish the installer's SHA-256 digest. If Windows SmartScreen appears for an unsigned beta, verify that digest before choosing to continue.

Web search is optional. Configure Tavily or AnySearch under **Settings > Web Search**. Your preferred name and Friday response language live under **Settings > General**; the desktop display language is a separate setting.

### Upgrade

Download the newer installer from GitHub Releases and run it over the existing installation. Sessions, projects, model profiles, memory, and settings remain under `~/.friday/`.

### Uninstall

Remove Friday from **Windows Settings > Apps > Installed apps**. Uninstalling the application does not delete `~/.friday/`; remove that directory separately only when its sessions, memory, and configuration are no longer needed.

## Install From Source

### Requirements

- Git
- Python 3.12 or newer
- [uv](https://docs.astral.sh/uv/)
- Node.js 20 or newer with npm

Verify them before installing:

```powershell
git --version
uv --version
python --version
node --version
npm --version
```

### Clone And Install The CLI/TUI

```powershell
git clone https://github.com/Lancetwang/friday.git
cd friday
npm --prefix ui-tui ci
npm --prefix ui-tui run build
uv tool install -e . --force --reinstall
```

`uv tool install` creates an isolated Python environment and installs the exact `friday-agent-core` version pinned by the checkout. The editable install keeps the global `friday` command connected to the cloned Python and TUI source, so the checkout must remain on disk.

If `friday` is not found, run `uv tool update-shell`, reopen the terminal, and try `friday --help`.

### Configure The Source Installation

Create one global configuration so Friday works from every workspace:

```powershell
New-Item -ItemType Directory -Force "$HOME\.friday" | Out-Null
Copy-Item .env.example "$HOME\.friday\.env"
Copy-Item config.example.json "$HOME\.friday\config.json"
notepad "$HOME\.friday\.env"
notepad "$HOME\.friday\config.json"
```

On macOS or Linux:

```bash
mkdir -p "$HOME/.friday"
cp .env.example "$HOME/.friday/.env"
cp config.example.json "$HOME/.friday/config.json"
${EDITOR:-vi} "$HOME/.friday/.env"
${EDITOR:-vi} "$HOME/.friday/config.json"
```

Store secrets in `.env`:

```text
LLM_API_KEY=your-key
TAVILY_API_KEY=optional-web-search-key
ANYSEARCH_API_KEY=optional-web-search-fallback-key
JINA_API_KEY=optional-web-fetch-key
```

See [Model Configuration](model-configuration.md) for provider profiles, token limits, configuration precedence, and desktop-managed credentials.

### Verify The Source Installation

Run these from a directory other than the Friday checkout:

```powershell
friday --help
friday doctor
friday ask "Reply with OK and do not use tools"
friday
```

`friday doctor` checks the local runtime, model credentials, writable paths, and TUI assets without calling the model. The next command verifies the model connection, and the final command starts the TUI with the current directory as its workspace.

### Run The Desktop App From Source

Desktop development additionally requires the stable Rust toolchain and Microsoft C++ Build Tools. From the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File ui-desktop\scripts\start-dev.ps1
```

The incremental launcher installs desktop npm dependencies when needed, builds missing native pieces, starts Vite, and opens the debug application.

### Upgrade The Source Installation

Friday pins a tested `friday-agent-core` version. Update Friday and its compatible runtime together:

```powershell
cd path\to\friday
git pull --ff-only
npm --prefix ui-tui ci
npm --prefix ui-tui run build
uv tool install -e . --force --reinstall
```

Friday checks the installed runtime version against its pin at startup and reports the reinstall command when the source checkout and tool environment differ.

### Uninstall The Source Installation

```powershell
uv tool uninstall friday-agent
```

The source checkout can then be removed. User data under `~/.friday/` remains until deleted explicitly.
