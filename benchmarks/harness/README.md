# Friday Harness Benchmark

This is a small local regression benchmark for Friday's shared `FridaySession`
Harness. It is not an external leaderboard. The 50 text-only cases cover
workspace work, code repair, multi-turn continuity, goal verification,
instruction handling, approvals, and session recovery.

```powershell
uv run python benchmarks/harness/run.py --validate
uv run python benchmarks/harness/run.py
uv run python benchmarks/harness/run.py --category state
uv run python benchmarks/harness/run.py --case approval-01
```

Each case runs under an opaque temporary root with an isolated Friday home, so
the model cannot infer case definitions or inspect neighboring results. Only
model configuration and credentials are copied; personal rules and memory are
excluded. Checks are deterministic file, JSON, process, response, or state
assertions. Results and full Friday traces remain under `runs/` for local failure
analysis and are not committed. Workspace paths in `results.json` locate the
temporary artifacts for deeper inspection.

## Reference run

Local run on 2026-08-02 with `deepseek/deepseek-v4-flash`, thinking `high`:

| Cases | Behavioral pass | Requests | Input tokens | Output tokens | Time |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 50 | 50 | 421 | 1,382,733 | 69,278 | 15m 30s |

The full run reported 49/50 before the JSON evaluator was corrected to accept
UTF-8 BOM from Windows PowerShell; the affected injection-safety case passed on
immediate re-evaluation. All provider token counts were exact.

The run found and fixed two Harness defects: explicit compaction crashed when a
session had fewer than ten user turns, and guidance entered after rejecting an
approval was represented as untrusted tool data instead of user input. Giving
the independent verifier recent user requirements as acceptance context reduced
a three-turn state update from 32 model requests to 13 without exposing the
executor's claims. Opaque execution roots also stopped the model from detecting
and inspecting neighboring benchmark results.

## Representative external-inspired suite

The repository also contains `representative_cases.jsonl`, a small composite
suite built from public benchmark patterns. It is deliberately not an official
WildClawBench, ALFWorld, SWE-bench, or GAIA score: the original environments,
datasets, and graders are not copied here. Each case carries a `source` and
`source_url` label, and adapts the underlying capability to Friday's Windows
Harness with local files and deterministic checks.

The suite currently has 25 cases:

- `wildclawbench-inspired`: multi-step agency, source conflict resolution,
  long-horizon synthesis, undocumented code, prompt injection, and credential
  redaction.
- `alfworld-inspired`: six stateful household patterns: pick/place, clean,
  heat, cool, pick-two, and examine-under-light. These use a symbolic JSON
  scene rather than the ALFWorld TextWorld/THOR simulator.
- `swe-bench-inspired`: issue-style fixes with hidden regression checks,
  including falsey cache values, retry semantics, deep config merge, CLI exit
  codes, path traversal, and stable event ordering.
- `gaia-inspired`: evidence-driven assistant tasks with arithmetic,
  multi-source conflicts, constraint filtering, batch aggregation, and concise
  answer files. Network-dependent questions are intentionally excluded so the
  result is reproducible without Docker or a live website.

Validate or run it with:

```powershell
uv run python benchmarks/harness/run.py --cases benchmarks/harness/representative_cases.jsonl --validate
uv run python benchmarks/harness/run.py --cases benchmarks/harness/representative_cases.jsonl --case wc-safety-01
uv run python benchmarks/harness/run.py --cases benchmarks/harness/representative_cases.jsonl
```

The runner reports both `categories` and `sources` in `results.json`. A case is
passed only when Friday completes without an exception and every deterministic
file, JSON, Python, or response assertion passes; no LLM judge is used.

The source designs are documented by [WildClawBench](https://github.com/InternLM/WildClawBench),
[ALFWorld](https://github.com/alfworld/alfworld), [SWE-bench Verified](https://openai.com/index/introducing-swe-bench-verified/),
and [GAIA](https://arxiv.org/abs/2311.12983). Their official scores must not be
inferred from this local adapted suite.

### Representative run

On 2026-08-02, the first full run completed 20/25 cases. Inspection of the five
failures showed that Friday had produced the correct artifacts, while the local
checks were too literal about date formatting, report wording, CSV labels, and
redaction spelling. After correcting those checks, the five cases were rerun and
all passed:

| Source-inspired group | Cases | Corrected pass |
| --- | ---: | ---: |
| WildClawBench | 6 | 6/6 |
| ALFWorld | 6 | 6/6 |
| SWE-bench | 6 | 6/6 |
| GAIA | 7 | 7/7 |

The initial 25-case run used 226 requests, 943,527 input tokens, and 69,085
output tokens. The five-case evaluator recheck used 40 additional requests,
132,228 input tokens, and 9,786 output tokens. These are provider-reported
usage values; the recheck is reported separately so it is not presented as a
single clean 25-case run.
