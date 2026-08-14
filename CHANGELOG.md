# Changelog

Friday records product releases here. Internal test builds and packaging retries are intentionally omitted.

## Unreleased

- Made everything outside the core loop a plugin. Friday's built-in capabilities - the required `workspace` tools, `web`, `memory`, and `skills` - are now capability packs in the same registry and module shape external plugins use, assembled by one code path; the Skills prompt section moved out of the prompt composer into the skills pack. External plugins are local ES modules in `.friday/plugins/` (project) or `~/.friday/plugins/` (user) contributing tools, prompt sections (string or per-turn function), and transparent tool middleware. `disabled_plugins` in config.json or `FRIDAY_DISABLED_PLUGINS` unplugs any non-required capability for real - disabling `memory` stops recall/capture, and the Goal verifier honors the same list while assembling only from built-in packs' declared read-only tools (checked loudly at build time). Registered tool names cannot be shadowed, schema-changing wrappers are rejected, broken plugins are reported instead of fatal. Inspect with `/plugins`, `plugin.list`, or `session.info`; `FRIDAY_DISABLE_PLUGINS=1` skips external plugin code for hermetic runs.
- Collapsed the session's two turn runners into one lifecycle frame, which also fixes a real defect: after an approval was resolved, the continuation's tool events were discarded instead of recorded, so Goal-mode verification and the no-progress guard examined the previous turn's stale events rather than the work that just happened.
- Turn metrics now include provider-reported cache tokens and end-of-turn context occupancy. Agent Core reads every known cache shape (Anthropic cache read/creation, OpenAI `prompt_tokens_details`, DeepSeek `prompt_cache_hit_tokens`) and the Anthropic adapter forwards cache fields it previously dropped, so the per-message usage line in both UIs shows real figures instead of `n/a`.
- Rebuilt the TUI frame around a static scrollback: finished messages render once into the terminal's own history and only the live turn, status, and composer repaint. The input stays pinned to the bottom on Linux terminals instead of flickering when output passes the last row; long streams render as a bounded tail until complete.
- Split TUI detail shortcuts: `Ctrl+O` now toggles only tool-call details and `Ctrl+T` toggles thinking content, removing the old shared-toggle conflict.
- Added a TUI fork map (`/branches`, also opened by `/fork` and `/backward`): the conversation tree with guide lines, current/root markers, and fork-origin message indexes; `↑↓←→` navigate, `Enter` opens a branch, `Ctrl+D` deletes a branch and its children after confirmation. `session.tree` nodes now carry `turns` and `fork_message_index`.

## v0.2.1 - Final TypeScript repository cleanup (2026-08-14)

- Retired the in-repository Python Harness, phone bridge, Python desktop sidecar, and migration-only release paths. Friday now has one TypeScript runtime; only the optional Harbor protocol adapter remains Python.

## v0.2.0 - TypeScript runtime and unified distribution (2026-08-13)

- Rebuilt Agent Core and the Friday Harness as a TypeScript monorepo with one guarded model/tool loop, explicit runtime context, structured permissions, resumable sessions, layered memory, verification, and observable traces.
- Shipped the same Harness through the TUI, headless `friday run` evaluation command, browser observability UI, and a standalone Tauri desktop sidecar without a Python, Node.js, Bun, or Rust runtime requirement for desktop users.
- Added public `friday-agent-core` and `friday-agent` npm packages, native Windows, macOS, and Debian installers, checksum-bearing GitHub Releases, and tag-driven cross-platform validation.
- Kept legacy Friday state compatible for rollback and left the separately maintained Python Agent Core repository untouched.

## v0.1.11 - TUI navigation and loop diagnostics (2026-08-12)

- Rebuilt the TUI around prefix-filtered slash completion and searchable keyboard menus for provider login, model and native thinking-level selection, web-search credentials, permissions, and saved conversations. Added branch navigation, background Trace Workbench control, and reliable double-Esc cancellation across Windows, macOS, and Linux terminals.
- Anchored live context occupancy to the provider's latest exact prompt-token count; Friday reports only the locally measured delta until the next request. Turn input, output, request, and cache totals remain provider-derived cost measurements rather than context estimates.
- Added a composable tool lifecycle layer around Agent Core: permission preflight runs before a batch, while post-tool hooks preserve approval suspension, attach visual results, and detect exact repeated calls within a batch or across a three-round sliding window. Read-only calls retain bounded parallel execution and every tool keeps its durable backend timing.
- Centralized model, search, and Skill discovery under Friday-managed state and CLI/TUI flows; source installs no longer depend on `.env` files, and macOS/Linux now have a checkout launcher equivalent to `friday.cmd`.
- Unified Python, TUI, desktop, and Tauri release metadata at `0.1.11`; `friday doctor` now reads the installed package version, including from the bundled desktop sidecar, instead of carrying a second hard-coded version.
- Removed obsolete repository-local evaluation fixtures and reports. Evaluation remains a development activity rather than part of the installed product or public usage path.

## v0.1.10 - Provider controls and runtime reliability (2026-08-08)

- Added OpenCode Go as a built-in provider and made thinking levels follow each provider and model's native capabilities instead of exposing one invented scale everywhere.
- Reworked model, web-search, and phone credentials around the same direct key controls, with provider enable/disable state, model refresh, and safer preservation of existing secrets.
- Unified the corresponding desktop, TUI, and CLI model state so disabled providers cannot remain active and every client reports the same available choices.
- Updated to `friday-agent-core` 0.1.10, which fixes final-step termination, initial history import, caller-owned history mutation, serial tool barriers, lazy provider construction, and runtime error events.

## v0.1.9 - Turn-level trace auditing (2026-08-08)

- Reworked the observability workbench around collapsible turns and ordered model, tool, verification, approval, and compaction activity instead of replaying the chat transcript.
- Human inspection and Trace Analyst now share one bounded, redacted evidence projection that preserves public request messages, assistant tool calls and arguments, tool results, timing, cache usage, and provider token usage without exposing the private control prefix.
- Audit evidence can be loaded once and then shown or hidden without another request; the workbench uses a calmer serif type system, and the desktop navigation now labels the feature as **观测**.

## v0.1.8 - Bounded file tools with live command progress (2026-08-08)

- Read now returns at most 2,000 lines or 50 KiB with an explicit continuation point, while preserving Friday's external-file, image, and complete-artifact behavior.
- Edit accepts multiple exact replacements in one call, preserves BOM and line endings, writes atomically, and serializes concurrent edits to the same file.
- Bash streams correlated progress while running, keeps the final 2,000 lines or 50 KiB in context, and stores complete oversized output as a managed artifact for later inspection.

## v0.1.7 - Parallel tools and a calmer trace (2026-08-08)

- Independent tool calls now run concurrently: Read, Glob, Grep, WebSearch, and WebFetch are declared parallel-safe, so a model batch of independent calls executes together instead of one after another (up to four at a time). Write, Edit, Bash, and UpdatePlan stay serial, which keeps the single approval slot and workspace side effects safe. The runtime measures each call's real execution time inside its own thread.
- Tool rows and the trace workbench show that per-call time: the desktop and TUI rows display the backend-measured duration next to the result preview, and trace durations prefer the executor measurement, so a parallel batch no longer reads every call as taking as long as the slowest one.
- Activity groups render one turn's reasoning as a single block (with real accumulated thinking time, not the span that counted tool rounds in between) and aggregate tool runs by name, so a long multi-tool turn stays a few quiet rows until opened.
- The per-reply metrics line dropped the browser tooltip for a drawn info button and a popover that matches the sources popover, with the row tucked closer to the reply.
- The composer is flatter with a softer radius, grows with the draft up to a third of the window, and then scrolls internally.

## v0.1.6 - Discovered models and a calmer turn (2026-08-07)

- Built-in providers (DeepSeek, Xiaomi MiMo, OpenAI, Anthropic) are now configured with just an API key: Friday calls the provider's `/models` endpoint on save, which validates the key and turns every advertised model into a profile. Re-saving re-syncs the list (new models appear, removed ones drop), and the chat model menu shows everything the provider serves.
- A new **OpenAI Compatible** provider covers every other service that speaks the OpenAI chat API (vLLM, SiliconFlow, Groq, ...). Each entry keeps its own name, base URL, model id, and API key, and can be deleted from the same page.
- Streaming is consistent across surfaces: the intermediate narration between tool rounds no longer accumulates into one unreadable stream that the final answer then replaces. The desktop, TUI, and phone cards all drop it at each tool boundary, and reasoning stays hidden when the thinking effort is `off` — the final answer is the only text that ever renders.
- Tool rows now show the backend-measured execution time next to the result preview in the desktop and TUI (the trace workbench already showed both).
- Long tool activity groups scroll inside a capped height instead of owning the screen, and group labels carry the call count (`Ran multiple commands ×8`).
- The composer is flatter with a softer radius, grows with the draft up to a third of the window, and then scrolls internally instead of taking over the screen.

## v0.1.5 - The full window, on every role (2026-08-06)

- Every model now defaults to the full 1M-token window, and one model serves all three roles: the work agent, the verifier, and the trace analyst all use the workspace's own model configuration, so a provider whose real ceiling is below 1M never gets a window it cannot serve. (The verifier previously forced the full window only for DeepSeek.)
- The desktop no longer grinds as a conversation grows. Streamed replies are batched and rendered as plain text until they finish, unchanged messages are never re-rendered or re-parsed, and long conversations stay responsive instead of slowing with every turn.
- The desktop's memory is now bounded no matter how long a session runs: attached images live in a capped LRU budget instead of the timeline, oversized tool output is truncated, and a project left idle for five minutes frees both its backend process and its on-screen history (reopening it restores the same conversation automatically).
- Fixed a race where reopening a project while its idle backend was being reclaimed could misreport a clean stop as a crash. The gateway now distinguishes stops this window asked for from real crashes by process id, so a restart mid-reclaim is never surfaced as an error.
- Windows installers are now built and published to the GitHub release alongside the macOS DMGs, so a desktop update no longer requires building locally.

## v0.1.4 - A verifier that never asks, and a welcome that knows the time (2026-08-06)

- Fixed the desktop reporting "Verifier returned invalid JSON" whenever the verifier's own command needed approval. The verifier runs as an extension of the main session, so an approval it triggers now lands on that session's pending slot where the turn, the UI, and the post-run check can all see it; an empty verifier answer is also reported as "no output" instead of being blamed on the JSON.
- The verifier no longer asks for permission at all. Its job is to break the deliverable, which means running builds, tests, and probes without pausing the turn; commands that are unsafe for every agent (disk format, credential exfiltration, encoded shell) stay blocked.
- The verifier now runs on the model's full 1M-token window when the model is DeepSeek, instead of budgeting against the working session's configured window: every verification is a fresh one-shot check, so it never needs to conserve context.
- A new empty conversation now greets you with a typewritten, time-aware hint (good morning / afternoon / evening / late night) picked at random from a fixed pool. It shows on first launch and whenever you start a new conversation, retypes a fresh line each time, and fades in gently.

## v0.1.3 - Runs that do not stop, and a context window that explains itself (2026-08-06)

- A turn no longer ends because it took too many steps or spent too much. The context window is the only bound left, and compaction is what keeps a run inside it, so a long task now runs until the work is done. `run_token_budget` is still accepted in existing configuration files and no longer enforces anything.
- Compaction now happens mid-run instead of only between turns, and in two stages: tool results are reclaimed first when that frees at least a quarter of the window, because their full output stays on disk and nothing the user wrote is touched; only when that is not enough is the conversation itself summarised. A run continues through both.
- Compaction rewrites what the model is sent, not what you read. Messages it takes out of the prompt are kept with the session, so the conversation on screen only ever grows, and forking still points at the message you picked.
- Fixed compaction failing outright and printing raw XML into the conversation. It no longer runs as a tool-using agent inside a step-limited flow, strips markup from what the model returns, and falls back to a locally written summary when the model cannot produce one. Both the desktop and the TUI say when it happened and what it did.
- A turn that a guard ends early now says so in both the desktop and the TUI, instead of arriving looking exactly like a finished answer.
- Each reply now keeps the figures it was answered with. They were held only in the live event that delivered them, so switching conversations or reopening one left every earlier reply blank.
- The metrics line now reads as what it is: the context figure is how full the conversation is, and the token counts are totals over every request the turn made. The request count is shown, because it is what explains an input total far larger than the context, and cache is quoted inside the input it is part of rather than beside it, where it looked like a second, larger context.
- A conversation now appears in the sidebar the moment you send the first message, rather than when the reply arrives, so there is no longer a stretch where a new conversation shows no sign of existing.
- Tool output is capped before it reaches the model, so a single command cannot fill the window in one step.
- The default context window is now 300K.
- Projects you closed stay closed, and a project whose folder you deleted is dropped from the sidebar instead of failing to open with a raw operating-system path error. On Windows the same workspace could be registered twice under two spellings of its path, which is why closing a project did not always stick and why the sidebar could list one project as two.
- Fixed bold text printing its asterisks in Chinese output. `**注意：**内容` is ordinary Chinese and CommonMark refuses to close emphasis there; the punctuation now moves just outside the marker so it renders. Code spans and code blocks are left exactly as written.
- The desktop starts lighter and reclaims what it is not using: the model SDK is loaded on first use rather than at startup, and a project left idle has its backend stopped and restarted when you return to it.

## v0.1.2 - Verification feedback and sidebar polish (2026-08-05)

- A failed verification now carries the verifier's reason in the desktop UI instead of stopping at a bare error label, and the verifier gets enough output tokens for thinking models to finish writing their verdict instead of being cut off before the JSON arrives.
- Hovering a conversation in the Recent list now draws the full rounded highlight and keeps both action buttons visible; the row no longer overflows the sidebar's clip edge.
- Fixed the phone bridge never starting in the installed desktop app: the packaged build is one binary whose entry point is the gateway, so the child was spawned with a spelling only a source checkout understands and it started a second gateway that exited immediately. Starting any Friday child now goes through one place that knows both forms.
- The packaged desktop build now carries the Feishu SDK, so the phone switch no longer depends on which optional extras the machine that built it happened to have installed. A build without the SDK says so under the switch instead of failing quietly.
- Settings forms share one save path, so a save that finishes after you leave its section no longer writes to a screen that is gone, and API key fields behave the same in Models, Web search, and Phone.
- Conversations started from your phone now show up in the desktop sidebar under their own Phone section, which stays in place whether or not it currently holds anything. Projects, Phone, and Recent each fold away when you click their heading, and what sits under a heading is now indented under it.
- The rename and delete marks on a conversation row now line up with each other, as do the marks on every other row and button in the app. They used to be typed characters, which each font places differently and some fonts do not carry at all, so Windows was drawing the pencil from an emoji face that sat lower and heavier than the cross beside it. They are drawings now, and a drawing lands where it is put.
- A skill's file path is no longer sliced through the middle of its letters when the window is not tall enough to show the whole skill. The dialog was handing its shortfall to every row at once, including a row that hides what does not fit; only the scrolling pane gives up height now. The sidebar, the branch map, the memory editor, and the composer had the same latent flaw and were pinned the same way.
- Paths shown in the skills dialog, the artifact preview, and the memory editor now shorten the same way, from the front, so the file name stays readable. A model name too long for the model menu is now shortened rather than pushing the menu out of shape.

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
- Added `friday doctor` diagnostics for installation and configuration checks.
- Hardened desktop startup, checkpoint cleanup, approval continuation, Markdown and math rendering, process cancellation, and cross-platform sidecar packaging.
- Fixed macOS gateway startup by using managed CPython sidecars, disabling hardened runtime for ad-hoc signatures, and smoke-testing the gateway inside both shipped DMGs.
