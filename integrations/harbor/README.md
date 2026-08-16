# Harbor / Terminal-Bench

Friday itself is TypeScript. This directory contains only the thin Python class
required by Harbor's current custom-agent API; it installs and invokes the same
`friday run` command used by any other evaluator.

From a Harbor checkout or project that can import this repository:

```bash
harbor run \
  -d terminal-bench/terminal-bench-2-1 \
  -m openai/gpt-5 \
  --agent integrations.harbor.friday:FridayAgent
```

The adapter installs the stable npm package by default. Pin or replace that
package without changing the adapter:

```bash
harbor run ... \
  --agent integrations.harbor.friday:FridayAgent \
  --ae FRIDAY_NPM_SPEC=friday-agent@0.8.1
```

Friday writes Harbor's `/logs/agent/trajectory.json` directly in ATIF-v1.7.
