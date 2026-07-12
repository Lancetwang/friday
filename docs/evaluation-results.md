# Evaluation Results

This page records one local Friday evaluation run. It is an engineering baseline, not an official leaderboard submission.

## Protocol

- Date: 2026-07-12
- Model: `deepseek/deepseek-v4-flash`
- Context window: 353,000 tokens
- Sample: 10 cases from each of six public benchmarks, selected with seed 0
- Execution: the real Friday CLI and harness, with one workspace per case

HumanEval and MBPP were graded with executable benchmark tests outside the agent workspace. BrowseComp used its published judge prompt. LongMemEval, GAIA, and AssistantBench used a recorded model-based semantic judge, so their scores are diagnostic.

## Results

| Benchmark | Passed | Failed | Timeout or unscored | End-to-end pass rate |
| --- | ---: | ---: | ---: | ---: |
| HumanEval | 10 | 0 | 0 | 100% |
| MBPP | 10 | 0 | 0 | 100% |
| LongMemEval Oracle | 10 | 0 | 0 | 100% |
| GAIA | 4 | 4 | 2 | 40% |
| AssistantBench | 1 | 1 | 8 | 10% |
| BrowseComp | 4 | 5 | 1 | 40% |
| **Overall** | **39** | **10** | **11** | **65%** |

The raw scored-only accuracy was `39/49 = 79.59%`, but that excludes all timeout and unscored cases. The end-to-end `39/60 = 65%` result better represents task completion.

One GAIA answer was semantically equivalent to the reference, but the judge exhausted its output budget before emitting a verdict. The immutable raw result remains failed. Counting that adjudicated case gives `40/60 = 66.67%`. The local runner was corrected to record a missing verdict as unscored rather than false.

## Runtime Cost

| Benchmark | Model calls | Tool calls | Input tokens | Output tokens | Elapsed sum |
| --- | ---: | ---: | ---: | ---: | ---: |
| HumanEval | 46 | 36 | 307,951 | 18,595 | 191.83s |
| MBPP | 41 | 31 | 244,996 | 10,479 | 122.13s |
| LongMemEval | 10 | 0 | 80,288 | 2,176 | 35.18s |
| GAIA | 403 | 429 | 28,396,344 | 238,309 | 3,375.51s |
| AssistantBench | 163 | 328 | 5,362,657 | 50,735 | 1,705.60s |
| BrowseComp | 444 | 585 | 47,289,677 | 205,198 | 4,046.41s |
| **Total** | **1,107** | **1,409** | **81,681,913** | **525,492** | **9,476.66s** |

WebSearch accounted for 811 tool calls, followed by Bash with 265 and WebFetch with 231. Prefix cache hit rates reached 89.8% to 97.3% on the long research suites. Caching reduced repeated-prefix cost, but did not prevent unproductive research loops.

## Observations

1. The coding loop was the strongest path. HumanEval and MBPP both passed all executable tests with comparatively few model and tool calls.
2. Open-web research lacked progress control. Several failed BrowseComp cases used 57 to 83 searches and millions of input tokens before returning a wrong answer or timing out.
3. Visual and document tasks exposed a capability gap. Two GAIA timeouts involved screenshots or OCR, and one image-math task returned an incorrect result.
4. AssistantBench exposed abrupt deadline handling. Eight cases reached the 180-second limit without a best-effort final answer.
5. Some structured tool failures were recorded with `is_error: false`, including non-zero Bash exits and failed WebFetch responses. The event content remained available, but the status field was not reliable.
6. Per-case workspaces did not isolate Python dependencies. One visual task installed OCR packages into shared environments; those additions were removed after the run.

## Priorities

1. Detect research loops that repeat equivalent queries without adding evidence.
2. Add wall-time, token, model-call, and tool-call budgets that trigger synthesis before hard timeout.
3. Route image and document tasks through native inspection capabilities instead of installing ad hoc OCR stacks.
4. Derive tool error state from structured results, not only raised exceptions.
5. Isolate dependencies and normalize child-process encoding for future Windows evaluations.

## Limitations

The sample contains only ten cases per benchmark. LongMemEval Oracle supplies relevant history and therefore does not evaluate Friday's durable cross-session memory. Three suites use semantic model grading. The results measure the complete model, harness, tools, network, and evaluator configuration rather than Friday in isolation.

The local selection, responses, traces, and runner remain outside Git. This document preserves only the protocol, aggregate results, and engineering conclusions.
