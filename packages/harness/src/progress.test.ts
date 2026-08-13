import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { RunContext } from 'friday-agent-core'

import { projectStateDir } from './config.js'
import { beginProgress, currentProgress, finishProgress, restoreProgress, updatePlan } from './progress.js'
import { FridaySession } from './session.js'

test('progress validates one active step and can be restored without prompt messages', () => {
  const context = new RunContext()
  beginProgress(context, 'Ship the rewrite')
  const planned = updatePlan(context, {
    plan: [
      { step: 'Implement the core', status: 'completed' },
      { step: 'Run tests', status: 'in_progress' }
    ],
    next_action: 'Run the suite'
  })
  assert.equal(planned.next_action, 'Run the suite')
  assert.throws(() => updatePlan(context, { plan: [
    { step: 'one', status: 'in_progress' }, { step: 'two', status: 'in_progress' }
  ] }), /At most one/)

  const finished = finishProgress(context, 'done')
  assert(finished)
  assert.equal(finished.status, 'done')
  assert(finished.steps.every(step => step.status === 'completed'))
  const restored = new RunContext()
  restoreProgress(restored, finished)
  assert.deepEqual(currentProgress(restored), finished)
  assert.equal(restored.messages.length, 0)
})

test('UpdatePlan is an agent tool whose state reaches the UI snapshot', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'friday-ts-progress-'))
  const home = join(temporary, 'home')
  const workspace = join(temporary, 'workspace')
  await mkdir(home)
  await mkdir(workspace)
  const previous = process.env.FRIDAY_HOME
  process.env.FRIDAY_HOME = home
  let calls = 0
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    calls += 1
    if (calls === 1) {
      sse(response, { choices: [{ delta: { tool_calls: [{
        index: 0,
        id: 'plan-call',
        type: 'function',
        function: { name: 'UpdatePlan', arguments: JSON.stringify({
          plan: [{ step: 'Run the focused test', status: 'in_progress' }],
          next_action: 'Run the focused test'
        }) }
      }] } }] })
    } else sse(response, { choices: [{ delta: { content: 'done' } }] })
    response.end('data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  try {
    await writeFile(join(home, 'models.json'), JSON.stringify({
      active: 'local', profiles: [{
        id: 'local', name: 'Local', provider: 'openai-compatible', model: 'mock',
        base_url: `http://127.0.0.1:${address.port}`, context_window: 100_000, max_output_tokens: 2_000
      }]
    }))
    await writeFile(join(home, 'model-credentials.json'), JSON.stringify({ local: 'secret' }))
    const session = await FridaySession.create(workspace, 'progress-session')
    const statuses: string[] = []
    session.onEvent = event => {
      if (event.type === 'progress.updated') statuses.push(String(event.data.status || ''))
    }

    const result = await session.chat('Finish this task')

    assert.equal(result.text, 'done')
    assert.deepEqual(statuses, ['working', 'working', 'done'])
    assert.equal(session.progress().status, 'done')
    assert.deepEqual((session.progress().steps as Array<{ status: string }>).map(step => step.status), ['completed'])
    assert((session.info().tools as string[]).includes('UpdatePlan'))
    const saved = JSON.parse(await readFile(join(projectStateDir(workspace), 'sessions', 'progress-session.json'), 'utf8')) as Record<string, unknown>
    assert.equal((saved.progress as { objective: string }).objective, 'Finish this task')
    assert.equal((await FridaySession.create(workspace, 'progress-session')).progress().status, 'done')
  } finally {
    if (previous === undefined) delete process.env.FRIDAY_HOME
    else process.env.FRIDAY_HOME = previous
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(temporary, { recursive: true, force: true })
  }
})

function sse(response: ServerResponse, value: unknown): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`)
}
