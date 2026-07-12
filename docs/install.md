# Install

This guide installs Friday from GitHub as a global `friday` command. The source checkout must remain on disk because the TUI is launched from it.

## Requirements

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

## Clone And Install

```powershell
git clone https://github.com/Lancetwang/friday.git
cd friday
npm --prefix ui-tui ci
npm --prefix ui-tui run build
uv tool install -e . --force --reinstall
```

`uv tool install` creates an isolated Python environment and installs the exact `agent-core-runtime` revision pinned by this Friday checkout. The editable Friday install keeps the global command connected to the cloned TUI and Python source.

If `friday` is not found after installation, run `uv tool update-shell`, reopen the terminal, and try `friday --help`.

## Model Configuration

Create one global configuration file so Friday works from every workspace.

PowerShell:

```powershell
New-Item -ItemType Directory -Force "$HOME\.friday" | Out-Null
Copy-Item .env.example "$HOME\.friday\.env"
Copy-Item config.example.json "$HOME\.friday\config.json"
notepad "$HOME\.friday\.env"
notepad "$HOME\.friday\config.json"
```

bash:

```bash
mkdir -p "$HOME/.friday"
cp .env.example "$HOME/.friday/.env"
cp config.example.json "$HOME/.friday/config.json"
${EDITOR:-vi} "$HOME/.friday/.env"
${EDITOR:-vi} "$HOME/.friday/config.json"
```

Put secrets in `.env`:

```text
LLM_API_KEY=your-key
TAVILY_API_KEY=optional-web-search-key
JINA_API_KEY=optional-web-fetch-key
```

Put non-secret model settings in `config.json`:

```json
{
  "provider": "deepseek",
  "model": "deepseek-v4-flash",
  "base_url": "https://api.deepseek.com",
  "context_window": 353000,
  "max_output_tokens": 65536
}
```

Friday also reads `<workspace>/.friday/config.json` when present. A project config overrides only the keys it contains; all other values come from the global file. Provider-specific keys such as `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, or `OPENROUTER_API_KEY` are supported, with `LLM_API_KEY` as the generic fallback. Configuration changes apply the next time Friday starts or rebuilds its context.

Secret priority is:

1. Process environment variables.
2. The active workspace's `.env`.
3. `~/.friday/.env`.

This lets one global secret configuration work everywhere while allowing a project to override it locally.

## Verify The Installation

Run these from a directory other than the Friday checkout:

```powershell
friday --help
friday ask "Reply with OK and do not use tools"
friday
```

The first two commands verify the global launcher, model connection, and runtime. The final command starts the TUI with the current directory as its workspace.

## Upgrade Friday And Agent Core

Friday pins a tested `agent-core-runtime` revision in `pyproject.toml`. Do not independently upgrade agent-core inside the tool environment: a newer core may have an incompatible API.

To update both Friday and its compatible core together:

```powershell
cd path\to\friday
git pull --ff-only
npm --prefix ui-tui ci
npm --prefix ui-tui run build
uv tool install -e . --force --reinstall
```

If agent-core v2 is released but Friday still pins v1, continue using v1. Once Friday updates its pin after compatibility testing, `git pull` plus the reinstall command upgrades both together.

Friday checks the installed core against its pinned source at startup. If the checkout was updated without reinstalling the isolated tool environment, startup stops with the exact reinstall command instead of failing midway through a turn.

## Uninstall

```powershell
uv tool uninstall friday-agent
```

Removing the cloned repository removes the TUI source. User memory and global configuration remain under `~/.friday/` until deleted explicitly.
