# Changelog

Friday records product releases here. Internal test builds and packaging retries are intentionally omitted.

## v0.1.0 - First stable release (2026-08-03)

- Shipped native desktop packages for Windows x64, macOS Apple Silicon, and macOS Intel, alongside the cross-platform CLI and TUI.
- Added persistent projects and sessions, branching, undo, parallel work, approvals, model profiles, vision input, web search, Skills, memory, and observable traces.
- Added a two-layer Agent and Verify / Goal loop with resumable progress, evidence-based verification, and long-running task control.
- Added prefix-aware context assembly, multi-stage compaction, layered memory, progressive Skill disclosure, and program-enforced permissions.
- Removed external Git and separately installed Friday CLI requirements from the packaged desktop app.
- Added managed model, web search, language, and user-profile settings with local persistence under `~/.friday/`.
- Added a 50-case local Harness benchmark, a 25-case representative agent benchmark, and `friday doctor` diagnostics.
- Hardened desktop startup, checkpoint cleanup, approval continuation, Markdown and math rendering, process cancellation, and cross-platform sidecar packaging.
- Fixed macOS gateway startup by using managed CPython sidecars, disabling hardened runtime for ad-hoc signatures, and smoke-testing the gateway inside both shipped DMGs.
