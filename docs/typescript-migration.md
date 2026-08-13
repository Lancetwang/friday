# TypeScript migration

The rewrite was developed on `codex/typescript-rewrite` in the existing Friday
repository and promoted to `main` for v0.2.0. It was never a separate
repository; the independent Python Agent Core remains separately maintained.

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

Every `v*` tag runs the three-platform test and packaging matrix. The tested
installers and npm tarballs are attached to a GitHub Release with SHA-256
checksums. If npm ownership is still being bootstrapped, the full package can
be installed directly from that Release:

```bash
npm install --global ./friday-agent-0.2.0.tgz
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

## Releases

`.github/workflows/typescript.yml` tests Windows, macOS, and Linux, then publishes:

- Windows x64 NSIS installer
- macOS arm64 DMG
- Linux x64 Debian package
- `friday-agent` and `friday-agent-core` npm tarballs

npm publishing uses the same tested tarballs and runs only after the GitHub
Release succeeds. It is gated by the repository variable
`NPM_PUBLISH_ENABLED=true`: the first publish must authenticate the npm owner
with an `NPM_TOKEN`; after both package names exist, they can use npm trusted
publishing for `typescript.yml` and the token can be removed.

## Deliberate scope

Phone and Feishu connectivity are absent from the TypeScript gateway and hidden
by its clients. The old Python files in Friday remain untouched on this branch
to make rollback possible during migration. The separate Python
`agent-core-runtime` repository is outside this migration and remains available
for independent maintenance.

## Promotion gates

1. Core, Harness, TUI, web UI, and Tauri pass on all three desktop systems.
2. A standalone desktop sidecar boots with an empty home and no Node.js.
3. Stored-session migration and rollback pass against representative Python
   conversations.
4. npm packages and all three desktop installers are reproducible in CI.
5. Friday's legacy Python Harness is retired only after the TypeScript release
   survives a release cycle; the separate Python Agent Core repository is not
   deleted by this migration.
