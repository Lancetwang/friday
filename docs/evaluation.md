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

The file follows ATIF-v1.7 and records user input, tool calls and observations,
the final response, model identity, and available token metrics. `friday run`
uses bypass mode; run it only in the evaluator's isolated container. Use
`--permission-mode auto` to retain Friday's independent command review.

## Terminal-Bench 2.1 with Harbor

Harbor is the official Terminal-Bench harness. It currently exposes custom
agents as Python classes, so `integrations/harbor/friday.py` is a small protocol
adapter. It installs and calls the TypeScript `friday` package; Python is not a
Friday runtime dependency.

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
  --ae FRIDAY_NPM_SPEC=friday-agent@0.8.2
```

For reproducible results, also pin Harbor, the model, task dataset, environment,
and Friday version. Validate a produced trajectory with Harbor:

```bash
python -m harbor.utils.trajectory_validator /path/to/trajectory.json
```
