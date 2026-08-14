import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Gateway } from './gateway.js'
import { buildVerifierTools } from './tools.js'
import { parseVerification } from './verification.js'

test('verification JSON is strict and verifier shell access is read-only', async () => {
  assert.deepEqual(parseVerification('{"verdict":"pass","evidence":["test -> boundary -> passed"],"feedback":"","next_check":""}'), {
    verdict: 'pass', passed: true, blocked: false,
    evidence: ['test -> boundary -> passed'], feedback: '', next_check: ''
  })
  assert.equal(parseVerification('looks good').verdict, 'inconclusive')

  const bash = buildVerifierTools(process.cwd()).find(tool => tool.name === 'Bash')
  assert(bash?.preflight)
  const denied = await bash.preflight({
    id: 'write', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: "Set-Content x.txt 'x'" }) }
  })
  const allowed = await bash.preflight({
    id: 'test', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: 'npm test' }) }
  })
  assert.equal(denied.action, 'deny')
  assert.equal(allowed.action, 'allow')
  assert.deepEqual(buildVerifierTools(process.cwd()).map(tool => tool.name), [
    'Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch', 'Skill'
  ])
})

test('goal mode repairs once, passes independent verification, and reports both attempts', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'friday-goal-'))
  const home = join(temporary, 'home')
  const workspace = join(temporary, 'workspace')
  await mkdir(home)
  await mkdir(workspace)
  const previous = process.env.FRIDAY_HOME
  process.env.FRIDAY_HOME = home
  let mainCalls = 0
  let verifierCalls = 0
  const server = createServer((request, response) => void answerRequest(request, response, body => {
    const verifier = JSON.stringify(body.messages).includes('Friday Verifier')
    if (verifier) {
      verifierCalls += 1
      return verifierCalls === 1
        ? JSON.stringify({ verdict: 'repair', evidence: ['marker -> inspect -> missing'], feedback: 'Add the marker.', next_check: 'Inspect the marker.' })
        : JSON.stringify({ verdict: 'pass', evidence: ['marker -> inspect -> present'], feedback: '', next_check: '' })
    }
    mainCalls += 1
    if (mainCalls === 2) {
      const messages = body.messages as Array<{ role?: unknown; content?: unknown }>
      assert.match(String(messages.at(-1)?.content || ''), /Verification requested repair/)
    }
    return mainCalls === 1 ? 'first attempt' : 'repaired result'
  }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  const output: unknown[] = []
  try {
    await writeFile(join(home, 'models.json'), JSON.stringify({
      active: 'local', profiles: [{
        id: 'local', name: 'Local', provider: 'openai-compatible', model: 'mock',
        base_url: `http://127.0.0.1:${address.port}`, context_window: 100_000, max_output_tokens: 2_000
      }]
    }))
    await writeFile(join(home, 'model-credentials.json'), JSON.stringify({ local: 'secret' }))
    const gateway = new Gateway(workspace, value => output.push(value))
    await gateway.start()
    output.length = 0

    await gateway.handle({ id: 'goal', method: 'goal.run', params: { text: 'Ship the marker' } })

    const response = output.find(value => (value as { id?: unknown }).id === 'goal') as {
      result?: { text?: unknown; verification?: { verdict?: unknown; attempt?: unknown } }
      error?: unknown
    }
    assert(response && !response.error)
    assert.equal(response.result?.text, 'repaired result')
    assert.deepEqual(response.result?.verification && {
      verdict: response.result.verification.verdict,
      attempt: response.result.verification.attempt
    }, { verdict: 'pass', attempt: 2 })
    assert.equal(mainCalls, 2)
    assert.equal(verifierCalls, 2)
    assert.deepEqual(eventPayloads(output, 'verification.complete').map(item => item.verdict), ['repair', 'pass'])
    assert.equal(eventPayloads(output, 'message.complete')[0]?.status, 'done')
    const current = responseResult(output, 'goal')
    assert(current)
    output.length = 0
    await gateway.handle({ id: 'session', method: 'session.current' })
    const session = responseResult(output, 'session') as {
      history: Array<{ kind: string; text: string }>
      info: { progress: { status: string; verification: { verdict: string } } }
    }
    assert.equal(session.history.find(item => item.kind === 'user')?.text, '/goal Ship the marker')
    assert.deepEqual(session.history.filter(item => item.kind === 'assistant').map(item => item.text), ['repaired result'])
    assert.equal(session.info.progress.status, 'done')
    assert.equal(session.info.progress.verification.verdict, 'pass')
  } finally {
    if (previous === undefined) delete process.env.FRIDAY_HOME
    else process.env.FRIDAY_HOME = previous
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(temporary, { recursive: true, force: true })
  }
})

test('cancelling independent verification leaves a resumable blocked goal instead of stale work', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'friday-goal-cancel-'))
  const home = join(temporary, 'home')
  const workspace = join(temporary, 'workspace')
  await mkdir(home)
  await mkdir(workspace)
  const previous = process.env.FRIDAY_HOME
  process.env.FRIDAY_HOME = home
  let verifierResponse: ServerResponse | undefined
  let started!: () => void
  const verifierStarted = new Promise<void>(resolve => { started = resolve })
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    if (JSON.stringify(body.messages).includes('Friday Verifier')) {
      verifierResponse = response
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      started()
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'draft result' } }] })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  const output: unknown[] = []
  try {
    await writeFile(join(home, 'models.json'), JSON.stringify({
      active: 'local', profiles: [{
        id: 'local', name: 'Local', provider: 'openai-compatible', model: 'mock',
        base_url: `http://127.0.0.1:${address.port}`, context_window: 100_000, max_output_tokens: 2_000
      }]
    }))
    await writeFile(join(home, 'model-credentials.json'), JSON.stringify({ local: 'secret' }))
    const gateway = new Gateway(workspace, value => output.push(value))
    await gateway.start()
    output.length = 0

    const running = gateway.handle({ id: 'goal', method: 'goal.run', params: { text: 'Verify forever' } })
    await verifierStarted
    await gateway.handle({ id: 'cancel', method: 'chat.cancel' })
    await running
    await gateway.handle({ id: 'session', method: 'session.current' })

    const goal = responseResult(output, 'goal') as { cancelled: boolean }
    const session = responseResult(output, 'session') as {
      info: { progress: { status: string; verification: { stop_reason: string } } }
    }
    assert.equal(goal.cancelled, true)
    assert.equal(session.info.progress.status, 'blocked')
    assert.equal(session.info.progress.verification.stop_reason, 'cancelled')
  } finally {
    verifierResponse?.end('data: [DONE]\n\n')
    if (previous === undefined) delete process.env.FRIDAY_HOME
    else process.env.FRIDAY_HOME = previous
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(temporary, { recursive: true, force: true })
  }
})

async function answerRequest(
  request: IncomingMessage,
  response: ServerResponse,
  answer: (body: Record<string, unknown>) => string
): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer(body) } }] })}\n\n`)
  response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } })}\n\n`)
  response.end('data: [DONE]\n\n')
}

function eventPayloads(output: unknown[], type: string): Array<Record<string, unknown>> {
  return output.flatMap(value => {
    const message = value as { method?: unknown; params?: { type?: unknown; payload?: Record<string, unknown> } }
    return message.method === 'event' && message.params?.type === type && message.params.payload ? [message.params.payload] : []
  })
}

function responseResult(output: unknown[], id: string): unknown {
  const message = output.find(value => (value as { id?: unknown }).id === id) as { result?: unknown; error?: unknown } | undefined
  assert(message && !message.error, `Missing successful response ${id}.`)
  return message.result
}
