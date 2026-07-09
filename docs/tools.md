# Tools

Friday keeps the tool surface small:

- `Read`: read a line window from a file.
- `Write`: create or overwrite a UTF-8 text file.
- `Edit`: edit by line range or exact text match.
- `Bash`: run shell commands in the workspace.
- `Glob`: find files by path pattern.
- `Grep`: search file contents by regex.
- `Skill`: list or read reusable `SKILL.md` workflows.
- `Memory`: read or update user, global, or project memory.

`Bash` runs PowerShell on Windows and `bash -lc` elsewhere.

Dangerous Bash commands create `.friday/pending_approval.json`. Run `/approve` to execute the pending command or `/reject` to discard it.

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

