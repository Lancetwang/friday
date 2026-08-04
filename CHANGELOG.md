# Changelog

Friday records product releases here. Internal test builds and packaging retries are intentionally omitted.

## v0.1.1 - Security and reliability hardening (2026-08-04)

- Bash now requires approval for network egress, package installation, credential reads, destructive history rewrites, permission changes, and persistence installs, and denies reading a secret and sending it outward in a single command.
- Tool subprocesses no longer inherit the API keys Friday loads from its own credential stores, so a shell command cannot read them back out.
- Approvals and approval policy are per session: one file per conversation, claimed by atomic rename so an approval cannot be replayed. Switching one conversation to `bypass` no longer changes conversations that already exist; new conversations still inherit the choice.
- The trace server rejects non-loopback `Host` headers, closing a DNS-rebinding path to local traces.
- Fixed a cancel that arrived between turns silently cancelling the next one.
- Fixed lost memory entries when two turns captured memory at the same time, and refused edits against a memory file that moved on disk instead of rewriting a neighbouring entry.
- Cut repeat work in memory recall by caching parsed episodic Markdown; a year of history went from 42 ms to 11 ms per turn.
- Bounded the desktop artifact thumbnail cache and released per-project state when a project is closed.
- Restricted Markdown links and images to `http(s)` and inline image data, sandboxed the PDF preview frame, and tightened the desktop Content-Security-Policy.
- The Observability button now opens the trace URL from the app instead of relying on the bundled sidecar to find a browser.
- Cached idle gateway sessions are now evicted, and per-turn reasoning and tool bookkeeping is released even when a turn fails.
- The Sources list under an answer now covers every round of a multi-step search instead of the first eight results, and counts the page a fetch retrieved rather than the links inside it.
- Long artifact names now stay inside their card and truncate, with the full name on hover.

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
