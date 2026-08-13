# Install

[中文](install.zh-CN.md)

Friday ships as a standalone desktop app and as an npm-installed TUI. The
desktop app is the shortest path for normal use.

## Desktop App (Recommended)

Download the artifact for your platform from the
[TypeScript workflow](https://github.com/Lancetwang/friday/actions/workflows/typescript.yml),
or from GitHub Releases after the migration is promoted:

- Windows x64: NSIS `.exe`
- macOS Apple Silicon: `.dmg`
- Linux x64: `.AppImage`

The app contains its own TypeScript sidecar. Git, Python, Node.js, Bun, and Rust
are not required. Open **Settings > Models** after launch and configure at least
one model API key.

Windows development builds are not code-signed; macOS builds use an ad-hoc
signature and are not notarized. If macOS blocks the first launch, use **System
Settings > Privacy & Security > Open Anyway**.

An upgrade can be installed over the existing version. Sessions, model profiles,
memory, and settings remain under `~/.friday/`. Uninstalling the application
does not remove that data directory.

## Install the TUI with npm

Node.js 22 or newer is required.

```bash
npm install --global friday-agent
friday
```

npm creates the appropriate executable shim, so the command is `friday` in
PowerShell, cmd, bash, and zsh. The package includes Core, Harness, and TUI.

The npm package will be published with the promoted release. While reviewing the
migration branch, install the same package directly from GitHub:

```bash
npm install --global github:Lancetwang/friday#codex/typescript-rewrite
friday --version
```

To upgrade or uninstall:

```bash
npm install --global friday-agent@latest
npm uninstall --global friday-agent
```

## Install only Agent Core

Applications embedding just the model/tool loop should use the small public core
package, not Friday's internal Harness:

```bash
npm install friday-agent-core
```

## Develop from source

Source development requires Git and Node.js 22 or newer:

```powershell
git clone https://github.com/Lancetwang/friday.git
cd friday
git switch codex/typescript-rewrite
npm ci
npm test
npm link
friday
```

Run a single non-interactive turn with `friday ask "Reply with OK"`; evaluation
sandboxes should use `friday run`. See [Evaluations](evaluation.md).

Desktop development additionally needs the stable Rust toolchain and platform
build tools. From the repository root:

```powershell
npm ci --prefix ui-desktop
npm run desktop:ts
```

Build the current platform's standalone desktop package with:

```powershell
npm run bundle:desktop:ts
```

Model profiles and credentials are configured in the TUI or desktop UI and are
stored under `~/.friday/`. Explicit process variables such as `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `TAVILY_API_KEY`, and
`ANYSEARCH_API_KEY` are also supported for headless runs.
