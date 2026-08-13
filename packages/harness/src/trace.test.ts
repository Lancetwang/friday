import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Script } from 'node:vm'

import { Gateway } from './gateway.js'
import { writeTrace } from './trace.js'

test('trace RPC serves local structured records and stops idempotently', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'friday-ts-trace-'))
  const home = join(temporary, 'home')
  const workspace = join(temporary, 'workspace')
  await mkdir(home)
  await mkdir(workspace)
  const previous = process.env.FRIDAY_HOME
  process.env.FRIDAY_HOME = home
  const output: unknown[] = []
  const modelRequests: Array<Record<string, unknown>> = []
  let gateway: Gateway | undefined
  let modelServer: Server | undefined
  try {
    modelServer = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      modelRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {"choices":[{"delta":{"content":"Evidence supports "}}]}\n\n')
      response.write('data: {"choices":[{"delta":{"content":"[event:1]."}}]}\n\n')
      response.end('data: [DONE]\n\n')
    })
    const modelPort = await listen(modelServer)
    await writeFile(join(home, 'models.json'), JSON.stringify({
      active: 'trace-test',
      profiles: [{
        id: 'trace-test', name: 'Trace test', provider: 'openai-compatible', model: 'mock-model',
        base_url: `http://127.0.0.1:${modelPort}/v1`, vision: false,
        context_window: 128_000, max_output_tokens: 8_192, run_token_budget: 100_000
      }]
    }))
    await writeFile(join(home, 'model-credentials.json'), JSON.stringify({ 'trace-test': 'test-only-key' }))
    await writeTrace({
      workspace, sessionId: 's1', mode: 'chat',
      user: 'inspect tvly-example-secret-12345', assistant: 'sk-example-secret-12345', status: 'done',
      events: [
        { type: 'tool.call', category: 'tool', runId: 'r1', timestamp: 1, data: { name: 'Read', arguments: { path: 'README.md' } } },
        { type: 'tool.result', category: 'tool', runId: 'r1', timestamp: 2, data: { authorization: 'Bearer private-token', content: 'API_KEY=private-key' } }
      ]
    })
    gateway = new Gateway(workspace, value => output.push(value))
    await gateway.start()
    output.length = 0
    await gateway.handle({ id: 'serve', method: 'trace.serve' })
    const url = (result(output, 'serve') as { url: string }).url
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/)
    const [page, traces] = await Promise.all([
      fetch(url).then(response => response.text()),
      fetch(`${url}/api/traces`).then(response => response.json()) as Promise<Array<Record<string, unknown>>>
    ])
    assert.match(page, /Friday Observability/)
    assert.match(page, /Turn audit/)
    assert.match(page, /Trace analyst/)
    assert.match(page, /id="analysis-form"/)
    assert.match(page, /Execution Audit/)
    assert.doesNotMatch(page, /id="detail"/)
    for (const match of page.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(match[1]!)
    assert.equal(traces[0]?.user, 'inspect [redacted]')
    assert.equal((traces[0]?.events as Array<{ type: string }>)[0]?.type, 'tool.call')
    const serialized = JSON.stringify(traces[0])
    assert(!serialized.includes('private-token'))
    assert(!serialized.includes('private-key'))
    assert(!serialized.includes('example-secret'))
    assert(serialized.includes('[redacted]'))

    const firstStream = await fetch(`${url}/api/sessions/s1/analyze/stream`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'Why did the tool run?' })
    })
    assert.equal(firstStream.status, 200)
    assert.match(firstStream.headers.get('content-type') || '', /application\/x-ndjson/)
    const firstEvents = ndjson(await firstStream.text())
    assert.deepEqual(firstEvents.filter(event => event.type === 'delta').map(event => event.delta), ['Evidence supports ', '[event:1].'])
    const firstFinal = firstEvents.find(event => event.type === 'final')
    assert(firstFinal?.analysis_id)
    assert.equal(firstFinal.answer, 'Evidence supports [event:1].')

    const secondStream = await fetch(`${url}/api/sessions/s1/analyze/stream`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'What should change?', analysis_id: firstFinal.analysis_id })
    })
    assert.equal(secondStream.status, 200)
    assert(ndjson(await secondStream.text()).some(event => event.type === 'final'))
    const analyses = await fetch(`${url}/api/sessions/s1/analyses`).then(response => response.json()) as {
      analyses: Array<{ analysis_id: string; messages: Array<{ role: string; content: string }> }>
    }
    assert.equal(analyses.analyses[0]?.analysis_id, firstFinal.analysis_id)
    assert.deepEqual(analyses.analyses[0]?.messages.map(message => message.role), ['user', 'assistant', 'user', 'assistant'])
    assert.equal(analyses.analyses[0]?.messages[0]?.content, 'Why did the tool run?')
    assert.equal(modelRequests.length, 2)
    const requestText = JSON.stringify(modelRequests)
    assert(requestText.includes('Why did the tool run?'))
    assert(requestText.includes('Evidence supports [event:1].'))
    assert(requestText.includes('[event:1]'))
    assert(requestText.includes('[redacted]'))
    assert(!requestText.includes('private-token'))
    assert(!requestText.includes('private-key'))
    assert(!requestText.includes('example-secret'))

    output.length = 0
    await gateway.handle({ id: 'stop', method: 'trace.stop' })
    await gateway.handle({ id: 'stop-again', method: 'trace.stop' })
    assert.equal((result(output, 'stop') as { stopped: boolean }).stopped, true)
    assert.equal((result(output, 'stop-again') as { stopped: boolean }).stopped, false)
  } finally {
    await gateway?.close().catch(() => {})
    if (modelServer) await close(modelServer)
    if (previous === undefined) delete process.env.FRIDAY_HOME
    else process.env.FRIDAY_HOME = previous
    await rm(temporary, { recursive: true, force: true })
  }
})

function ndjson(value: string): Array<Record<string, string>> {
  return value.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, string>)
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert(address && typeof address !== 'string')
  return address.port
}

async function close(server: Server): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()))
}

function result(output: unknown[], id: string): unknown {
  const message = output.find(value => (value as { id?: unknown }).id === id) as { result?: unknown; error?: unknown } | undefined
  assert(message && !message.error, `Missing successful response ${id}.`)
  return message.result
}
