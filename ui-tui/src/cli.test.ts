import assert from 'node:assert/strict'
import test from 'node:test'

import { atif, parseArgs } from './cli.js'
import type { GatewayEvent, SessionInfo } from './types.js'

const info: SessionInfo = {
  cwd: '/work',
  model: 'openai',
  model_name: 'gpt-test',
  permission_mode: 'bypass',
  thinking_effort: 'medium',
  tools: ['shell']
}

test('defaults to the interactive TUI', () => {
  assert.equal(parseArgs([]).command, 'tui')
  assert.equal(parseArgs(['--cwd', '/work']).command, 'tui')
})

test('parses a headless evaluation run', () => {
  assert.deepEqual(parseArgs(['run', '--trajectory', '/logs/agent/trajectory.json', '--', 'fix', 'it']), {
    command: 'run',
    json: false,
    permissionMode: 'bypass',
    stdin: false,
    text: 'fix it',
    trajectory: '/logs/agent/trajectory.json'
  })
})

test('writes a sequential ATIF trajectory', () => {
  const events: Array<{ event: GatewayEvent; timestamp: string }> = [
    {
      event: { type: 'tool.start', payload: { tool_call_id: 'call-1', name: 'shell', arguments: { command: 'pwd' } } },
      timestamp: '2026-08-13T00:00:01.000Z'
    },
    {
      event: { type: 'tool.complete', payload: { tool_call_id: 'call-1', name: 'shell', content: '/work' } },
      timestamp: '2026-08-13T00:00:02.000Z'
    },
    {
      event: { type: 'message.complete', payload: { text: 'done', metrics: { input_tokens: 10, output_tokens: 2, requests: 1 } } },
      timestamp: '2026-08-13T00:00:03.000Z'
    }
  ]

  const trajectory = atif('inspect the workspace', info, events, { session_id: 'session-1', text: 'done' }) as {
    schema_version: string
    steps: Array<Record<string, unknown>>
    final_metrics: Record<string, unknown>
  }
  assert.equal(trajectory.schema_version, 'ATIF-v1.7')
  assert.deepEqual(trajectory.steps.map((step) => step.step_id), [1, 2, 3])
  assert.equal(trajectory.steps[1]?.source, 'agent')
  assert.equal(trajectory.steps[2]?.message, 'done')
  assert.equal(trajectory.final_metrics.total_prompt_tokens, 10)
})
