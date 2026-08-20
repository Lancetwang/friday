# Tools and Permissions

The built-in capability packs expose this tool surface:

| Tool | Purpose |
| --- | --- |
| `Read` | Page through a UTF-8 text file or list a directory. |
| `Write` | Create or replace a UTF-8 text file. |
| `Edit` | Apply exact, non-overlapping text replacements. |
| `Glob` | Find workspace files and directories by glob. |
| `Grep` | Search workspace text files with a JavaScript regular expression. |
| `Bash` | Run PowerShell on Windows or `/bin/bash -lc` elsewhere. |
| `WebSearch` | Search through the configured Tavily/AnySearch fallback chain. |
| `WebFetch` | Fetch a public URL as bounded Markdown through Jina Reader. |
| `UpdatePlan` | Update the session's visible objective, steps, and next action. |
| `Memory` | Inspect and change Friday's file-based durable memory. |
| `Skill` | Read one discovered Skill or a resource inside that Skill. |

`workspace` is required. `web`, `memory`, and `skills` can be disabled; doing
so removes their tools and any Harness hooks described in [Plugins](plugins.md).

## File tools

`Read` accepts paths inside the workspace, user-selected attachment paths, and
the active session's Friday-managed tool-spill directory. It resolves symlinks
before checking the boundary. Arbitrary sibling directories and files such as
`~/.friday/model-credentials.json` are not readable through this tool unless the
user explicitly supplied the path as an attachment.

One Read returns at most 2,000 lines and 50,000 characters. A truncated result
contains `next_start_line`. Read treats files as UTF-8 text; it does not turn a
local image into model vision input. Desktop images enter as user attachments
and require a model profile marked vision-capable.

`Write` and `Edit` resolve their targets inside the workspace, write by atomic
replacement, and serialize concurrent changes to the same resolved file.
`Edit` evaluates every replacement against the original file, rejects ambiguous
or overlapping matches, and preserves a UTF-8 BOM and the existing line-ending
style.

`Glob` and `Grep` remain inside the workspace even when symlinks point outward.
They skip `.git` and common generated directories unless the requested pattern
explicitly names a generated directory. Long scans check cancellation while
walking and reading files.

## Bash output and cancellation

Every Bash call starts in the workspace. The command itself is not path-
confined: shell syntax and absolute paths can reach anything allowed to the
launching user after permission preflight.

Each of the stdout and stderr streams is bounded separately before it enters
the conversation:

- a stream up to 16,000 characters is returned complete;
- a larger stream returns its true first 8,000 and last 4,000 characters with an
  omission notice;
- when spill storage is available, Friday saves the combined streams up to
  roughly 2,000,000 characters and returns a path the Agent can page with
  `Read`.

Small outputs do not create spill files. Deleting a conversation removes its
session spill directory.

The default timeout is 60 seconds and the accepted range is 1–600 seconds. A
timeout asks the operating system to terminate the spawned process tree. Friday
settles from process exit rather than waiting indefinitely for inherited output
pipes, and uses a bounded grace after termination. Cancellation also races the
tool promise itself, so a child that ignores the signal cannot keep the Agent
turn waiting; an unkillable or detached process may remain outside Friday after
the cancelled call has settled.

## Concurrency

`Read`, `Glob`, `Grep`, `WebSearch`, `WebFetch`, and `Skill` are marked
parallel-safe. Core executes consecutive parallel calls with `Promise.all`, at
most four at a time, and returns their results in model-call order. This is
asynchronous I/O concurrency, not a pool of worker threads.

`Write`, `Edit`, `Bash`, `UpdatePlan`, `Memory`, and tools without the parallel
flag are serial barriers. Core flushes pending parallel work before a serial
call and before returning the batch.

## Bash permission policy

Before Bash executes, the Harness applies hard denials and project permission
rules, then the active mode:

- `manual`: dangerous commands pause the turn for a person to approve once,
  allow for the active session, reject, or reject with guidance;
- `auto`: dangerous commands go to a separate text-only model review; a missing,
  failed, or negative review denies safely;
- `bypass`: interactive approval is skipped, but hard denials and explicit deny
  rules remain active. Use it only inside an isolated evaluator.

The mode is gateway-wide and is read again for every Bash preflight. Changing
it from the TUI or desktop while a request is running therefore governs that
request's next Bash call; it does not retroactively change a call whose
preflight already finished.

Common network egress, credential-store access, package installation,
destructive Git operations, permission changes, elevation, and persistence
commands are classified as dangerous. Credential exfiltration, disk/boot
operations, destructive system-root operations, encoded PowerShell, and common
download-and-execute forms include hard-denied patterns. This is a practical
command policy, not a complete shell sandbox; equivalent commands can be
spelled in forms the pattern set does not recognize.

Persistent Bash rules live at:

```text
~/.friday/projects/<workspace-id>/permissions.json
```

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

The Goal verifier receives a separate Bash preflight that rejects the normal
dangerous set plus common Git, packaging, redirection, file-creation, and move
commands. It still runs a real shell and is not an OS-enforced read-only
environment.

## Network and credentials

`WebSearch` uses Tavily first when configured, then AnySearch when Tavily is
unconfigured or unavailable. Configure keys in desktop **Settings > Web
Search**, TUI `/search`, or explicit process environment variables. Friday-
managed keys stay in `~/.friday/web-credentials.json`, are omitted from normal
settings responses, and are returned only by the explicit reveal action. They
are not injected into tool subprocess environments.

`WebFetch` sends the requested public URL to Jina Reader and rejects loopback,
private-network, and credential-bearing targets. It works without a key and
sends `JINA_API_KEY` as a bearer credential when one is configured. WebSearch
and WebFetch are network tools in their own right and do not pass through Bash
approval. Retrieved content is untrusted model input.

Model and web keys managed by Friday are read by their owning services. Process
environment variables that the user exported before starting Friday remain
part of Friday's inherited environment and therefore of Bash subprocesses.

## Delivered artifacts

When a turn materialized a checkpoint, Friday compares its before/after trees
and attaches changed Markdown, text, image, PDF, JSON, CSV, and HTML files to
the final assistant reply. The desktop loads previews only from workspace-
relative paths, renders HTML as source text, and rejects escaped, missing,
unsupported, or over-25-MB files.

## Web research contract

The bundled runtime prompt asks the Agent to begin with one broad search and to
search again only when a required fact, source, or artifact is still missing.
It also asks the Agent to cite retrieved sources for externally verifiable
claims and distinguish inference from evidence.
