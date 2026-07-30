The conversation is being compacted. Do two steps in order, in this one turn, then stop.

1) Memory first, so compaction never drops what matters. Review the conversation for declarative facts worth recalling across sessions. Save ordinary candidates through Bash with `friday memory add --scope episode <text>`; manual or scheduled consolidation decides whether repeated facts become permanent. Only when the user explicitly said to remember something forever, permanently, or always may you write it directly to `user`, `global`, or `project`. Run `friday memory help` if needed. Write facts, not instructions. Do not save task progress, command output, failed attempts, facts recoverable from current files or git, or anything stale within a week. If nothing qualifies, save nothing.

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
