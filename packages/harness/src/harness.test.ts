import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

process.env.FRIDAY_AUTOTITLE = '0'
import { promisify } from 'node:util'

import {
  clearModelCredential,
  deleteModelProfile,
  loadModelConfig,
  projectStateDir,
  readModelCredential,
  saveCompactionSettings,
  saveModelProfile,
  selectModelProfile,
  setModelEnabled
} from './config.js'
import { beginCheckpoint, checkpointChoices, finishCheckpoint, restoreCheckpoint } from './checkpoint.js'
import { artifactDetail } from './artifacts.js'
import { Gateway } from './gateway.js'
import { forkSession, FridaySession, sessionChoices, sessionHistory } from './session.js'
import { resetFriday } from './reset.js'

const exec = promisify(execFile)

test('the harness loads legacy config, chats, and writes a resumable snapshot', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'friday-harness-'))
  const home = join(temporary, 'home')
  const workspace = join(temporary, 'workspace')
  await mkdir(workspace)
  await mkdir(home)
  const previousHome = process.env.FRIDAY_HOME
  process.env.FRIDAY_HOME = home
  let requestCount = 0
  let releaseStalledRequest: (() => void) | undefined
  const stalledRequest = new Promise<void>(resolve => { releaseStalledRequest = resolve })
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    requestCount += 1
    if (requestCount === 3) {
      sse(response, { choices: [{ delta: { content: 'partial' } }] })
      releaseStalledRequest?.()
      return
    }
    sse(response, { choices: [{ delta: { content: 'hello from TypeScript' } }] })
    sse(response, { choices: [], usage: { prompt_tokens: 4, completion_tokens: 3 } })
    response.end('data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')

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
    const session = await FridaySession.create(workspace, 'session-one')

    const result = await session.chat('hello')

    assert.equal(result.text, 'hello from TypeScript')
    assert.deepEqual(result, {
      text: 'hello from TypeScript',
      status: 'done',
      metrics: {
        elapsed_ms: result.metrics.elapsed_ms, requests: 1, input_tokens: 4, output_tokens: 3,
        cached_tokens: null, window_tokens: result.metrics.window_tokens, window: 100_000
      }
    })
    assert.equal(typeof result.metrics.window_tokens, 'number')
    const snapshot = JSON.parse(await readFile(join(projectStateDir(workspace), 'sessions', 'session-one.json'), 'utf8')) as Record<string, unknown>
    assert.equal(snapshot.turns, 1)
    const userTimes = snapshot.user_message_times as Array<Record<string, unknown>>
    assert.equal(userTimes.length, 1)
    const { time, ...userRecord } = userTimes[0]!
    assert.match(String(time), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/)
    assert.deepEqual(userRecord, { text: 'hello', display_text: 'hello', goal: false, attachments: [] })
    const metric = (snapshot.metrics as Array<Record<string, unknown>>)[0]!
    assert.deepEqual(metric.values, result.metrics)
    assert.equal(metric.message_index, 1)
    assert.equal(metric.message_hash, createHash('sha256').update(JSON.stringify(result.text)).digest('hex').slice(0, 20))
    snapshot.created = '2020-01-01T00:00:00'
    snapshot.title = 'Keep this title'
    snapshot.fork_parent = 'parent-session'
    await writeFile(join(projectStateDir(workspace), 'sessions', 'session-one.json'), JSON.stringify(snapshot))
    const resumed = await FridaySession.create(workspace, 'session-one')
    assert.deepEqual(resumed.context.messages.map(message => message.role), ['system', 'user', 'assistant'])
    await resumed.chat('again')
    const updated = JSON.parse(await readFile(join(projectStateDir(workspace), 'sessions', 'session-one.json'), 'utf8')) as Record<string, unknown>
    assert.equal(updated.created, '2020-01-01T00:00:00')
    assert.equal(updated.title, 'Keep this title')
    assert.equal(updated.fork_parent, 'parent-session')
    assert.equal(updated.turns, 2)
    const rolesBeforeCancellation = resumed.context.messages.map(message => message.role)
    const cancelled = resumed.chat('cancel this turn')
    await stalledRequest
    assert.equal(resumed.cancel(), true)
    await assert.rejects(cancelled, error => error instanceof Error && error.name === 'AbortError')
    // An interrupt keeps what actually happened: the user message stays in
    // the conversation instead of the turn being rolled back wholesale.
    assert.deepEqual(resumed.context.messages.map(message => message.role), [...rolesBeforeCancellation, 'user'])
    assert.equal(resumed.context.messages.at(-1)?.content, 'cancel this turn')
  } finally {
    if (previousHome === undefined) delete process.env.FRIDAY_HOME
    else process.env.FRIDAY_HOME = previousHome
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(temporary, { recursive: true, force: true })
  }
})

test('Python session records resume with user metadata, artifacts, metrics, and activities intact', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'friday-python-session-'))
  const home = join(temporary, 'home')
  const workspace = join(temporary, 'workspace')
  await mkdir(home)
  await mkdir(workspace)
  const previousHome = process.env.FRIDAY_HOME
  process.env.FRIDAY_HOME = home
  try {
    const sessionId = 'python-session'
    const answer = 'Done.'
    const hash = createHash('sha256').update(JSON.stringify(answer)).digest('hex').slice(0, 20)
    const sessions = join(projectStateDir(workspace), 'sessions')
    await mkdir(sessions, { recursive: true })
    await writeFile(join(sessions, `${sessionId}.json`), JSON.stringify({
      session_id: sessionId,
      turns: 1,
      messages: [
        { role: 'system', content: 'stale Python prefix' },
        { role: 'user', content: 'inspect report' },
        {
          role: 'assistant', content: '',
          tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'Read', arguments: '{"path":"report.md"}' } }]
        },
        { role: 'tool', tool_call_id: 'read-1', content: 'report body' },
        { role: 'assistant', content: answer }
      ],
      archived_messages: [],
      progress: { objective: 'inspect report', latest_request: 'inspect report', mode: 'goal', status: 'done', steps: [], next_action: '', verification: { verdict: 'pass' }, updated: '2026-08-13T10:00:00' },
      thinking_effort: '',
      user_message_times: [{
        text: 'inspect report', display_text: '/goal inspect report', goal: true,
        time: '2026-08-13T10:00:00+08:00', attachments: [{ kind: 'file', name: 'brief.txt', path: 'C:\\brief.txt', size: 5 }]
      }],
      artifacts: [{ message_index: 3, message_hash: hash, items: [{ kind: 'markdown', name: 'report.md', path: 'report.md', size: 12 }] }],
      metrics: [{ message_index: 3, message_hash: hash, values: { elapsed_ms: 900, requests: 2, input_tokens: 20, output_tokens: 5 } }],
      activities: [{ message_index: 3, message_hash: hash, items: [
        { kind: 'reasoning', text: 'Inspect first.', elapsed_ms: 80 },
        { kind: 'tool', tool_call_id: 'read-1', elapsed_ms: 25, status: 'done' }
      ] }]
    }))

    const session = await FridaySession.create(workspace, sessionId)
    const history = sessionHistory(session)
    const user = history.find(item => item.kind === 'user')!
    const tool = history.find(item => item.kind === 'tool')!
    const reasoning = history.find(item => item.kind === 'reasoning')!
    const assistant = history.find(item => item.kind === 'assistant')!
    assert.equal(user.text, '/goal inspect report')
    assert.equal(user.goal, true)
    assert.equal(user.timestamp, '2026-08-13T10:00:00+08:00')
    assert.equal((user.attachments as unknown[]).length, 1)
    assert.equal(tool.elapsed_ms, 25)
    assert.equal(reasoning.text, 'Inspect first.')
    assert.deepEqual(assistant.artifacts, [{ kind: 'markdown', name: 'report.md', path: 'report.md', size: 12 }])
    assert.deepEqual(assistant.metrics, { elapsed_ms: 900, requests: 2, input_tokens: 20, output_tokens: 5 })
    assert(!session.context.messages.some(message => message.content === 'stale Python prefix'))
  } finally {
    if (previousHome === undefined) delete process.env.FRIDAY_HOME
    else process.env.FRIDAY_HOME = previousHome
    await rm(temporary, { recursive: true, force: true })
  }
})

test('the gateway can boot and report settings without a configured key', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'friday-empty-'))
  const home = join(temporary, 'home')
  const workspace = join(temporary, 'workspace')
  await mkdir(home)
  await mkdir(workspace)
  const previousHome = process.env.FRIDAY_HOME
  process.env.FRIDAY_HOME = home
  const output: unknown[] = []
  try {
    const gateway = new Gateway(workspace, value => output.push(value))
    await gateway.start()
    for (const [index, method] of [
      'session.info', 'session.current', 'session.resume_choices', 'session.tree',
      'checkpoint.list', 'skill.list', 'model.list', 'projects.list'
    ].entries()) await gateway.handle({ id: String(index), method })
    const response = output[1] as { result: { model_configured: boolean } }
    assert.equal(response.result.model_configured, false)
    assert(output.slice(1).every(value => !(value as { error?: unknown }).error))

    output.length = 0
    await gateway.handle({ id: 'permission', method: 'permission.set', params: { mode: 'bypass' } })
    await gateway.handle({ id: 'new', method: 'session.new' })
    await gateway.handle({ id: 'info', method: 'session.info' })
    assert.equal((responseResult(output, 'info') as { permission_mode: string }).permission_mode, 'bypass')

    output.length = 0
    const navigation = gateway.handle({ id: 'navigation', method: 'session.new' })
    const duplicateNavigation = gateway.handle({ id: 'duplicate-navigation', method: 'session.new' })
    const globalMutation = gateway.handle({
      id: 'global-during-navigation', method: 'settings.user.save', params: { profile: {} }
    })
    await Promise.all([navigation, duplicateNavigation, globalMutation])
    responseResult(output, 'navigation')
    const navigationError = output.find(value => (value as { id?: unknown }).id === 'duplicate-navigation') as { error?: { message?: unknown } }
    const globalError = output.find(value => (value as { id?: unknown }).id === 'global-during-navigation') as { error?: { message?: unknown } }
    assert.match(String(navigationError.error?.message), /navigation is in progress/)
    assert.match(String(globalError.error?.message), /Stop running requests before changing global settings/)
  } finally {
    if (previousHome === undefined) delete process.env.FRIDAY_HOME
    else process.env.FRIDAY_HOME = previousHome
    await rm(temporary, { recursive: true, force: true })
  }
})

test('the gateway keeps a running session alive while another session is selected', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'friday-background-'))
  const home = join(temporary, 'home')
  const workspace = join(temporary, 'workspace')
  await mkdir(home)
  await mkdir(workspace)
  const previousHome = process.env.FRIDAY_HOME
  process.env.FRIDAY_HOME = home
  let firstResponse: ServerResponse | undefined
  let secondResponse: ServerResponse | undefined
  let announceFirst = () => {}
  let announceSecond = () => {}
  const firstStarted = new Promise<void>(resolve => { announceFirst = resolve })
  const secondStarted = new Promise<void>(resolve => { announceSecond = resolve })
  let requests = 0
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    requests += 1
    if (requests === 1) {
      firstResponse = response
      announceFirst()
      return
    }
    secondResponse = response
    announceSecond()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  const output: unknown[] = []
  let gateway: Gateway | undefined
  const releaseFirst = () => {
    if (!firstResponse || firstResponse.writableEnded) return
    sse(firstResponse, { choices: [{ delta: { content: 'background answer' } }] })
    firstResponse.end('data: [DONE]\n\n')
  }
  const releaseSecond = () => {
    if (!secondResponse || secondResponse.writableEnded) return
    secondResponse.end('data: [DONE]\n\n')
  }
  try {
    await writeFile(join(home, 'models.json'), JSON.stringify({
      active: 'local', profiles: [{
        id: 'local', name: 'Local', provider: 'openai-compatible', model: 'mock',
        base_url: `http://127.0.0.1:${address.port}`, context_window: 100_000,
        max_output_tokens: 2_000
      }]
    }))
    await writeFile(join(home, 'model-credentials.json'), JSON.stringify({ local: 'secret' }))
    gateway = new Gateway(workspace, value => output.push(value))
    await gateway.start()
    await gateway.handle({ id: 'first-info', method: 'session.info' })
    const firstId = String((responseResult(output, 'first-info') as { session_id: unknown }).session_id)
    output.length = 0

    const firstRun = gateway.handle({ id: 'first-chat', method: 'chat.send', params: { text: 'wait in the background' } })
    await firstStarted
    await gateway.handle({ id: 'new', method: 'session.new' })
    const secondId = String((responseResult(output, 'new') as { info: { session_id: unknown } }).info.session_id)
    assert.notEqual(secondId, firstId)

    await gateway.handle({ id: 'choices-running', method: 'session.resume_choices' })
    const runningChoices = (responseResult(output, 'choices-running') as { choices: Array<Record<string, unknown>> }).choices
    const running = runningChoices.find(choice => choice.id === firstId)
    assert.equal(running?.running, true)
    assert.equal(running?.user, 'wait in the background')

    await gateway.handle({ id: 'resume-running', method: 'session.resume', params: { id: firstId } })
    assert.equal((responseResult(output, 'resume-running') as { info: { running: unknown } }).info.running, true)
    const duplicateStart = output.length
    await gateway.handle({ id: 'duplicate', method: 'chat.send', params: { text: 'do not start this' } })
    const duplicateOutput = output.slice(duplicateStart)
    const duplicate = duplicateOutput.find(value => (value as { id?: unknown }).id === 'duplicate') as { error?: { message?: unknown } }
    assert.match(String(duplicate.error?.message), /already has a request in progress/)
    assert.deepEqual(eventTypes(duplicateOutput), [])
    assert.equal(requests, 1)

    await gateway.handle({ id: 'resume-second', method: 'session.resume', params: { id: secondId } })
    releaseFirst()
    await firstRun
    const completion = output.find(value => {
      const message = value as { method?: unknown; params?: { type?: unknown; payload?: { session_id?: unknown } } }
      return message.method === 'event' && message.params?.type === 'message.complete' && message.params.payload?.session_id === firstId
    })
    assert(completion)
    await gateway.handle({ id: 'selected', method: 'session.info' })
    assert.equal((responseResult(output, 'selected') as { session_id: unknown }).session_id, secondId)
    await gateway.handle({ id: 'choices-done', method: 'session.resume_choices' })
    const doneChoices = (responseResult(output, 'choices-done') as { choices: Array<Record<string, unknown>> }).choices
    assert.notEqual(doneChoices.find(choice => choice.id === firstId)?.running, true)

    await gateway.handle({ id: 'resume-first-again', method: 'session.resume', params: { id: firstId } })
    const cancelledRun = gateway.handle({ id: 'cancelled-chat', method: 'chat.send', params: { text: 'cancel by id' } })
    await secondStarted
    await gateway.handle({ id: 'resume-second-again', method: 'session.resume', params: { id: secondId } })
    await gateway.handle({ id: 'cancel-background', method: 'chat.cancel', params: { session_id: firstId } })
    assert.deepEqual(responseResult(output, 'cancel-background'), { cancelled: true, session_id: firstId })
    await cancelledRun
    assert.deepEqual(responseResult(output, 'cancelled-chat'), { cancelled: true, session_id: firstId })
    await gateway.handle({ id: 'still-selected', method: 'session.info' })
    assert.equal((responseResult(output, 'still-selected') as { session_id: unknown }).session_id, secondId)
  } finally {
    releaseFirst()
    releaseSecond()
    await gateway?.close()
    if (previousHome === undefined) delete process.env.FRIDAY_HOME
    else process.env.FRIDAY_HOME = previousHome
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(temporary, { recursive: true, force: true })
  }
})

test('permission mode hot-swaps while a request runs and reaches every live session', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'friday-permission-hot-'))
  const home = join(temporary, 'home')
  const workspace = join(temporary, 'workspace')
  await mkdir(home)
  await mkdir(workspace)
  const previousHome = process.env.FRIDAY_HOME
  process.env.FRIDAY_HOME = home
  let held: ServerResponse | undefined
  let announce = () => {}
  const started = new Promise<void>(resolve => { announce = resolve })
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    held = response
    announce()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  const output: unknown[] = []
  let gateway: Gateway | undefined
  const release = () => {
    if (!held || held.writableEnded) return
    sse(held, { choices: [{ delta: { content: 'late answer' } }] })
    held.end('data: [DONE]\n\n')
  }
  try {
    await writeFile(join(home, 'models.json'), JSON.stringify({
      active: 'local', profiles: [{
        id: 'local', name: 'Local', provider: 'openai-compatible', model: 'mock',
        base_url: `http://127.0.0.1:${address.port}`, context_window: 100_000,
        max_output_tokens: 2_000
      }]
    }))
    await writeFile(join(home, 'model-credentials.json'), JSON.stringify({ local: 'secret' }))
    gateway = new Gateway(workspace, value => output.push(value))
    await gateway.start()
    await gateway.handle({ id: 'first-info', method: 'session.info' })
    const firstId = String((responseResult(output, 'first-info') as { session_id: unknown }).session_id)
    await gateway.handle({ id: 'new', method: 'session.new' })
    const secondId = String((responseResult(output, 'new') as { info: { session_id: unknown } }).info.session_id)
    await gateway.handle({ id: 'back-to-first', method: 'session.resume', params: { id: firstId } })

    const run = gateway.handle({ id: 'busy-chat', method: 'chat.send', params: { text: 'keep running' } })
    await started
    // The swap lands while the request is mid-flight: no idle requirement.
    await gateway.handle({ id: 'swap', method: 'permission.set', params: { mode: 'bypass' } })
    assert.deepEqual(responseResult(output, 'swap'), { permission_mode: 'bypass', session_id: firstId })
    const updated = output.find(value => {
      const message = value as { method?: unknown; params?: { type?: unknown; payload?: Record<string, unknown> } }
      return message.method === 'event' && message.params?.type === 'permission.updated'
    }) as { params: { payload: Record<string, unknown> } } | undefined
    assert(updated)
    // Gateway-wide: the event must not be scoped to one session.
    assert.deepEqual(updated.params.payload, { permission_mode: 'bypass' })

    release()
    await run
    // Every live session picked the mode up, not just the one in front.
    await gateway.handle({ id: 'check-second', method: 'session.resume', params: { id: secondId } })
    const info = (responseResult(output, 'check-second') as { info: { permission_mode: unknown } }).info
    assert.equal(info.permission_mode, 'bypass')
  } finally {
    release()
    await gateway?.close()
    if (previousHome === undefined) delete process.env.FRIDAY_HOME
    else process.env.FRIDAY_HOME = previousHome
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(temporary, { recursive: true, force: true })
  }
})

test('cancelling returns undelivered steers instead of firing a follow-up turn', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'friday-cancel-steers-'))
  const home = join(temporary, 'home')
  const workspace = join(temporary, 'workspace')
  await mkdir(home)
  await mkdir(workspace)
  const previousHome = process.env.FRIDAY_HOME
  process.env.FRIDAY_HOME = home
  let requests = 0
  let announce = () => {}
  const started = new Promise<void>(resolve => { announce = resolve })
  const server = createServer((_request, response) => {
    requests += 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    announce()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  const output: unknown[] = []
  let gateway: Gateway | undefined
  try {
    await writeFile(join(home, 'models.json'), JSON.stringify({
      active: 'local', profiles: [{
        id: 'local', name: 'Local', provider: 'openai-compatible', model: 'mock',
        base_url: `http://127.0.0.1:${address.port}`, context_window: 100_000,
        max_output_tokens: 2_000
      }]
    }))
    await writeFile(join(home, 'model-credentials.json'), JSON.stringify({ local: 'secret' }))
    gateway = new Gateway(workspace, value => output.push(value))
    await gateway.start()
    await gateway.handle({ id: 'info', method: 'session.info' })
    const sessionId = String((responseResult(output, 'info') as { session_id: unknown }).session_id)

    const run = gateway.handle({ id: 'chat', method: 'chat.send', params: { text: 'long task' } })
    await started
    await gateway.handle({ id: 'steer', method: 'chat.steer', params: { text: 'change of plans' } })
    await gateway.handle({ id: 'stop', method: 'chat.cancel' })
    assert.deepEqual(responseResult(output, 'stop'), {
      cancelled: true, dropped_steers: ['change of plans'], session_id: sessionId
    })
    await run
    assert.deepEqual(responseResult(output, 'chat'), { cancelled: true, session_id: sessionId })

    // Past the follow-up dispatch window: the dropped steer must not have
    // started a new turn behind the user's back.
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(requests, 1)
    const followUp = output.find(value => {
      const message = value as { method?: unknown; params?: { type?: unknown; payload?: { text?: unknown } } }
      return message.method === 'event' && message.params?.type === 'message.start'
        && message.params.payload?.text === 'change of plans'
    })
    assert.equal(followUp, undefined)
  } finally {
    await gateway?.close()
    if (previousHome === undefined) delete process.env.FRIDAY_HOME
    else process.env.FRIDAY_HOME = previousHome
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(temporary, { recursive: true, force: true })
  }
})

test('session reset clears only project state by default and preserves model configuration', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'friday-reset-'))
  const home = join(temporary, 'home')
  const workspace = join(temporary, 'workspace')
  await mkdir(home)
  await mkdir(workspace)
  const previousHome = process.env.FRIDAY_HOME
  process.env.FRIDAY_HOME = home
  const output: unknown[] = []
  try {
    const gateway = new Gateway(workspace, value => output.push(value))
    await gateway.start()
    const state = projectStateDir(workspace)
    await writeFile(join(state, 'config.json'), '{"model":"project-model"}\n')
    await writeFile(join(state, 'marker.txt'), 'remove')
    await mkdir(join(workspace, '.friday'))
    await writeFile(join(workspace, '.friday', 'legacy.txt'), 'remove')
    await writeFile(join(home, 'keep.txt'), 'keep')
    output.length = 0

    await gateway.handle({ id: 'reset', method: 'session.reset' })

    const result = responseResult(output, 'reset') as { removed: string[]; history: unknown[] }
    assert.equal(result.history.length, 0)
    assert(result.removed.includes(state))
    assert.equal(await readFile(join(state, 'config.json'), 'utf8'), '{"model":"project-model"}\n')
    assert.equal(await readFile(join(home, 'keep.txt'), 'utf8'), 'keep')
    await assert.rejects(readFile(join(state, 'marker.txt'), 'utf8'), { code: 'ENOENT' })
    await assert.rejects(readFile(join(workspace, '.friday', 'legacy.txt'), 'utf8'), { code: 'ENOENT' })
  } finally {
    if (previousHome === undefined) delete process.env.FRIDAY_HOME
    else process.env.FRIDAY_HOME = previousHome
    await rm(temporary, { recursive: true, force: true })
  }
})

test('global reset refuses a Friday home that contains the workspace', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'friday-reset-boundary-'))
  const workspace = join(temporary, 'workspace')
  await mkdir(workspace)
  await writeFile(join(workspace, 'keep.txt'), 'keep')
  const previousHome = process.env.FRIDAY_HOME
  process.env.FRIDAY_HOME = temporary
  try {
    await assert.rejects(resetFriday(workspace, true), /unsafe Friday home/)
    assert.equal(await readFile(join(workspace, 'keep.txt'), 'utf8'), 'keep')
  } finally {
    if (previousHome === undefined) delete process.env.FRIDAY_HOME
    else process.env.FRIDAY_HOME = previousHome
    await rm(temporary, { recursive: true, force: true })
  }
})

test('model profiles keep credentials private and remain selectable', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'friday-models-'))
  const home = join(temporary, 'home')
  const workspace = join(temporary, 'workspace')
  await mkdir(home)
  await mkdir(workspace)
  const previousHome = process.env.FRIDAY_HOME
  process.env.FRIDAY_HOME = home
  try {
    const first = await saveModelProfile(workspace, {
      id: 'local-a', name: 'Local A', provider: 'openai-compatible', model: 'model-a',
      base_url: 'http://127.0.0.1:8001/v1', context_window: 32_000, max_output_tokens: 2_000
    }, { apiKey: 'private-a' })
    assert.equal(first.active, 'local-a')
    assert.equal(first.profiles.find(profile => profile.id === 'local-a')?.enabled, true)
    assert.equal(readModelCredential(workspace, '', 'local-a'), 'private-a')
    assert.equal(loadModelConfig(workspace).model, 'model-a')

    const second = await saveModelProfile(workspace, {
      id: 'local-b', name: 'Local B', provider: 'openai-compatible', model: 'model-b',
      base_url: 'http://127.0.0.1:8002/v1'
    }, { apiKey: 'private-b', activate: false })
    assert.equal(second.active, 'local-a')
    assert(!JSON.stringify(second).includes('private-'))
    assert(!await readFile(join(home, 'models.json'), 'utf8').then(value => value.includes('private-')))
    assert((await readFile(join(home, 'model-credentials.json'), 'utf8')).includes('private-b'))

    assert.equal((await selectModelProfile(workspace, 'local-b')).active, 'local-b')
    assert.equal((await setModelEnabled(workspace, false, '', 'local-a')).profiles.find(profile => profile.id === 'local-a')?.enabled, false)
    assert.equal((await setModelEnabled(workspace, true, '', 'local-a')).profiles.find(profile => profile.id === 'local-a')?.enabled, true)
    const cleared = await clearModelCredential(workspace, '', 'local-b')
    assert.equal(cleared.active, 'local-a')
    assert.equal(readModelCredential(workspace, '', 'local-b'), '')
    assert.equal((await deleteModelProfile(workspace, 'local-b')).profiles.some(profile => profile.id === 'local-b'), false)
  } finally {
    if (previousHome === undefined) delete process.env.FRIDAY_HOME
    else process.env.FRIDAY_HOME = previousHome
    await rm(temporary, { recursive: true, force: true })
  }
})

test('session RPCs rename, fork, navigate, and delete a branch subtree', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'friday-sessions-'))
  const home = join(temporary, 'home')
  const workspace = join(temporary, 'workspace')
  await mkdir(home)
  await mkdir(workspace)
  const previousHome = process.env.FRIDAY_HOME
  process.env.FRIDAY_HOME = home
  let calls = 0
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    calls += 1
    sse(response, { choices: [{ delta: { content: `answer ${calls}` } }] })
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
        base_url: `http://127.0.0.1:${address.port}`, context_window: 100_000,
        max_output_tokens: 2_000
      }]
    }))
    await writeFile(join(home, 'model-credentials.json'), JSON.stringify({ local: 'secret' }))
    const gateway = new Gateway(workspace, value => output.push(value))
    await gateway.start()
    output.length = 0
    await gateway.handle({ id: 'chat', method: 'chat.send', params: { text: 'root question' } })
    await gateway.handle({ id: 'rename', method: 'session.rename', params: { id: currentSession(output), title: 'Root thread' } })
    const root = currentSession(output)
    output.length = 0

    await gateway.handle({ id: 'fork', method: 'session.fork', params: { id: root, message_index: 1 } })
    const forkResponse = responseResult(output, 'fork') as { info: { session_id: string }; history: Array<{ kind: string; text: string }> }
    const fork = forkResponse.info.session_id
    assert.notEqual(fork, root)
    assert.deepEqual(forkResponse.history.map(item => item.kind), ['user', 'assistant'])
    output.length = 0
    await gateway.handle({ id: 'tree-fork', method: 'session.tree', params: { id: fork } })
    const forkTree = responseResult(output, 'tree-fork') as { nodes: Array<{ id: string; title: string; fork_source?: string }> }
    const forkNode = forkTree.nodes.find(node => node.id === fork)!
    // The fork is named by the assistant message it split from, and the tree
    // carries that source text so UIs can label the branch origin.
    const forkedFrom = forkResponse.history.find(item => item.kind === 'assistant')!.text
    assert.equal(forkNode.title.startsWith('Fork: '), true)
    assert.equal(forkNode.fork_source, forkedFrom.replace(/\s+/g, ' ').trim().slice(0, 120))
    assert.deepEqual((await sessionChoices(workspace)).map(choice => choice.id), [root])
    output.length = 0

    await gateway.handle({ id: 'back', method: 'session.resume', params: { id: root } })
    assert.equal((responseResult(output, 'back') as { info: { session_id: string } }).info.session_id, root)
    output.length = 0
    await gateway.handle({ id: 'resume-fork', method: 'session.resume', params: { id: fork } })
    assert.equal((responseResult(output, 'resume-fork') as { info: { session_id: string } }).info.session_id, fork)
    output.length = 0
    await gateway.handle({ id: 'delete', method: 'session.delete', params: { id: root } })
    const deleted = responseResult(output, 'delete') as { deleted: string[]; info: { session_id: string } }
    assert.deepEqual(new Set(deleted.deleted), new Set([root, fork]))
    assert(!deleted.deleted.includes(deleted.info.session_id))
    await assert.rejects(readFile(join(projectStateDir(workspace), 'sessions', `${root}.json`), 'utf8'), { code: 'ENOENT' })
    await assert.rejects(readFile(join(projectStateDir(workspace), 'sessions', `${fork}.json`), 'utf8'), { code: 'ENOENT' })
    assert.deepEqual(await readdir(join(projectStateDir(workspace), 'traces-ts')), [])
  } finally {
    if (previousHome === undefined) delete process.env.FRIDAY_HOME
    else process.env.FRIDAY_HOME = previousHome
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(temporary, { recursive: true, force: true })
  }
})

test('settings RPCs store secrets privately and expose only configuration status', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'friday-settings-'))
  const home = join(temporary, 'home')
  const workspace = join(temporary, 'workspace')
  await mkdir(home)
  await mkdir(workspace)
  const previousHome = process.env.FRIDAY_HOME
  process.env.FRIDAY_HOME = home
  const output: unknown[] = []
  try {
    const gateway = new Gateway(workspace, value => output.push(value))
    await gateway.start()
    output.length = 0
    await gateway.handle({ id: 'compaction-default', method: 'settings.compaction.get' })
    assert.deepEqual(responseResult(output, 'compaction-default'), {
      automatic: true, threshold_percent: 85, strategy: 'insert'
    })
    await gateway.handle({ id: 'web', method: 'settings.web.save', params: { tavily_api_key: 'tvly-private-value' } })
    await gateway.handle({
      id: 'profile', method: 'settings.user.save',
      params: { profile: { preferred_name: 'Kai', preferred_language: 'Chinese', habits: 'Concise answers.' } }
    })
    await gateway.handle({ id: 'memory', method: 'settings.memory.save', params: { file: 'global', content: '# Durable memory\n' } })
    await gateway.handle({
      id: 'compaction', method: 'settings.compaction.save',
      params: { automatic: false, threshold_percent: 75, strategy: 'two-stage' }
    })
    await gateway.handle({ id: 'settings', method: 'settings.get' })

    const settings = responseResult(output, 'settings') as {
      web_search: { tavily_configured: boolean }
      user_profile: { preferred_name: string }
      memory_files: { global: { chars: number; limit: number } }
      compaction: { automatic: boolean; threshold_percent: number; strategy: string }
    }
    assert.equal(settings.web_search.tavily_configured, true)
    assert.equal(settings.user_profile.preferred_name, 'Kai')
    assert.equal(settings.memory_files.global.chars, '# Durable memory\n'.length)
    assert.deepEqual(settings.compaction, { automatic: false, threshold_percent: 75, strategy: 'two-stage' })
    assert(!JSON.stringify(settings).includes('private'))
    assert((await readFile(join(home, 'web-credentials.json'), 'utf8')).includes('tvly-private-value'))
    assert((await readFile(join(home, 'USER.md'), 'utf8')).includes('<!-- friday-profile:start -->'))
    assert.equal((responseResult(output, 'web') as { tavily_configured: boolean }).tavily_configured, true)
    assert.deepEqual(responseResult(output, 'compaction'), settings.compaction)

    output.length = 0
    await gateway.handle({ id: 'reject-secret', method: 'settings.memory.save', params: { file: 'global', content: 'api_key=sk-not-for-memory' } })
    assert.match(String((output[0] as { error?: { message?: unknown } }).error?.message), /secret or credential/)
    output.length = 0
    await gateway.handle({ id: 'reject-threshold', method: 'settings.compaction.save', params: { threshold_percent: 99 } })
    assert.match(String((output[0] as { error?: { message?: unknown } }).error?.message), /50 to 95/)
  } finally {
    if (previousHome === undefined) delete process.env.FRIDAY_HOME
    else process.env.FRIDAY_HOME = previousHome
    await rm(temporary, { recursive: true, force: true })
  }
})

test('compaction shrinks the model prompt without shrinking resumable UI history', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'friday-compaction-'))
  const home = join(temporary, 'home')
  const workspace = join(temporary, 'workspace')
  await mkdir(home)
  await mkdir(workspace)
  const previousHome = process.env.FRIDAY_HOME
  process.env.FRIDAY_HOME = home
  const summary = [
    '## Current Goal', 'Finish the migration while preserving the complete conversation.',
    '## Completed', '- First task', '## Open Items', '- Second task',
    '## Tried Methods', '', '## Decisions', '', '## Working Files', '',
    '## Commands And Results', '', '## Verification State', 'not run',
    '## Next Steps', 'Continue.', '## Memory', '- none'
  ].join('\n')
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    sse(response, { choices: [{ delta: { content: summary } }] })
    sse(response, { choices: [], usage: { prompt_tokens: 40, completion_tokens: 20 } })
    response.end('data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  try {
    await writeFile(join(home, 'models.json'), JSON.stringify({
      active: 'local', profiles: [{
        id: 'local', name: 'Local', provider: 'openai-compatible', model: 'mock',
        base_url: `http://127.0.0.1:${address.port}`, context_window: 4_000,
        max_output_tokens: 1_000
      }]
    }))
    await writeFile(join(home, 'model-credentials.json'), JSON.stringify({ local: 'secret' }))
    const session = await FridaySession.create(workspace, 'compact-session')
    session.context.addMessage({ role: 'user', content: 'first question' })
    session.context.addMessage({ role: 'assistant', content: 'first answer' })
    session.context.addMessage({ role: 'user', content: 'second question' })
    session.context.addMessage({ role: 'assistant', content: 'second answer' })
    const before = sessionHistory(session)
    const events: string[] = []
    session.onEvent = event => events.push(event.type)

    const result = await session.compact()

    assert.match(result, /Current Goal/)
    assert(events.includes('context.compacted'))
    assert(session.context.messages.length < 6)
    assert.deepEqual(sessionHistory(session), before)
    const snapshot = JSON.parse(await readFile(join(projectStateDir(workspace), 'sessions', 'compact-session.json'), 'utf8')) as Record<string, unknown>
    assert.equal((snapshot.archived_messages as unknown[]).length, 3)
    const resumed = await FridaySession.create(workspace, 'compact-session')
    assert.deepEqual(sessionHistory(resumed), before)
    assert.match(resumed.contextText(), /# Context/)
    const firstReply = before.find(item => item.kind === 'assistant')!
    const fork = await forkSession(workspace, 'compact-session', Number(firstReply.message_index))
    const forked = await FridaySession.create(workspace, String(fork.session_id))
    assert.deepEqual(sessionHistory(forked).map(item => [item.kind, item.text]), [
      ['user', 'first question'], ['assistant', 'first answer']
    ])
  } finally {
    if (previousHome === undefined) delete process.env.FRIDAY_HOME
    else process.env.FRIDAY_HOME = previousHome
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(temporary, { recursive: true, force: true })
  }
})

test('tool-result tombstones preserve full UI and resumable history', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'friday-tool-compaction-'))
  const home = join(temporary, 'home')
  const workspace = join(temporary, 'workspace')
  await mkdir(home)
  await mkdir(workspace)
  const previousHome = process.env.FRIDAY_HOME
  process.env.FRIDAY_HOME = home
  try {
    await writeFile(join(home, 'models.json'), JSON.stringify({
      active: 'local', profiles: [{
        id: 'local', name: 'Local', provider: 'openai-compatible', model: 'mock',
        base_url: 'http://127.0.0.1:9', context_window: 100_000, max_output_tokens: 1_000
      }]
    }))
    await writeFile(join(home, 'model-credentials.json'), JSON.stringify({ local: 'secret' }))
    await saveCompactionSettings(workspace, { strategy: 'two-stage' })
    const session = await FridaySession.create(workspace, 'tool-compact-session')
    session.context.addMessage({ role: 'user', content: 'Inspect four files.' })
    for (let index = 0; index < 4; index += 1) {
      const id = `read-${index}`
      session.context.addMessage({
        role: 'assistant', content: '',
        tool_calls: [{ id, type: 'function', function: { name: 'Read', arguments: JSON.stringify({ path: `file-${index}.ts` }) } }]
      })
      session.context.addMessage({
        role: 'tool', tool_call_id: id,
        content: index ? `recent result ${index}` : 'old exact result\n'.repeat(6_000)
      })
    }
    session.context.addMessage({ role: 'assistant', content: 'I inspected all four files.' })
    const before = sessionHistory(session)

    assert.match(await session.compact(), /tool results compacted/)
    assert.deepEqual(sessionHistory(session), before)
    const projected = session.context.messages.find(message => message.tool_call_id === 'read-0')!
    assert.match(String(projected.content), /"compacted":true/)
    assert.match(String(projected.friday_original_tool_content), /old exact result/)

    const resumed = await FridaySession.create(workspace, 'tool-compact-session')
    assert.deepEqual(sessionHistory(resumed), before)
    assert.match(String(resumed.context.messages.find(message => message.tool_call_id === 'read-0')?.content), /"compacted":true/)
  } finally {
    if (previousHome === undefined) delete process.env.FRIDAY_HOME
    else process.env.FRIDAY_HOME = previousHome
    await rm(temporary, { recursive: true, force: true })
  }
})

test('automatic compaction off stops safely and asks for manual compact', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'friday-manual-compaction-'))
  const home = join(temporary, 'home')
  const workspace = join(temporary, 'workspace')
  await mkdir(home)
  await mkdir(workspace)
  const previousHome = process.env.FRIDAY_HOME
  process.env.FRIDAY_HOME = home
  const requests: Array<Record<string, unknown>> = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      requests.push(JSON.parse(body) as Record<string, unknown>)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      sse(response, { choices: [{ delta: { content: 'Please run /compact, then continue.' } }] })
      sse(response, { choices: [], usage: { prompt_tokens: 2_600, completion_tokens: 10 } })
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  try {
    await writeFile(join(home, 'models.json'), JSON.stringify({
      active: 'local', profiles: [{
        id: 'local', name: 'Local', provider: 'openai-compatible', model: 'mock',
        base_url: `http://127.0.0.1:${address.port}`, context_window: 4_000, max_output_tokens: 500
      }]
    }))
    await writeFile(join(home, 'model-credentials.json'), JSON.stringify({ local: 'secret' }))
    await saveCompactionSettings(workspace, { automatic: false, threshold_percent: 50 })
    const session = await FridaySession.create(workspace, 'manual-compact-session')
    session.context.addMessage({ role: 'user', content: 'Earlier request' })
    session.context.addMessage({ role: 'assistant', content: 'large history '.repeat(900) })

    const result = await session.chat('Continue the work.')

    assert.match(result.text, /\/compact/)
    assert.equal(requests.length, 1)
    const requestMessages = requests[0]!.messages as Array<{ role?: unknown; content?: unknown }>
    assert.equal(requestMessages.some(message => String(message.content).includes('Automatic context compaction is off')), true)
    assert.equal(Array.isArray(requests[0]!.tools), false)
  } finally {
    if (previousHome === undefined) delete process.env.FRIDAY_HOME
    else process.env.FRIDAY_HOME = previousHome
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(temporary, { recursive: true, force: true })
  }
})

test('an external compactor is replaceable but cannot bypass the Harness context guard', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'friday-custom-compaction-'))
  const home = join(temporary, 'home')
  const workspace = join(temporary, 'workspace')
  const pluginRoot = join(workspace, '.friday', 'plugins')
  await mkdir(home)
  await mkdir(workspace)
  const previousHome = process.env.FRIDAY_HOME
  process.env.FRIDAY_HOME = home
  const state = projectStateDir(workspace)
  await mkdir(pluginRoot, { recursive: true })
  await mkdir(state, { recursive: true })
  const requests: Array<Record<string, unknown>> = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      requests.push(JSON.parse(body) as Record<string, unknown>)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      sse(response, { choices: [{ delta: { content: 'The context guard stopped safely.' } }] })
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  try {
    await writeFile(join(home, 'models.json'), JSON.stringify({
      active: 'local', profiles: [{
        id: 'local', name: 'Local', provider: 'openai-compatible', model: 'mock',
        base_url: `http://127.0.0.1:${address.port}`, context_window: 4_000, max_output_tokens: 500
      }]
    }))
    await writeFile(join(home, 'model-credentials.json'), JSON.stringify({ local: 'secret' }))
    await writeFile(join(state, 'config.json'), JSON.stringify({
      disabled_plugins: ['compaction'],
      compaction: { automatic: true, threshold_percent: 50, strategy: 'insert' }
    }))
    await writeFile(join(pluginRoot, 'custom-compactor.mjs'), `export default {
      name: 'custom-compactor',
      async compact({ context }) {
        context.metadata.custom_compactor_runs = Number(context.metadata.custom_compactor_runs || 0) + 1
        return { summary: 'custom compactor ran', record: { after_tokens: 1 } }
      }
    }`)
    const session = await FridaySession.create(workspace, 'custom-compact-session')
    const compaction = session.info().compaction as Record<string, unknown>
    assert.equal(compaction.provider, 'custom-compactor')
    const guards: string[] = []
    const compactions: Array<Record<string, unknown>> = []
    session.onEvent = event => {
      if (event.type === 'loop.guard') guards.push(String(event.data.reason || ''))
      if (event.type === 'context.compacted') compactions.push(event.data)
    }
    session.context.addMessage({ role: 'user', content: 'Earlier request' })
    session.context.addMessage({ role: 'assistant', content: 'large history '.repeat(900) })

    const result = await session.chat('Continue safely.')

    assert.equal(session.context.metadata.custom_compactor_runs, 1)
    assert.equal(result.text, 'The context guard stopped safely.')
    assert(guards.includes('context_window'))
    assert.equal(compactions.length, 1)
    assert.notEqual(compactions[0]!.after_tokens, 1)
    assert.equal(compactions[0]!.before_tokens, compactions[0]!.after_tokens)
    assert.equal(requests.length, 1)
    assert.equal(Array.isArray(requests[0]!.tools), false)
  } finally {
    if (previousHome === undefined) delete process.env.FRIDAY_HOME
    else process.env.FRIDAY_HOME = previousHome
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(temporary, { recursive: true, force: true })
  }
})

test('an external memory provider replaces built-in recall and capture without changing the turn contract', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'friday-custom-memory-'))
  const home = join(temporary, 'home')
  const workspace = join(temporary, 'workspace')
  const pluginRoot = join(workspace, '.friday', 'plugins')
  await mkdir(home)
  await mkdir(workspace)
  const previousHome = process.env.FRIDAY_HOME
  process.env.FRIDAY_HOME = home
  const state = projectStateDir(workspace)
  await mkdir(pluginRoot, { recursive: true })
  await mkdir(state, { recursive: true })
  const requests: Array<Record<string, unknown>> = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      requests.push(JSON.parse(body) as Record<string, unknown>)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      sse(response, { choices: [{ delta: { content: 'Custom memory was available.' } }] })
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  try {
    await writeFile(join(home, 'models.json'), JSON.stringify({
      active: 'local', profiles: [{
        id: 'local', name: 'Local', provider: 'openai-compatible', model: 'mock',
        base_url: `http://127.0.0.1:${address.port}`, context_window: 100_000, max_output_tokens: 500
      }]
    }))
    await writeFile(join(home, 'model-credentials.json'), JSON.stringify({ local: 'secret' }))
    await writeFile(join(state, 'config.json'), JSON.stringify({ disabled_plugins: ['memory'] }))
    await writeFile(join(pluginRoot, 'custom-memory.mjs'), `export default {
      name: 'custom-memory',
      memory: {
        async prepare({ text, sessionId }) {
          return {
            recall: '## Relevant Memory\\n- CUSTOM_PROVIDER_RECALL',
            capture: { provider: 'custom-memory', text, session_id: sessionId }
          }
        }
      }
    }`)
    const session = await FridaySession.create(workspace, 'custom-memory-session')
    const info = session.info()
    assert.equal((info.memory as Record<string, unknown>).provider, 'custom-memory')
    assert.equal((info.tools as string[]).includes('Memory'), false)
    const plugins = info.plugins as Array<Record<string, unknown>>
    assert.deepEqual(plugins.find(plugin => plugin.name === 'custom-memory')!.capabilities, ['memory'])
    const updates: Array<Record<string, unknown>> = []
    session.onEvent = event => {
      if (event.type === 'memory.updated') updates.push(event.data)
    }

    const result = await session.chat('Use the custom provider.')

    assert.equal(result.text, 'Custom memory was available.')
    assert.equal(requests.length, 1)
    const messages = requests[0]!.messages as Array<{ role?: unknown; content?: unknown }>
    const user = messages.find(message => message.role === 'user')!
    assert.match(String(user.content), /CUSTOM_PROVIDER_RECALL/)
    assert.match(String(user.content), /Use the custom provider\./)
    assert.deepEqual(updates[0]?.capture, {
      provider: 'custom-memory', text: 'Use the custom provider.', session_id: 'custom-memory-session'
    })
  } finally {
    if (previousHome === undefined) delete process.env.FRIDAY_HOME
    else process.env.FRIDAY_HOME = previousHome
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(temporary, { recursive: true, force: true })
  }
})

test('checkpoints restore exact files, reject later changes, and leave the user git index alone', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'friday-checkpoint-'))
  const home = join(temporary, 'home')
  const workspace = join(temporary, 'workspace')
  await mkdir(home)
  await mkdir(workspace)
  const previousHome = process.env.FRIDAY_HOME
  process.env.FRIDAY_HOME = home
  try {
    await writeFile(join(workspace, 'kept.txt'), 'before\r\n')
    await exec('git', ['init', '--quiet'], { cwd: workspace })
    await exec('git', ['add', 'kept.txt'], { cwd: workspace })
    const indexBefore = (await exec('git', ['write-tree'], { cwd: workspace })).stdout.trim()
    const id = await beginCheckpoint({
      workspace,
      sessionId: 'checkpoint-session',
      user: 'change files',
      turns: 2,
      thinkingEffort: 'high',
      messages: [{ role: 'user', content: 'previous turn' }]
    })
    await writeFile(join(workspace, 'kept.txt'), 'after\n')
    await writeFile(join(workspace, 'created.txt'), 'created\n')
    const finished = await finishCheckpoint(workspace, id, false)
    const checkpointRepo = join(projectStateDir(workspace), 'checkpoints-ts', 'repo.git')
    const beforeRef = `refs/friday/${id}/before`
    assert.equal(
      (await exec('git', ['--git-dir', checkpointRepo, 'rev-parse', beforeRef], { cwd: workspace })).stdout.trim(),
      finished.before_tree
    )

    assert.equal((await exec('git', ['write-tree'], { cwd: workspace })).stdout.trim(), indexBefore)
    assert.deepEqual((await checkpointChoices(workspace)).map(item => item.id), [id])
    await writeFile(join(workspace, 'kept.txt'), 'changed outside Friday\n')
    await assert.rejects(restoreCheckpoint(workspace, id), /Workspace changed after Friday's last checkpoint/)

    const restored = await restoreCheckpoint(workspace, id, true)
    assert.deepEqual(new Set(restored.changed_paths), new Set(['created.txt', 'kept.txt']))
    assert.equal(await readFile(join(workspace, 'kept.txt'), 'utf8'), 'before\r\n')
    await assert.rejects(readFile(join(workspace, 'created.txt'), 'utf8'), { code: 'ENOENT' })
    assert.deepEqual(restored.before_messages, [{ role: 'user', content: 'previous turn' }])
    assert.equal(restored.before_turns, 2)
    assert.equal((await exec('git', ['write-tree'], { cwd: workspace })).stdout.trim(), indexBefore)
    await assert.rejects(exec('git', ['--git-dir', checkpointRepo, 'rev-parse', '--verify', beforeRef], { cwd: workspace }))
  } finally {
    if (previousHome === undefined) delete process.env.FRIDAY_HOME
    else process.env.FRIDAY_HOME = previousHome
    await rm(temporary, { recursive: true, force: true })
  }
})

test('checkpoints fall back to a content-addressed file store when Git is unavailable', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'friday-file-checkpoint-'))
  const home = join(temporary, 'home')
  const workspace = join(temporary, 'workspace')
  await mkdir(home)
  await mkdir(workspace)
  await mkdir(join(workspace, 'ignored'))
  const previousHome = process.env.FRIDAY_HOME
  const previousBackend = process.env.FRIDAY_CHECKPOINT_BACKEND
  process.env.FRIDAY_HOME = home
  process.env.FRIDAY_CHECKPOINT_BACKEND = 'files'
  try {
    await writeFile(join(workspace, '.gitignore'), 'ignored/\n')
    await writeFile(join(workspace, 'kept.txt'), 'before\r\n')
    await writeFile(join(workspace, 'ignored', 'cache.txt'), 'ignored before\n')
    const id = await beginCheckpoint({
      workspace,
      sessionId: 'file-checkpoint-session',
      user: 'change files',
      messages: [{ role: 'user', content: 'previous turn' }]
    })
    await writeFile(join(workspace, 'kept.txt'), 'after\n')
    await writeFile(join(workspace, 'created.txt'), 'created\n')
    const finished = await finishCheckpoint(workspace, id, false)
    assert.match(finished.before_tree, /^files:[a-f0-9]{64}$/)
    assert.match(finished.after_tree, /^files:[a-f0-9]{64}$/)

    await writeFile(join(workspace, 'ignored', 'cache.txt'), 'ignored after\n')
    const restored = await restoreCheckpoint(workspace, id)
    assert.deepEqual(new Set(restored.changed_paths), new Set(['created.txt', 'kept.txt']))
    assert.equal(await readFile(join(workspace, 'kept.txt'), 'utf8'), 'before\r\n')
    assert.equal(await readFile(join(workspace, 'ignored', 'cache.txt'), 'utf8'), 'ignored after\n')
    await assert.rejects(readFile(join(workspace, 'created.txt'), 'utf8'), { code: 'ENOENT' })
  } finally {
    if (previousHome === undefined) delete process.env.FRIDAY_HOME
    else process.env.FRIDAY_HOME = previousHome
    if (previousBackend === undefined) delete process.env.FRIDAY_CHECKPOINT_BACKEND
    else process.env.FRIDAY_CHECKPOINT_BACKEND = previousBackend
    await rm(temporary, { recursive: true, force: true })
  }
})

test('both checkpoint backends restore file and directory type changes', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'friday-checkpoint-types-'))
  const home = join(temporary, 'home')
  await mkdir(home)
  const previousHome = process.env.FRIDAY_HOME
  const previousBackend = process.env.FRIDAY_CHECKPOINT_BACKEND
  process.env.FRIDAY_HOME = home
  try {
    for (const backend of ['git', 'files']) {
      const workspace = join(temporary, backend)
      await mkdir(join(workspace, 'directory-before'), { recursive: true })
      await writeFile(join(workspace, 'file-before'), 'file\n')
      await writeFile(join(workspace, 'directory-before', 'child.txt'), 'child\n')
      if (backend === 'files') process.env.FRIDAY_CHECKPOINT_BACKEND = 'files'
      else delete process.env.FRIDAY_CHECKPOINT_BACKEND
      const id = await beginCheckpoint({
        workspace, sessionId: `${backend}-types`, user: 'change path types', messages: []
      })
      await rm(join(workspace, 'file-before'), { force: true })
      await mkdir(join(workspace, 'file-before'))
      await writeFile(join(workspace, 'file-before', 'child.txt'), 'new child\n')
      await rm(join(workspace, 'directory-before'), { recursive: true, force: true })
      await writeFile(join(workspace, 'directory-before'), 'new file\n')
      await finishCheckpoint(workspace, id, false)

      await restoreCheckpoint(workspace, id)

      assert.equal(await readFile(join(workspace, 'file-before'), 'utf8'), 'file\n')
      assert.equal(await readFile(join(workspace, 'directory-before', 'child.txt'), 'utf8'), 'child\n')
    }
  } finally {
    if (previousHome === undefined) delete process.env.FRIDAY_HOME
    else process.env.FRIDAY_HOME = previousHome
    if (previousBackend === undefined) delete process.env.FRIDAY_CHECKPOINT_BACKEND
    else process.env.FRIDAY_CHECKPOINT_BACKEND = previousBackend
    await rm(temporary, { recursive: true, force: true })
  }
})

test('checkpoint restore refuses to overwrite ignored files at a type boundary', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'friday-checkpoint-ignored-'))
  const home = join(temporary, 'home')
  const workspace = join(temporary, 'workspace')
  await mkdir(home)
  await mkdir(workspace)
  const previousHome = process.env.FRIDAY_HOME
  const previousBackend = process.env.FRIDAY_CHECKPOINT_BACKEND
  process.env.FRIDAY_HOME = home
  process.env.FRIDAY_CHECKPOINT_BACKEND = 'files'
  try {
    await writeFile(join(workspace, '.gitignore'), 'target/\n')
    await writeFile(join(workspace, 'target'), 'original\n')
    const id = await beginCheckpoint({ workspace, sessionId: 'ignored-boundary', user: 'change type', messages: [] })
    await rm(join(workspace, 'target'), { force: true })
    await mkdir(join(workspace, 'target'))
    await writeFile(join(workspace, 'target', 'local-cache.bin'), 'keep me\n')
    await finishCheckpoint(workspace, id, false)

    await assert.rejects(restoreCheckpoint(workspace, id), /contains ignored files/)
    assert.equal(await readFile(join(workspace, 'target', 'local-cache.bin'), 'utf8'), 'keep me\n')
  } finally {
    if (previousHome === undefined) delete process.env.FRIDAY_HOME
    else process.env.FRIDAY_HOME = previousHome
    if (previousBackend === undefined) delete process.env.FRIDAY_CHECKPOINT_BACKEND
    else process.env.FRIDAY_CHECKPOINT_BACKEND = previousBackend
    await rm(temporary, { recursive: true, force: true })
  }
})

test('gateway undo restores both a mutating agent turn and its conversation boundary', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'friday-undo-turn-'))
  const home = join(temporary, 'home')
  const workspace = join(temporary, 'workspace')
  await mkdir(home)
  await mkdir(workspace)
  const previousHome = process.env.FRIDAY_HOME
  const previousBackend = process.env.FRIDAY_CHECKPOINT_BACKEND
  process.env.FRIDAY_HOME = home
  process.env.FRIDAY_CHECKPOINT_BACKEND = 'files'
  let calls = 0
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    calls += 1
    if (calls === 1) {
      sse(response, { choices: [{ delta: { tool_calls: [{
        index: 0, id: 'write-call', type: 'function',
        function: { name: 'Write', arguments: JSON.stringify({ path: 'undo-me.txt', content: 'created\n' }) }
      }] } }] })
    } else sse(response, { choices: [{ delta: { content: 'created the file' } }] })
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
    await gateway.handle({ id: 'chat', method: 'chat.send', params: { text: 'create a file' } })
    assert.equal(await readFile(join(workspace, 'undo-me.txt'), 'utf8'), 'created\n')
    await gateway.handle({ id: 'list', method: 'checkpoint.list' })
    const checkpoints = (responseResult(output, 'list') as { checkpoints: Array<{ id: string }> }).checkpoints
    assert.equal(checkpoints.length, 1)

    await gateway.handle({ id: 'undo', method: 'checkpoint.undo', params: { id: checkpoints[0]!.id } })

    const restored = responseResult(output, 'undo') as {
      history: unknown[]; changed_paths: string[]; info: { session_id: string }
    }
    assert.deepEqual(restored.changed_paths, ['undo-me.txt'])
    assert.deepEqual(restored.history, [])
    await assert.rejects(readFile(join(workspace, 'undo-me.txt'), 'utf8'), { code: 'ENOENT' })
    const snapshot = JSON.parse(await readFile(
      join(projectStateDir(workspace), 'sessions', `${restored.info.session_id}.json`), 'utf8'
    )) as Record<string, unknown>
    assert.equal(snapshot.user, '')
    assert.equal(snapshot.assistant, '')
  } finally {
    if (previousHome === undefined) delete process.env.FRIDAY_HOME
    else process.env.FRIDAY_HOME = previousHome
    if (previousBackend === undefined) delete process.env.FRIDAY_CHECKPOINT_BACKEND
    else process.env.FRIDAY_CHECKPOINT_BACKEND = previousBackend
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(temporary, { recursive: true, force: true })
  }
})

test('undoing a paused mutating turn discards its stale approval', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'friday-undo-approval-'))
  const home = join(temporary, 'home')
  const workspace = join(temporary, 'workspace')
  await mkdir(home)
  await mkdir(workspace)
  const previousHome = process.env.FRIDAY_HOME
  const previousMode = process.env.FRIDAY_PERMISSION_MODE
  process.env.FRIDAY_HOME = home
  process.env.FRIDAY_PERMISSION_MODE = 'manual'
  const command = process.platform === 'win32'
    ? "Set-Content -LiteralPath 'should-not-run.txt' -Value 'no'"
    : "printf 'no' > should-not-run.txt"
  let modelCalls = 0
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    modelCalls += 1
    const call = modelCalls === 1
      ? { index: 0, id: 'write-before-approval', type: 'function', function: { name: 'Write', arguments: JSON.stringify({ path: 'written.txt', content: 'temporary' }) } }
      : { index: 0, id: 'pending-shell', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command }) } }
    sse(response, { choices: [{ delta: { tool_calls: [call] } }] })
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

    await gateway.handle({ id: 'chat', method: 'chat.send', params: { text: 'make a temporary change' } })
    await gateway.handle({ id: 'pending', method: 'approval.pending' })
    assert.equal((responseResult(output, 'pending') as { pending: boolean }).pending, true)
    assert.equal(await readFile(join(workspace, 'written.txt'), 'utf8'), 'temporary')

    await gateway.handle({ id: 'undo', method: 'checkpoint.undo' })
    await gateway.handle({ id: 'cleared', method: 'approval.pending' })

    assert.equal((responseResult(output, 'cleared') as { pending: boolean }).pending, false)
    await assert.rejects(readFile(join(workspace, 'written.txt'), 'utf8'), { code: 'ENOENT' })
    await assert.rejects(readFile(join(workspace, 'should-not-run.txt'), 'utf8'), { code: 'ENOENT' })
    assert.equal(modelCalls, 2)
  } finally {
    if (previousHome === undefined) delete process.env.FRIDAY_HOME
    else process.env.FRIDAY_HOME = previousHome
    if (previousMode === undefined) delete process.env.FRIDAY_PERMISSION_MODE
    else process.env.FRIDAY_PERMISSION_MODE = previousMode
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(temporary, { recursive: true, force: true })
  }
})

test('a risky shell call pauses the session, executes once after approval, and resumes the model', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'friday-approval-'))
  const home = join(temporary, 'home')
  const workspace = join(temporary, 'workspace')
  await mkdir(home)
  await mkdir(workspace)
  const previousHome = process.env.FRIDAY_HOME
  const previousMode = process.env.FRIDAY_PERMISSION_MODE
  process.env.FRIDAY_HOME = home
  process.env.FRIDAY_PERMISSION_MODE = 'manual'
  let modelCalls = 0
  const command = process.platform === 'win32'
    ? "Set-Content -LiteralPath 'approved.txt' -Value 'yes'"
    : "printf 'yes' > approved.txt"
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    modelCalls += 1
    if (modelCalls === 1) {
      sse(response, { choices: [{ delta: { tool_calls: [{
        index: 0, id: 'shell-call', type: 'function',
        function: { name: 'Bash', arguments: JSON.stringify({ command }) }
      }] } }] })
    } else sse(response, { choices: [{ delta: { content: 'approved and complete' } }] })
    sse(response, { choices: [], usage: { prompt_tokens: 4, completion_tokens: 2 } })
    response.end('data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
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
    let session = await FridaySession.create(workspace, 'approval-session')

    const paused = await session.chat('write the approved file')

    assert.equal(paused.status, 'paused')
    assert.equal(session.approval().pending, true)
    await assert.rejects(readFile(join(workspace, 'approved.txt'), 'utf8'), { code: 'ENOENT' })
    await assert.rejects(session.chat('skip the approval'), /Resolve the pending approval/)
    session = await FridaySession.create(workspace, 'approval-session')
    const outcome = await session.approve()
    assert.equal(outcome.continued, true)
    assert.equal(outcome.turn?.status, 'done')
    assert.equal(outcome.turn?.text, 'approved and complete')
    assert.equal(outcome.turn?.metrics.requests, 2)
    assert.equal((await readFile(join(workspace, 'approved.txt'), 'utf8')).trim(), 'yes')
    assert.deepEqual(outcome.turn?.artifacts, [{ kind: 'text', name: 'approved.txt', path: 'approved.txt', size: process.platform === 'win32' ? 5 : 3 }])
    assert.equal((await artifactDetail(workspace, 'approved.txt')).content?.trim(), 'yes')
    await assert.rejects(artifactDetail(workspace, '../outside.txt'), /outside the workspace|relative/)
    assert.equal(session.approval().pending, false)
    assert.equal(modelCalls, 2)
    const snapshot = JSON.parse(await readFile(
      join(projectStateDir(workspace), 'sessions', 'approval-session.json'), 'utf8'
    )) as Record<string, unknown>
    const activityItems = (snapshot.activities as Array<{ items?: Array<Record<string, unknown>> }>)
      .flatMap(record => record.items ?? [])
    assert(activityItems.some(item => item.kind === 'tool' && item.tool_call_id === 'shell-call'))
    assert.equal((snapshot.artifacts as unknown[]).length, 1)
  } finally {
    if (previousHome === undefined) delete process.env.FRIDAY_HOME
    else process.env.FRIDAY_HOME = previousHome
    if (previousMode === undefined) delete process.env.FRIDAY_PERMISSION_MODE
    else process.env.FRIDAY_PERMISSION_MODE = previousMode
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(temporary, { recursive: true, force: true })
  }
})

test('automatic permission mode independently reviews a risky command before running it', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'friday-auto-permission-'))
  const home = join(temporary, 'home')
  const workspace = join(temporary, 'workspace')
  await mkdir(home)
  await mkdir(workspace)
  const previousHome = process.env.FRIDAY_HOME
  const previousMode = process.env.FRIDAY_PERMISSION_MODE
  process.env.FRIDAY_HOME = home
  process.env.FRIDAY_PERMISSION_MODE = 'auto'
  const command = process.platform === 'win32'
    ? "Set-Content -LiteralPath 'auto-approved.txt' -Value 'yes'"
    : "printf 'yes' > auto-approved.txt"
  let mainCalls = 0
  let reviewCalls = 0
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages?: unknown[] }
    const review = JSON.stringify(body.messages).includes('Review one shell command before execution')
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (review) {
      reviewCalls += 1
      sse(response, { choices: [{ delta: { content: '{"decision":"allow","reason":"requested workspace output"}' } }] })
    } else if (++mainCalls === 1) {
      sse(response, { choices: [{ delta: { tool_calls: [{
        index: 0, id: 'auto-shell-call', type: 'function',
        function: { name: 'Bash', arguments: JSON.stringify({ command }) }
      }] } }] })
    } else sse(response, { choices: [{ delta: { content: 'reviewed and complete' } }] })
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
    const session = await FridaySession.create(workspace, 'auto-permission-session')
    const events: string[] = []
    session.onEvent = event => events.push(event.type)

    const result = await session.chat('write auto-approved.txt')

    assert.equal(result.status, 'done')
    assert.equal(result.text, 'reviewed and complete')
    assert.equal(result.metrics.requests, 3)
    assert.equal((await readFile(join(workspace, 'auto-approved.txt'), 'utf8')).trim(), 'yes')
    assert.equal(reviewCalls, 1)
    assert(events.includes('approval.review'))
    assert.equal(session.approval().pending, false)
  } finally {
    if (previousHome === undefined) delete process.env.FRIDAY_HOME
    else process.env.FRIDAY_HOME = previousHome
    if (previousMode === undefined) delete process.env.FRIDAY_PERMISSION_MODE
    else process.env.FRIDAY_PERMISSION_MODE = previousMode
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(temporary, { recursive: true, force: true })
  }
})

test('the gateway announces a suspended turn and keeps continuation events ordered', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'friday-gateway-approval-'))
  const home = join(temporary, 'home')
  const workspace = join(temporary, 'workspace')
  await mkdir(home)
  await mkdir(workspace)
  const previousHome = process.env.FRIDAY_HOME
  const previousMode = process.env.FRIDAY_PERMISSION_MODE
  process.env.FRIDAY_HOME = home
  process.env.FRIDAY_PERMISSION_MODE = 'manual'
  const command = process.platform === 'win32'
    ? "Set-Content -LiteralPath 'gateway-approved.txt' -Value 'yes'"
    : "printf 'yes' > gateway-approved.txt"
  let modelCalls = 0
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    modelCalls += 1
    if (modelCalls === 1) {
      sse(response, { choices: [{ delta: { tool_calls: [{
        index: 0, id: 'gateway-shell-call', type: 'function',
        function: { name: 'Bash', arguments: JSON.stringify({ command }) }
      }] } }] })
    } else sse(response, { choices: [{ delta: { content: 'continued' } }] })
    response.end('data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  const output: unknown[] = []
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
    const gateway = new Gateway(workspace, value => output.push(value))
    await gateway.start()
    output.length = 0

    await gateway.handle({ id: 'chat', method: 'chat.send', params: { text: 'write a file' } })

    assert.deepEqual(eventTypes(output), [
      'message.start', 'session.updated', 'progress.update', 'tool.start', 'tool.complete',
      'progress.update', 'approval.pending', 'message.suspended', 'session.updated'
    ])
    assert.deepEqual(sessionRunningStates(output), [true, false])
    assert.equal(eventPayload(output, 'approval.pending').pending, true)
    assert.equal((eventPayload(output, 'tool.complete').approval as { approval_required?: boolean }).approval_required, true)
    await assert.rejects(readFile(join(workspace, 'gateway-approved.txt'), 'utf8'), { code: 'ENOENT' })
    output.length = 0

    await gateway.handle({ id: 'approve', method: 'approval.approve' })

    assert.deepEqual(eventTypes(output), [
      'session.updated', 'tool.update', 'approval.resolved', 'progress.update', 'message.delta',
      'progress.update', 'message.complete', 'session.updated'
    ])
    assert.deepEqual(sessionRunningStates(output), [true, false])
    const resolved = eventPayload(output, 'approval.resolved')
    assert.equal(resolved.decision, 'approve')
    assert.equal(resolved.continued, true)
    const response = output.find(value => (value as { id?: unknown }).id === 'approve') as { result: { continued: boolean } }
    assert.equal(response.result.continued, true)
    assert.equal((await readFile(join(workspace, 'gateway-approved.txt'), 'utf8')).trim(), 'yes')
    assert.deepEqual(eventPayload(output, 'message.complete').artifacts, [{
      kind: 'text', name: 'gateway-approved.txt', path: 'gateway-approved.txt', size: process.platform === 'win32' ? 5 : 3
    }])
    assert.deepEqual(eventPayload(output, 'message.complete').fork_points, [{ kind: 'assistant', message_index: 3 }])
    assert.equal(modelCalls, 2)
  } finally {
    if (previousHome === undefined) delete process.env.FRIDAY_HOME
    else process.env.FRIDAY_HOME = previousHome
    if (previousMode === undefined) delete process.env.FRIDAY_PERMISSION_MODE
    else process.env.FRIDAY_PERMISSION_MODE = previousMode
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(temporary, { recursive: true, force: true })
  }
})

function eventTypes(output: unknown[]): string[] {
  return output.flatMap(value => {
    const message = value as { method?: unknown; params?: { type?: unknown } }
    return message.method === 'event' && typeof message.params?.type === 'string' ? [message.params.type] : []
  })
}

function eventPayload(output: unknown[], type: string): Record<string, unknown> {
  const value = output.find(item => {
    const message = item as { method?: unknown; params?: { type?: unknown } }
    return message.method === 'event' && message.params?.type === type
  }) as { params?: { payload?: Record<string, unknown> } } | undefined
  assert(value?.params?.payload, `Missing ${type} event.`)
  return value.params.payload
}

function sessionRunningStates(output: unknown[]): boolean[] {
  return output.flatMap(value => {
    const message = value as { method?: unknown; params?: { type?: unknown; payload?: { running?: unknown } } }
    return message.method === 'event' && message.params?.type === 'session.updated' && typeof message.params.payload?.running === 'boolean'
      ? [message.params.payload.running]
      : []
  })
}

test('a message sent mid-turn steers the running model before its next step', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'friday-steer-'))
  const home = join(temporary, 'home')
  const workspace = join(temporary, 'workspace')
  await mkdir(home)
  await mkdir(workspace)
  const previousHome = process.env.FRIDAY_HOME
  process.env.FRIDAY_HOME = home
  const requests: Array<Record<string, unknown>> = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      requests.push(JSON.parse(body) as Record<string, unknown>)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (requests.length === 1) {
        // A slow tool keeps the turn alive long enough for the steer to land.
        sse(response, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'slow-1', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: 'node -e "setTimeout(() => process.exit(0), 1500)"' }) } }] } }] })
        sse(response, { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } })
      } else {
        sse(response, { choices: [{ delta: { content: 'steered and finished' } }] })
        sse(response, { choices: [], usage: { prompt_tokens: 9, completion_tokens: 3 } })
      }
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  try {
    await writeFile(join(home, 'models.json'), JSON.stringify({
      active: 'steer', profiles: [{
        id: 'steer', name: 'Steer', provider: 'openai-compatible', model: 'mock',
        base_url: `http://127.0.0.1:${address.port}`, context_window: 100_000, max_output_tokens: 2_000
      }]
    }))
    await writeFile(join(home, 'model-credentials.json'), JSON.stringify({ steer: 'secret' }))
    const output: unknown[] = []
    const gateway = new Gateway(workspace, value => output.push(value))
    await gateway.start()
    await gateway.handle({ id: 'permission', method: 'permission.set', params: { mode: 'bypass' } })
    output.length = 0
    const run = gateway.handle({ id: 'chat', method: 'chat.send', params: { text: 'start the slow work' } })
    // Wait until the first model step answered and the slow tool is running.
    for (let waited = 0; requests.length < 1 && waited < 100; waited += 1) await new Promise(resolve => setTimeout(resolve, 50))
    await new Promise(resolve => setTimeout(resolve, 300))
    await gateway.handle({ id: 'steer', method: 'chat.steer', params: { text: 'actually, focus on the tests only' } })
    assert.equal((responseResult(output, 'steer') as { steered: boolean }).steered, true)
    await run
    // The second model request must contain the injected user message, and it
    // must sit AFTER the tool exchange - never between a call and its result.
    const messages = requests[1]!.messages as Array<{ role: string; content?: unknown }>
    const steerIndex = messages.findIndex(message => message.role === 'user' && String(message.content).includes('focus on the tests only'))
    const toolIndex = messages.findIndex(message => message.role === 'tool')
    assert(toolIndex > 0)
    assert(steerIndex > toolIndex)
    // The steered event was announced for every window on this session.
    assert.equal(output.some(value => {
      const message = value as { method?: string; params?: { type?: string; payload?: { text?: string } } }
      return message.method === 'event' && message.params?.type === 'message.steered'
        && message.params.payload?.text === 'actually, focus on the tests only'
    }), true)
    assert.equal((responseResult(output, 'chat') as { text: string }).text, 'steered and finished')
  } finally {
    if (previousHome === undefined) delete process.env.FRIDAY_HOME
    else process.env.FRIDAY_HOME = previousHome
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(temporary, { recursive: true, force: true })
  }
})

test('a steer during a single-step streaming turn runs as a clean follow-up turn', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'friday-steer-late-'))
  const home = join(temporary, 'home')
  const workspace = join(temporary, 'workspace')
  await mkdir(home)
  await mkdir(workspace)
  const previousHome = process.env.FRIDAY_HOME
  process.env.FRIDAY_HOME = home
  const requests: Array<Record<string, unknown>> = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      requests.push(JSON.parse(body) as Record<string, unknown>)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (requests.length === 1) {
        // A pure text answer with NO tool step: the stream stays open long
        // enough for a steer to arrive, but there is no next model step to
        // deliver it into - the follow-up path must handle it.
        sse(response, { choices: [{ delta: { content: 'first answer' } }] })
        setTimeout(() => {
          sse(response, { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } })
          response.end('data: [DONE]\n\n')
        }, 600)
      } else {
        sse(response, { choices: [{ delta: { content: 'follow-up done' } }] })
        sse(response, { choices: [], usage: { prompt_tokens: 9, completion_tokens: 3 } })
        response.end('data: [DONE]\n\n')
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  try {
    await writeFile(join(home, 'models.json'), JSON.stringify({
      active: 'late', profiles: [{
        id: 'late', name: 'Late', provider: 'openai-compatible', model: 'mock',
        base_url: `http://127.0.0.1:${address.port}`, context_window: 100_000, max_output_tokens: 2_000
      }]
    }))
    await writeFile(join(home, 'model-credentials.json'), JSON.stringify({ late: 'secret' }))
    const output: unknown[] = []
    const gateway = new Gateway(workspace, value => output.push(value))
    await gateway.start()
    output.length = 0
    const run = gateway.handle({ id: 'chat', method: 'chat.send', params: { text: 'write a poem' } })
    for (let waited = 0; requests.length < 1 && waited < 100; waited += 1) await new Promise(resolve => setTimeout(resolve, 25))
    await new Promise(resolve => setTimeout(resolve, 150))
    await gateway.handle({ id: 'steer', method: 'chat.steer', params: { text: 'make it about the sea' } })
    assert.equal((responseResult(output, 'steer') as { steered: boolean }).steered, true)
    await run
    // The original turn completed normally - the follow-up dispatch must not
    // trip the idle guard and poison it.
    assert.equal((responseResult(output, 'chat') as { text: string }).text, 'first answer')
    // The follow-up turn runs on its own and carries the steer text.
    for (let waited = 0; requests.length < 2 && waited < 200; waited += 1) await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(requests.length, 2)
    const messages = requests[1]!.messages as Array<{ role: string; content?: unknown }>
    assert.equal(messages.some(message => message.role === 'user' && String(message.content).includes('make it about the sea')), true)
    const followUpDone = async () => {
      for (let waited = 0; waited < 200; waited += 1) {
        const done = output.some(value => {
          const message = value as { method?: string; params?: { type?: string; payload?: { text?: string } } }
          return message.method === 'event' && message.params?.type === 'message.complete'
            && message.params.payload?.text === 'follow-up done'
        })
        if (done) return true
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return false
    }
    assert.equal(await followUpDone(), true)
    // The follow-up announced its user message so every window renders it.
    assert.equal(output.some(value => {
      const message = value as { method?: string; params?: { type?: string; payload?: { text?: string } } }
      return message.method === 'event' && message.params?.type === 'message.start'
        && message.params.payload?.text === 'make it about the sea'
    }), true)
  } finally {
    if (previousHome === undefined) delete process.env.FRIDAY_HOME
    else process.env.FRIDAY_HOME = previousHome
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(temporary, { recursive: true, force: true })
  }
})

function responseResult(output: unknown[], id: string): unknown {
  const message = output.find(value => (value as { id?: unknown }).id === id) as { result?: unknown; error?: unknown } | undefined
  assert(message && !message.error, `Missing successful response ${id}.`)
  return message.result
}

function currentSession(output: unknown[]): string {
  const response = output.find(value => (value as { id?: unknown }).id === 'chat') as { result?: { session_id?: unknown } } | undefined
  const id = response?.result?.session_id
  assert.equal(typeof id, 'string')
  return id as string
}

function sse(response: ServerResponse, value: unknown): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`)
}
