# Checkpoints

Friday creates one checkpoint before each user turn. The checkpoint covers:

- non-ignored files inside the current workspace;
- the conversation state before the turn;
- the current objective, plan, and progress;
- an approval continuation as part of its original user turn.

Use the latest checkpoint:

```powershell
friday undo
```

List or restore an older checkpoint:

```powershell
friday checkpoint list
friday checkpoint restore <checkpoint-id>
```

CLI chat and the TUI expose the same latest-turn operation as `/undo`. Restoring
an older checkpoint also supersedes newer checkpoints because workspace history
is linear.

## Storage And Safety

File snapshots use a separate content-addressed Git object store under
`~/.friday/checkpoints/`; Friday never changes the workspace's `.git` index,
branch, commits, or stash. Conversation content is reused from the append-only
trace object store instead of being copied into every checkpoint.

Before restoring, Friday compares the workspace with the state recorded after
its latest turn. If files changed afterward, restore stops instead of
overwriting them. Inspect those files first or explicitly use `--force`.

Checkpoints do not include ignored files, `.git/`, `.friday/`, global Friday
state, paths outside the workspace, or external side effects such as pushes,
network requests, database writes, and deployed resources. Those operations
remain subject to approval and require their own compensating action.
