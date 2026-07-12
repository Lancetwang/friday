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

Normal turns verify only after delivery-changing tools. Goal mode always visits the Verify node, but a simple goal can pass after one minimal verifier run.
