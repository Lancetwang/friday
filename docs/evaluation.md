# Evaluations

Friday exposes a process-level evaluation contract; it does not couple its core
to a benchmark harness.

## Generic sandbox

Install the full package in the sandbox and invoke one headless turn:

```bash
npm install --global friday-agent
friday run --cwd /workspace --json -- "Complete the task"
```

For trace-based evaluators, add:

```bash
--trajectory /logs/agent/trajectory.json
```

Give Friday the evaluator's wall-clock budget when one is available:

```bash
friday run --timeout-seconds 900 --finish-reserve-seconds 90 \
  --cwd /workspace --trajectory /logs/agent/trajectory.json -- "Complete the task"
```

This is a generic process contract, not benchmark policy. One absolute deadline
covers model calls and tools. Tool work stops at the reserve boundary so the
same model can summarize evidence and persist state before the hard stop. If
`--finish-reserve-seconds` is omitted, Friday chooses up to 90 seconds (20% for
shorter runs). Set it to `0` when the evaluator owns finalization and tools should
use the entire hard deadline. Trajectory snapshots are replaced atomically throughout
the run.

The file follows ATIF-v1.7 and records user input, tool calls and observations,
the final response, model identity, and available token metrics. `friday run`
uses bypass mode; run it only in the evaluator's isolated container. Use
`--permission-mode auto` to retain Friday's independent command review.

## Terminal-Bench 2.1 with Harbor

Harbor is the official Terminal-Bench harness. It currently exposes custom
agents as Python classes, so `integrations/harbor/friday.py` is a small protocol
adapter. It installs and calls the TypeScript `friday` package; Python is not a
Friday runtime dependency.

The adapter maps Terminal-Bench's canonical `You have N seconds` instruction
suffix to `--timeout-seconds N`. `FRIDAY_RUN_TIMEOUT_SECONDS` can override that
mapping, and `FRIDAY_FINISH_RESERVE_SECONDS` can set the reserve explicitly.
No Terminal-Bench task, verifier, or answer rule enters Core or Harness.

```bash
uv tool install harbor
harbor run \
  -d terminal-bench/terminal-bench-2-1 \
  -m openai/gpt-5 \
  --agent integrations.harbor.friday:FridayAgent
```

The adapter installs Friday from npm. Pin the exact package supplied to every
trial:

```bash
harbor run ... \
  --agent integrations.harbor.friday:FridayAgent \
  --ae FRIDAY_NPM_SPEC=friday-agent@0.8.6
```

For reproducible results, also pin Harbor, the model, task dataset, environment,
and Friday version. Validate a produced trajectory with Harbor:

```bash
python -m harbor.utils.trajectory_validator /path/to/trajectory.json
```
