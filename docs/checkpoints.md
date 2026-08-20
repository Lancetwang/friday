# Checkpoints

Friday creates checkpoints lazily. A user turn records an in-memory checkpoint
seed, and the first built-in `Write`, `Edit`, or `Bash` preflight materializes
it. A turn that only chats, reads, searches, or fetches the web creates no
restorable checkpoint. Approval continuations reuse the pending checkpoint for
their original user turn.

A materialized checkpoint covers:

- files selected by the private backend inside the current workspace: tracked
  plus non-ignored untracked files with Git, or non-ignored files with the
  fallback backend;
- the live and archived conversation state from before the turn;
- objective, plan, progress, turn count, and thinking effort;
- the workspace tree after the turn and the paths changed between both trees.

The desktop exposes restore on user messages that have a matching checkpoint.
Restoring returns files, conversation, progress, and thinking effort to the
pre-turn boundary. Restoring an older checkpoint supersedes newer checkpoints
because workspace history is linear. TUI `/fork` and `/branches` create and
navigate conversation branches; they do not restore workspace files.

## Storage

Checkpoint state lives under:

```text
~/.friday/projects/<workspace-id>/checkpoints-ts/
  entries/       checkpoint JSON records
  repo.git/      private bare Git object database when Git is available
  files/         content-addressed fallback when Git is unavailable
```

Workspace file content is content-addressed in the private backend, so unchanged
files are not copied for every checkpoint. Friday never changes the workspace's
own Git index, branch, commits, stash, or object database.

Conversation state is different: every checkpoint entry currently stores its
own `before_messages` and `before_archived` arrays rather than referencing the
trace store. Long conversations can therefore multiply checkpoint disk usage.
Friday retains the latest 50 active checkpoints per project; pruning removes
older or superseded entries, unreachable file snapshots, and private Git
objects.

## Restore safety

Before restore, Friday compares the current workspace with the latest recorded
post-turn tree. If files changed afterward, the normal UI restore stops instead
of overwriting them. The gateway has an explicit `force: true` option for a
client that deliberately accepts that overwrite; ordinary UI actions do not
silently force it.

Restore also refuses type changes that would replace a path containing ignored
files. Inspect and move those files yourself before retrying.

Checkpoints exclude ignored files, `.git/`, `.friday/`, global Friday state,
paths outside the workspace, and external side effects such as pushes, network
requests, database writes, and deployments. Those effects need their own
recovery procedure. Deleting a saved conversation removes its associated
checkpoints.
