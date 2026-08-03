# Changelog

Friday records product milestones here instead of duplicating every beta build. Binary downloads are retained for the two newest releases; older source milestones remain available through Git tags and history.

## v0.1.0 Beta 8-9 - Cross-platform desktop (2026-08-03)

- Added native desktop packages for Windows x64, macOS Apple Silicon, and macOS Intel.
- Added ad-hoc signing and strict bundle verification so downloaded macOS apps are structurally valid before release.
- Replaced the Windows-only sidecar build entry with one cross-platform build pipeline.
- Kept the CLI and TUI available on Windows, macOS, and Linux.
- Added bilingual installation guidance for packaged and source deployments.

## v0.1.0 Beta 6-7 - Harness evaluation and hardening (2026-08-02 to 2026-08-03)

- Added a 50-case local Harness benchmark and a 25-case representative agent benchmark suite.
- Added `friday doctor` for installation and runtime diagnostics without spending model tokens.
- Hardened compacted sessions, approval continuation, verifier context, CLI/TUI startup, and runtime compatibility checks.
- Allowed `Read` to inspect external local files while preserving workspace boundaries for writes and edits.
- Added the MIT license, package metadata, project banner, and release documentation.

## v0.1.0 Beta 4-5 - Desktop productization (2026-08-01)

- Added immediate bilingual UI switching, a startup splash, and resilient Windows checkpoint cleanup.
- Added managed user and global memory editing with size, secret, and atomic-write safeguards.
- Added model and search provider branding, cited-source previews, and native folder drag-and-drop.
- Consolidated model, web search, interface, and user-profile configuration under Settings.
- Moved volatile environment context to the end of the prompt prefix to improve cache reuse.

## v0.1.0 Beta 2-3 - Self-contained installation (2026-08-01)

- Removed the external Git executable requirement from checkpoints by bundling a pure-Python object store.
- Made memory and Skill access work in clean desktop installations without a separately installed Friday CLI.
- Preserved credential and write boundaries while exposing managed context to the packaged Agent.

## v0.1.0 Beta 1 - First public beta (2026-08-01)

- Shipped the first Windows desktop client with an embedded Friday gateway.
- Included persistent projects and sessions, branching, undo, parallel work, approvals, model profiles, vision input, web search, Skills, memory, and observable traces.
