# Verification

Friday keeps verification independent from the main agent. The verifier receives the original goal, workspace, and changed-path hints, but not the main agent's natural-language claims. It inspects the deliverable itself.

The verifier works as a challenger rather than a confirmer. It first derives acceptance criteria from the original goal alone, then tries to falsify each one, choosing the check most likely to expose a failure over the check most likely to confirm success. A criterion passes only after surviving that attempt. The goal is constant across attempts, so the derived criteria stay constant too. Optional improvements, stylistic preferences, and invented requirements can neither fail the deliverable nor trigger repair, which is what keeps challenge strength from becoming scope creep.

## Verdicts

| Verdict | Meaning | Loop action |
| --- | --- | --- |
| `pass` | Explicit criteria have independent evidence. | Finish |
| `repair` | A concrete requirement is unmet and a specific next check can address it. | Run the main agent again |
| `blocked` | Workspace or external conditions prevent completion. | Stop with evidence |
| `inconclusive` | Evidence is insufficient and no useful new check is available. | Stop without inventing an answer |

Only `repair` can continue the loop. It must include `next_check`; vague feedback is downgraded to `inconclusive`.

## Gates

Friday fingerprints exact tool name/argument pairs separately from their results, without volatile call IDs. The same call appearing three times in one batch triggers corrective feedback; across rounds, the call and result must match in each of the latest three tool rounds. Repeating it with the same result after that warning forces one final answer without tools. Across repair attempts, repeating both the same delivery trajectory and the same repair request stops with `no_progress`.

A run has no small task-level attempt cap and no spend ceiling. It ends when the work is done, when it stops making progress, or when the context window can no longer be made to fit. The runtime call still carries a 10,000-step fault fuse so a broken graph cannot execute forever; ordinary work is expected to stop through semantic conditions long before it. Neither the number of requests nor their cumulative token usage may otherwise end a run: because every step re-sends the conversation, cumulative usage grows with the square of the step count and crosses any fixed ceiling while the window is still mostly empty. Both figures are recorded for the trace and the cost shown in the UIs, and compared against nothing.

The window is therefore the only normal resource bound, and compaction is what keeps it from being reached. At 85% occupancy the guard first probes every uncompacted tool result and only applies the lossless pass when it would reclaim at least 25% of the current prompt. Otherwise it rewrites the conversation in place as a structured summary plus the largest complete recent tool-cycle tail that fits. Only a window that neither pass can bring back under 85% gives the active Agent one final answer without tools. The answer, verification evidence, and stop reason remain in the trace.

Normal turns verify only after delivery-changing tools. A concrete repair can repeat without a fixed attempt cap; pass, blockage, insufficient evidence, approval, or repeated no-progress ends the loop. Goal mode always visits the Verify node, keeps the original objective in every repair prompt, and requires verifier pass before reporting completion. A simple goal yields few derived criteria, so it can still pass after one short verifier run.

The verifier retains Bash because executable checks, builds, tests, and runtime behavior cannot be established by reading alone. Its independence is epistemic: it receives the original request and delivery hints rather than the main agent's claims, and its prompt forbids modifying the deliverable. Friday does not claim that removing Write/Edit would create a read-only boundary because shell commands can also write.

## Task continuity

During one active run, the outer loop tracks the original request, attempt count, latest verifier feedback and next check, repeated attempt and repair signatures, approval state, and cumulative Token usage. Every repair prompt repeats the original request so later attempts do not rely on recalling only the first message.

Conversation history, tool observations, and verification feedback remain in one shared `RunContext`; Friday does not create per-task contexts. A session-scoped progress snapshot separately records the current objective, plan, status, next action, and verifier verdict. `UpdatePlan`, loop completion, approval waits, and semantic stops update that snapshot and emit trace events.

At context pressure between turns, Friday rebuilds the model input as the fresh stable prefix, structured summary, the largest complete recent tail that fits (up to ten user turns), and one current progress checkpoint. Session snapshots persist both messages and progress for `resume`. Resume does not automatically execute an interrupted `/goal` or recover its in-memory attempt counter; it restores the evidence and next action so continuation is explicit and safe.
