# Tools

Friday keeps the tool surface small:

- `Read`: read a line window from a file.
- `Write`: create or overwrite a UTF-8 text file.
- `Edit`: edit by line range or exact text match.
- `Bash`: run shell commands in the workspace.
- `Glob`: find files by path pattern.
- `Grep`: search file contents by regex.
- `WebSearch`: search the live web through a provider fallback chain when current external information is needed.
- `WebFetch`: fetch a known URL as clean Markdown through Jina Reader.
- `Skill`: dynamically list reusable workflows with their names, descriptions, and `SKILL.md` paths; Bash reads or runs the selected skill.
- `UpdatePlan`: maintain the visible objective and step status for non-trivial work in the current session.
- `Memory`: read or update user, global, or project memory.

`Bash` runs PowerShell on Windows and `bash -lc` elsewhere. A timeout terminates the whole spawned process tree so grandchildren cannot keep Friday blocked by inherited output pipes.

Dangerous Bash commands create `.friday/pending_approval.json`. Run `/approve` to execute the pending command or `/reject` to discard it.

`WebSearch` uses Tavily first when `TAVILY_API_KEY` is configured, then falls back to AnySearch when Tavily is unconfigured or unavailable. Set `ANYSEARCH_API_KEY` for higher AnySearch limits; anonymous fallback remains available. Keys can be placed in the process environment, the workspace `.env`, or `~/.friday/.env`.
`WebFetch` works without a key through Jina Reader; set `JINA_API_KEY` for higher rate limits.
They are Friday application tools, not part of `agent-core-runtime`.

## Web research contract

Friday starts with one broad search and searches again only when a required fact or source is missing, exhaustive coverage was requested, a specific artifact must be read, or an important claim would otherwise be unsupported. Empty or suspiciously narrow results get one or two meaningful fallbacks. It does not repeat searches only to improve wording or add optional detail.

Research answers cite retrieved sources next to the claims they support, distinguish inference from directly supported facts, report material conflicts, and narrow the answer instead of guessing when evidence is missing.

Persistent Bash policy lives in `.friday/permissions.json`:

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
