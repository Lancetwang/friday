# Install

Install project dependencies:

```powershell
uv sync
Copy-Item .env.example .env
cd ui-tui
npm install
cd ..
```

Fill `.env`:

```text
LLM_API_KEY=...
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-v4-flash
```

Run from the repository:

```powershell
uv run friday
```

Install the command globally when ready:

```powershell
uv tool install -e .
```

For local Windows development, this repo includes `friday.cmd`. Put the repo directory on `PATH`, or call it by full path. The command uses your current directory as the workspace.

