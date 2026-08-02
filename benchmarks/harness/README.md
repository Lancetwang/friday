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
