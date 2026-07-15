# Verification

Friday keeps verification independent from the main agent. The verifier receives the original goal, workspace, and changed-path hints, but not the main agent's natural-language claims. It inspects the deliverable itself.

The verifier scales its work to the explicit acceptance criteria. A simple text deliverable may need one read. Executable or multi-file work may need targeted commands. Optional improvements, stylistic preferences, and invented requirements cannot trigger repair.

## Verdicts

| Verdict | Meaning | Loop action |
| --- | --- | --- |
| `pass` | Explicit criteria have independent evidence. | Finish |
| `repair` | A concrete requirement is unmet and a specific next check can address it. | Run the main agent again |
| `blocked` | Workspace or external conditions prevent completion. | Stop with evidence |
| `inconclusive` | Evidence is insufficient and no useful new check is available. | Stop without inventing an answer |

Only `repair` can continue the loop. It must include `next_check`; vague feedback is downgraded to `inconclusive`.

## Gates

Friday fingerprints normalized tool calls and results without volatile call IDs. Repeating an identical tool cycle forces one final answer without tools. Across repair attempts, repeating both the same delivery trajectory and the same repair request stops with `no_progress`.

The main agent, verifier, and repairs share `run_token_budget`. Once exact provider usage reaches 85% of that budget, the active Agent gets one final answer without tools and Friday does not start another repair. The current answer, verification evidence, and stop reason remain in the trace.

Normal turns verify only after delivery-changing tools. A concrete repair can repeat without a fixed attempt cap; pass, blockage, insufficient evidence, approval, repeated no-progress, or the shared Token Budget ends the loop. Goal mode always visits the Verify node, keeps the original objective in every repair prompt, and requires verifier pass before reporting completion. A simple goal can still pass after one minimal verifier run.

The verifier retains Bash because executable checks, builds, tests, and runtime behavior cannot be established by reading alone. Its independence is epistemic: it receives the original request and delivery hints rather than the main agent's claims, and its prompt forbids modifying the deliverable. Friday does not claim that removing Write/Edit would create a read-only boundary because shell commands can also write.

## Task continuity

During one active run, the outer loop tracks the original request, attempt count, latest verifier feedback and next check, repeated attempt and repair signatures, approval state, and cumulative Token usage. Every repair prompt repeats the original request so later attempts do not rely on recalling only the first message.

Conversation history, tool observations, and verification feedback remain in one shared `RunContext`; Friday does not create per-task contexts. A session-scoped progress snapshot separately records the current objective, plan, status, next action, and verifier verdict. `UpdatePlan`, loop completion, approval waits, and semantic stops update that snapshot and emit trace events.

At context pressure, Friday rebuilds the model input as the fresh stable prefix, structured summary, latest ten complete turns, and one current progress checkpoint. Session snapshots persist both messages and progress for `resume`. Resume does not automatically execute an interrupted `/goal` or recover its in-memory attempt counter; it restores the evidence and next action so continuation is explicit and safe.
