import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { atif, parseArgs } from './cli.js'
import { GatewayClient } from './gatewayClient.js'
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

test('parses one run deadline and a separate finishing reserve', () => {
  const options = parseArgs(['run', '--timeout-seconds', '900', '--finish-reserve-seconds', '90', 'finish', 'it'])
  assert.equal(options.timeoutSeconds, 900)
  assert.equal(options.finishReserveSeconds, 90)
  assert.equal(parseArgs(['run', '--timeout-seconds', '900', '--finish-reserve-seconds', '0', 'finish']).finishReserveSeconds, 0)
  assert.throws(() => parseArgs(['run', '--finish-reserve-seconds', '90', 'finish']), /requires --timeout-seconds/)
  assert.throws(() => parseArgs(['run', '--timeout-seconds', '60', '--finish-reserve-seconds', '60', 'finish']), /must be smaller/)
  assert.throws(() => parseArgs(['run', '--timeout-seconds', '60', '--finish-reserve-seconds', '-1', 'finish']), /non-negative integer/)
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

test('gateway close waits for graceful stdin shutdown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'friday-cli-close-'))
  const entry = join(root, 'gateway.mjs')
  const previous = process.env.FRIDAY_GATEWAY_ENTRY
  await writeFile(entry, "process.stdin.resume(); process.stdin.once('end',()=>setTimeout(()=>process.exit(0),75));\n")
  process.env.FRIDAY_GATEWAY_ENTRY = entry
  const gateway = new GatewayClient()
  let exited = false
  gateway.once('exit', () => { exited = true })
  try {
    gateway.start()
    const started = performance.now()
    await gateway.close(1_000)
    assert.equal(exited, true)
    assert(performance.now() - started >= 50)
    assert(performance.now() - started < 1_000)
  } finally {
    gateway.kill()
    if (previous === undefined) delete process.env.FRIDAY_GATEWAY_ENTRY
    else process.env.FRIDAY_GATEWAY_ENTRY = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('a signalled headless process keeps its latest trajectory and exits 130', async () => {
  const root = await mkdtemp(join(tmpdir(), 'friday-cli-signal-'))
  const entry = join(root, 'gateway.mjs')
  const runner = join(root, 'runner.mjs')
  const trajectory = join(root, 'trajectory.json')
  await writeFile(entry, fakeGateway())
  const cli = fileURLToPath(new URL('./entry.js', import.meta.url))
  await writeFile(runner, signalRunner(cli, root, trajectory))
  const child = spawn(process.execPath, [runner], {
    env: { ...process.env, FRIDAY_GATEWAY_ENTRY: entry },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  try {
    const code = await new Promise<number | null>((resolveExit, rejectExit) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        rejectExit(new Error('Timed out waiting for headless CLI exit.'))
      }, 3_000)
      child.once('error', rejectExit)
      child.once('exit', value => {
        clearTimeout(timer)
        resolveExit(value)
      })
    })

    assert.equal(code, 130, stderr)
    const result = JSON.parse(stdout) as Record<string, unknown>
    assert.equal(result.stop_reason, 'cancelled')
    assert.equal(result.text, 'partial-before-signal')
    const saved = JSON.parse(await readFile(trajectory, 'utf8')) as Record<string, unknown>
    assert.equal((saved.extra as Record<string, unknown>).stop_reason, 'cancelled')
    assert.match(JSON.stringify(saved), /observed-before-signal/)
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
    await rm(root, { recursive: true, force: true })
  }
})

function fakeGateway(): string {
  return `
import { createInterface } from 'node:readline'
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
let chat = ''
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
for await (const line of input) {
  const request = JSON.parse(line)
  if (request.method === 'permission.set') send({ jsonrpc: '2.0', id: request.id, result: { permission_mode: 'bypass' } })
  else if (request.method === 'session.info') send({ jsonrpc: '2.0', id: request.id, result: { cwd: process.cwd(), model: 'fake', model_name: 'fake', permission_mode: 'bypass', thinking_effort: 'off', tools: [], session_id: 'fake-session' } })
  else if (request.method === 'chat.send') {
    chat = request.id
    send({ jsonrpc: '2.0', method: 'event', params: { type: 'message.delta', payload: { text: 'partial-before-signal', session_id: 'fake-session' } } })
    send({ jsonrpc: '2.0', method: 'event', params: { type: 'tool.start', payload: { name: 'Read', tool_call_id: 'call-1', arguments: { path: 'README.md' }, session_id: 'fake-session' } } })
    send({ jsonrpc: '2.0', method: 'event', params: { type: 'tool.complete', payload: { name: 'Read', tool_call_id: 'call-1', content: 'observed-before-signal', session_id: 'fake-session' } } })
  } else if (request.method === 'chat.cancel') {
    send({ jsonrpc: '2.0', id: chat, result: { cancelled: true, text: '', stop_reason: 'cancelled', session_id: 'fake-session' } })
    send({ jsonrpc: '2.0', id: request.id, result: { cancelled: true, session_id: 'fake-session' } })
  }
}
`
}

function signalRunner(cli: string, workspace: string, trajectory: string): string {
  return `
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
const { headless, parseArgs } = await import(pathToFileURL(${JSON.stringify(cli)}).href.replace(/entry\\.js$/, 'cli.js'))
const pending = headless(parseArgs(['run', '--cwd', ${JSON.stringify(workspace)}, '--trajectory', ${JSON.stringify(trajectory)}, '--json', '--', 'keep partial evidence']))
const deadline = Date.now() + 2000
while (!(await readFile(${JSON.stringify(trajectory)}, 'utf8').catch(() => '')).includes('observed-before-signal')) {
  if (Date.now() >= deadline) throw new Error('trajectory was not updated')
  await new Promise(resolve => setTimeout(resolve, 20))
}
process.emit('SIGTERM', 'SIGTERM')
process.exitCode = await pending
`
}
