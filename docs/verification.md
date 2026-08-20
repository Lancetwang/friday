# Verification, Run Guards, and Compaction

Friday has two different forms of checking:

- Every Agent turn is instructed to inspect evidence and validate changed work
  before answering.
- `friday goal` adds a separate model-driven verifier after the main Agent
  finishes. Ordinary chat, `friday ask`, and the default `friday run` path do
  not invoke this independent verifier.

## Independent Goal verification

The verifier starts with a fresh `RunContext`. It receives the original goal,
the workspace and operating environment, up to four earlier public user
requirements for acceptance context, and bounded delivery hints derived from
recent `Write`, `Edit`, and `Bash` calls. It does not receive the main Agent's
answer or natural-language claim that the work is complete.

Its prompt asks it to derive acceptance criteria from the user goal, challenge
each criterion, and avoid inventing requirements. The available built-in tools
are `Read`, `Glob`, `Grep`, and a mutation-filtered `Bash`; enabled `web` and
`skills` packs can additionally contribute `WebSearch`, `WebFetch`, and `Skill`.
External plugins never enter the verifier. Bash filtering rejects common
mutation commands, but it is command policy, not an operating-system read-only
sandbox.

### Verdicts

| Verdict | Meaning | Goal-loop action |
| --- | --- | --- |
| `pass` | The requested criteria survived the verifier's checks. | Finish |
| `repair` | A concrete requirement failed and `next_check` names a useful follow-up. | Ask the main Agent to repair |
| `blocked` | Workspace or external conditions prevent completion. | Stop |
| `inconclusive` | Evidence is insufficient and no useful next check is available. | Stop |

Only `repair` continues the loop. A repair without `next_check` is converted to
`inconclusive`. Every repair prompt repeats the original goal, verifier feedback,
and next check. A Goal run performs at most six Agent/Verifier attempts.
Approval suspension pauses it for the user's decision. Passing, blocking or
inconclusive evidence, cancellation, repeated no-progress, verifier error, or
the sixth failed attempt stops it.

## Runtime limits and no-progress guard

Limits are fault containment, not spend budgets:

| Scope | Current bound |
| --- | ---: |
| One main-Agent invocation | 100 model steps |
| One verifier invocation | 40 model steps |
| One Goal run | 6 verification attempts |
| Parallel tool batch | 4 explicitly parallel-safe calls at a time |

`run_token_budget` remains accepted in configuration for compatibility and is
not enforced. Provider input, output, request, and cache totals are recorded as
usage; they do not stop a turn. A provider can still reject a request whose
configured context or output limits exceed its real capabilities.

The Core fingerprints tool name and normalized arguments separately from the
result. The same call appearing three times in one model response, or the same
call returning the same result in each of the latest three tool rounds, adds a
warning. Repeating that unchanged call and result after the warning disables
tools and asks for one final supported answer. Across Goal repairs, repeating
both the same delivery-event signature and the same repair request stops with
`no_progress`.

## Context measurement

Context occupancy includes the current message array and all active tool
schemas. After a normal provider response, Friday anchors the estimate to that
response's exact prompt-token count. Until the next response, it adds or
subtracts a local delta at approximately four serialized characters per token.
Before the first usable provider count, the whole prompt uses that local
estimate. Cumulative input-token spend is never treated as current occupancy.

## Compaction

The main Agent checks occupancy before every model step. At 85% of the
configured window it compacts automatically; `/compact` forces the same path
between turns. There is no separate tool-result compaction pass.

Friday tries three summary strategies in order:

1. **Insert.** When the current prompt, a 2,000-token allowance for the compact
   instruction, and the configured maximum output can fit together, Friday
   appends one compact instruction to the complete live conversation. It sends
   the same tool schemas with `tool_choice: none`, preserving the provider's
   reusable prompt prefix while making this request text-only.
2. **Bounded transcript.** If insert lacks headroom or fails, Friday makes a
   fresh two-message summary request from at most 120,000 transcript characters.
   Each user message can contribute up to 8,000 characters; other messages
   contribute up to 2,000.
3. **Offline summary.** If the model summary also fails, Friday writes a minimal
   local summary so model failure does not itself block the Agent Loop.

The replacement keeps the existing system prefix, one structured session
summary, and the largest recent complete replay that fits the remaining budget.
The target is 55% of the configured window after accounting for the prefix,
tool schemas, and summary; it is a target rather than a guarantee, because
Friday retains a minimum replay even when that replay alone exceeds the target.
During an active tool loop, Friday preserves the latest public request and as
many recent assistant/tool cycles as fit. Otherwise it tries recent tails of
10, 6, 3, 2, and 1 public user turns.

Messages removed from the model prompt are archived in the session. The UI,
resume, and fork history therefore retain the original conversation even though
the model reads the compacted state. If the rebuilt prompt is still at or above
85%, the main Agent receives one final step with tools disabled and must report
the best supported result and unresolved items.

The verifier uses its own fresh bounded run and does not share the main
session's compaction state.

## Progress and resume

The Harness stores the current objective, plan, status, next action, and latest
verifier summary in `RunContext.artifacts` and in the session snapshot. Progress
is UI and recovery state; it is not inserted as a standalone model message.
Model continuity comes from the persisted conversation, tool observations, and
any compact summary already present in that conversation.

Loading a saved session restores its messages and progress but does not
automatically restart an interrupted Goal. A turn suspended for approval is
different: after the decision, Friday resumes that same turn and returns an
active Goal to verification, using the saved verification attempt when present.
