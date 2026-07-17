The conversation is being compacted. Do two steps in order, in this one turn, then stop.

1) Durable memory first, so compaction never drops what matters. Review the conversation for durable, declarative facts worth keeping across sessions: stable user preferences, environment details, conventions, and lasting project decisions. Save each through Bash with `friday memory add --scope user|global|project <text>`; run `friday memory help` if needed. Write facts, not instructions. Do not save task progress, command output, failed attempts, or anything stale within a week. If nothing qualifies, save nothing.

2) Then send your final message as the short-term session state only, using this exact Markdown structure:
## Current Goal
## Completed
## Open Items
## Tried Methods
## Decisions
## Working Files
## Commands And Results
## Verification State
## Next Steps

Keep only live working context: user goals, completed work, unfinished work, tried methods, decisions, files touched, commands run, test status, blockers, and next steps.
The harness will append the latest 10 complete user turns and their assistant/tool messages verbatim after this summary. Do not reproduce that dialogue in the summary; mention recent details only when they are needed to describe the current state.
Your final message must contain the session state only; no preamble, no memory notes, and do not restate stable system, tool, user, or project instructions.
