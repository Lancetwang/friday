# Tools

Friday keeps the tool surface small:

- `Read`: read a line window from a text file, or load a local image into a vision-capable model.
- `Write`: create or overwrite a UTF-8 text file.
- `Edit`: edit by line range or exact text match.
- `Bash`: run shell commands in the workspace.
- `Glob`: find files by path pattern.
- `Grep`: search file contents by regex.
- `WebSearch`: search the live web through a provider fallback chain when current external information is needed.
- `WebFetch`: fetch a known URL as clean Markdown through Jina Reader.
- `UpdatePlan`: maintain the visible objective and step status for non-trivial work in the current session.

`Bash` runs PowerShell on Windows and `bash -lc` elsewhere. A timeout terminates the whole spawned process tree so grandchildren cannot keep Friday blocked by inherited output pipes.

`Read`, `Bash`, and `WebFetch` return their normal inline content while it fits the requested limit. On overflow, Friday returns a bounded head-and-tail preview and stores the complete text under `~/.friday/projects/<workspace-id>/tool-results/<session-id>/`; the preview includes the full path for selective reading. Context compaction may later remove the inline preview, but keeps the artifact path, source metadata, and execution status. Deleting that conversation removes its large-result directory.

Every Bash call passes a code-level pre-execution policy. Destructive system operations and explicit deny rules are rejected even in full-access mode. Other risky commands either suspend the Agent Loop for approval or, in `auto` mode, go to a separate tool-free reviewer that compares the current user request, command, workspace, and risk; reviewer failure denies safely. The TUI offers four manual decisions: approve once, approve without asking again in the active session, reject, or reject and tell Friday how to continue.

Commands that send data off the machine (`curl`, `wget`, `scp`, `rsync`, `ssh`, `nc`, PowerShell's web cmdlets), install packages, read credential stores, rewrite history destructively, change file permissions, or install persistence all require approval. Reading a secret and piping it outward in one command is denied outright rather than offered for approval, because approving such a command is never the intent behind a legitimate request.

Tool subprocesses do not inherit the API keys Friday loaded from its own credential stores or `.env` files. Keys that were already exported in the user's shell are passed through unchanged, since the user put them there.

## Threat model

Friday is a local agent that acts with the privileges of the user who ran it. Two limits follow from that and are deliberate:

- `Read`, `Glob`, and `Grep` are not confined to the workspace. They can reach any file the user can read, including `~/.friday/model-credentials.json`. Confining them would break ordinary work — reading a config in `~`, comparing against a sibling checkout — and would not contain an attacker who already has Bash.
- Because reads are unconfined, the approval prompt on network egress is the control that matters. A prompt-injected instruction can get file contents into the model's context without asking, but it cannot move them off the machine without an approved `Bash` egress command or a `WebFetch` call.

The practical consequence: treat an egress approval as approving the *contents of the current context*, not just the command. In `bypass` mode there is no such checkpoint, so use it only in workspaces whose inputs you trust.

After a completed turn, Friday compares its existing checkpoint trees and attaches changed Markdown, text, image, PDF, JSON, CSV, and HTML files to that assistant reply. The desktop reads previews only through workspace-relative paths, renders HTML as source text, and rejects unsupported, escaped, missing, or over-25-MB files.

`WebSearch` uses Tavily first when `TAVILY_API_KEY` is configured, then falls back to AnySearch when Tavily is unconfigured or unavailable. Set `ANYSEARCH_API_KEY` for higher AnySearch limits; anonymous fallback remains available. Keys can be configured through **Settings > Web Search**, the process environment, the workspace `.env`, or `~/.friday/.env`. Desktop-managed keys are stored privately in `~/.friday/web-credentials.json` and are never returned to the UI.
`WebFetch` works without a key through Jina Reader; set `JINA_API_KEY` for higher rate limits.
They are Friday application tools, not part of `friday-agent-core`.

Skill discovery and memory management are deliberately not model tools. Friday uses Bash with `friday skill list --json` or `friday memory ...`; the harness performs automatic memory capture and recall in code.

## Web research contract

Friday starts with one broad search and searches again only when a required fact or source is missing, exhaustive coverage was requested, a specific artifact must be read, or an important claim would otherwise be unsupported. Empty or suspiciously narrow results get one or two meaningful fallbacks. It does not repeat searches only to improve wording or add optional detail.

Research answers cite retrieved sources next to the claims they support, distinguish inference from directly supported facts, report material conflicts, and narrow the answer instead of guessing when evidence is missing.

Persistent Bash policy lives in `~/.friday/projects/<workspace-id>/permissions.json`:

```json
{
  "version": 1,
  "bash": {
    "allow": [],
    "deny": [],
    "require_approval": []
  }
}
```
