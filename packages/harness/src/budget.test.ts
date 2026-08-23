import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

process.env.FRIDAY_AUTOTITLE = '0'

import { RunBudget } from './budget.js'
import { Gateway } from './gateway.js'

test('a run budget stops tools before its hard deadline', async () => {
  const hard = new AbortController()
  const budget = new RunBudget({ deadlineMs: Date.now() + 400, reserveMs: 250 }, hard)
  try {
    await aborted(budget.toolSignal)
    assert.equal(budget.finalizing, true)
    assert.equal(hard.signal.aborted, false)
    await aborted(hard.signal)
    assert.equal((hard.signal.reason as Error).name, 'TimeoutError')
  } finally {
    budget.dispose()
  }
})

test('the gateway uses the finishing reserve for a final model response after stopping a tool', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'friday-budget-'))
  const home = join(temporary, 'home')
  const workspace = join(temporary, 'workspace')
  await mkdir(home)
  await mkdir(workspace)
  const previousHome = process.env.FRIDAY_HOME
  process.env.FRIDAY_HOME = home
  let requests = 0
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    requests += 1
    if (requests === 1) {
      const command = `${process.platform === 'win32' ? '& ' : ''}${JSON.stringify(process.execPath)} -e "setTimeout(()=>{},30000)"`
      sse(response, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'slow', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command, timeout_seconds: 30 }) } }] } }] })
      sse(response, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
    } else if (requests === 2) {
      sse(response, { choices: [{ delta: { content: 'Stopped work and returned the supported result.' } }] })
      sse(response, { choices: [{ delta: {}, finish_reason: 'stop' }] })
    } else {
      sse(response, { choices: [{ delta: { reasoning_content: 'still working' } }] })
      return
    }
    response.end('data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  const output: Array<Record<string, unknown>> = []
  let gateway: Gateway | undefined
  try {
    await writeFile(join(home, 'models.json'), JSON.stringify({
      active: 'local',
      profiles: [{
        id: 'local', name: 'Local', provider: 'openai-compatible', model: 'mock',
        base_url: `http://127.0.0.1:${address.port}`, context_window: 100_000,
        max_output_tokens: 2_000, vision: false
      }]
    }))
    await writeFile(join(home, 'model-credentials.json'), JSON.stringify({ local: 'secret' }))
    gateway = new Gateway(workspace, value => output.push(value as Record<string, unknown>))
    await gateway.start()
    await gateway.handle({ id: 'permission', method: 'permission.set', params: { mode: 'bypass' } })

    await gateway.handle({
      id: 'chat', method: 'chat.send',
      params: { text: 'do bounded work', run: { timeout_ms: 3_000, reserve_ms: 2_500 } }
    })

    const response = output.find(item => item.id === 'chat') as { result?: Record<string, unknown> } | undefined
    assert.equal(response?.result?.text, 'Stopped work and returned the supported result.')
    assert.equal(response?.result?.stop_reason, 'deadline')
    assert.deepEqual(response?.result?.termination, { reason: 'stop' })
    assert.equal(requests, 2)

    await gateway.handle({
      id: 'deadline', method: 'chat.send',
      params: { text: 'this model never finishes', run: { timeout_ms: 200, reserve_ms: 50 } }
    })
    const deadline = output.find(item => item.id === 'deadline') as { result?: Record<string, unknown> } | undefined
    assert.deepEqual(deadline?.result, {
      cancelled: true,
      text: '',
      stop_reason: 'deadline',
      session_id: response?.result?.session_id
    })
    assert.equal(requests, 3)
  } finally {
    await gateway?.close()
    if (previousHome === undefined) delete process.env.FRIDAY_HOME
    else process.env.FRIDAY_HOME = previousHome
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(temporary, { recursive: true, force: true })
  }
})

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
}

function sse(response: ServerResponse, value: unknown): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`)
}
