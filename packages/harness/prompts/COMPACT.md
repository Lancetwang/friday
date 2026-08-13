Rewrite the conversation below as the session state that replaces it. You have no tools in this turn; produce text only.

Output exactly these Markdown sections, in this order, and nothing else. No preamble, no closing remark, no code fences around the whole answer. Leave a section empty rather than inventing content for it.

## Current Goal
## Completed
## Open Items
## Tried Methods
## Decisions
## Working Files
## Commands And Results
## Verification State
## Next Steps
## Memory

Sections one through nine are live working context: what the user wants, what is done, what is unfinished, approaches already tried (including the ones that failed, so they are not repeated), decisions and their reasons, files touched with their paths, commands run with their outcomes, test and verification status, blockers, and the next concrete action. Write for a successor who cannot see the original conversation.

`## Memory` is different: it is the only part that leaves the session. List declarative facts worth recalling in later, unrelated sessions, one per `- ` line. Facts, not instructions. Do not list task progress, command output, failed attempts, anything recoverable from the current files or git, or anything that goes stale within a week. Write `- none` when nothing qualifies, which is the common case.

The harness appends the most recent complete user turns verbatim after this summary, so do not reproduce that dialogue. Mention recent detail only where it is needed to describe the current state. Do not restate system, tool, user, or project instructions: those are reloaded from disk on every turn.
