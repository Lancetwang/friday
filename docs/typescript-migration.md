# TypeScript migration

The rewrite lives on `codex/typescript-rewrite` in the existing Friday
repository. The branch starts from `main`; it is not a new repository and it
does not merge back until the migration is deliberately promoted.

## Architecture

- `packages/core` is the small asynchronous model/tool loop. It knows nothing
  about Friday settings, persistence, permissions, or UI.
- `packages/harness` owns prompts, providers, tools, permissions, sessions,
  recovery, memory, verification, and the NDJSON gateway.
- `ui-tui` and `ui-desktop` are clients of that one gateway.

The core does not port the Python `Flow`/`Node` graph. One guarded agent loop,
an explicit `RunContext`, async functions, and `AbortSignal` cover the actual
execution shape without a speculative graph framework.

## Packages and commands

The public packages are intentionally only the two useful boundaries:

```bash
# Embed only the generic agent loop in another TypeScript project
npm install friday-agent-core

# Install Friday Core + Harness + TUI
npm install --global friday-agent
friday
```

`friday-agent-harness` and `friday-agent-cli` are private workspaces bundled
inside `friday-agent`; users do not assemble the application from internals.
npm creates `friday` on macOS/Linux and `friday.cmd` on Windows, so the command
is the same in PowerShell, cmd, bash, and zsh.

The npm names are prepared but not published during branch development. The
`Friday-npm-packages` workflow artifact contains the exact packages intended
for publication. Extract it and test the full package with:

```bash
npm install --global ./friday-agent-0.2.0-alpha.0.tgz
friday --version
```

## Develop and test

Node.js 22 or newer is required for source and npm installs.

```powershell
npm ci
npm test
npm run tui:ts

npm ci --prefix ui-desktop
npm run desktop:ts
```

The desktop application compiles the gateway into a platform-specific Bun
sidecar. End users of the NSIS, DMG, or Debian package do not need Node.js, Bun,
Python, or Rust.

## Evaluations

Evaluators should use the stable, non-interactive surface rather than the TUI:

```bash
friday run --cwd /workspace \
  --trajectory /logs/agent/trajectory.json \
  -- "Complete the task and verify the result"
```

`run` selects bypass permission mode because the evaluator already supplies an
isolated sandbox. The output trajectory is ATIF-v1.7. Harbor's adapter lives in
`integrations/harbor`; Python appears only in that adapter because Harbor's
custom-agent interface is Python. Friday Core, Harness, tools, and command stay
TypeScript and can be called by any benchmark that can execute a process.

See [Evaluations](evaluation.md) for Terminal-Bench 2.1.

## Desktop artifacts

`.github/workflows/typescript.yml` tests Windows, macOS, and Linux, then uploads:

- Windows x64 NSIS installer
- macOS arm64 DMG
- Linux x64 Debian package
- `friday-agent` and `friday-agent-core` npm tarballs

## Deliberate scope

Phone and Feishu connectivity are absent from the TypeScript gateway and hidden
by its clients. The old Python files remain untouched on this branch only to
make rollback possible during migration.

## Promotion gates

1. Core, Harness, TUI, web UI, and Tauri pass on all three desktop systems.
2. A standalone desktop sidecar boots with an empty home and no Node.js.
3. Stored-session migration and rollback pass against representative Python
   conversations.
4. npm packages and all three desktop installers are reproducible in CI.
5. Python is removed only after the TypeScript release survives a release cycle.
