# Tools

Friday keeps the tool surface small:

- `Read`: read a line window from a file.
- `Write`: create or overwrite a UTF-8 text file.
- `Edit`: edit by line range or exact text match.
- `Bash`: run shell commands in the workspace.
- `Glob`: find files by path pattern.
- `Grep`: search file contents by regex.
- `WebSearch`: search the live web through Tavily when current external information is needed.
- `WebFetch`: fetch a known URL as clean Markdown through Jina Reader.
- `Skill`: dynamically list reusable workflows with their names, descriptions, and `SKILL.md` paths; Bash reads or runs the selected skill.
- `Memory`: read or update user, global, or project memory.

`Bash` runs PowerShell on Windows and `bash -lc` elsewhere.

Dangerous Bash commands create `.friday/pending_approval.json`. Run `/approve` to execute the pending command or `/reject` to discard it.

`WebSearch` requires `TAVILY_API_KEY` in the process environment, the workspace `.env`, or `~/.friday/.env`.
`WebFetch` works without a key through Jina Reader; set `JINA_API_KEY` for higher rate limits.
They are Friday application tools, not part of `agent-core-runtime`.

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
