import assert from 'node:assert/strict'
import { execFile, fork } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ModelRequestError, type ChatModel, type Message } from 'friday-agent-core'
import { FridaySession, type SessionOptions } from './session.js'
import { projectStateDir, type ModelConfig } from './config.js'
import { loadPlugins, trustPlugin } from './plugins.js'
import { collectMessageObjects, readMessagePage, readRecord, writeRecord } from './records.js'
import { ResourceBudget, withModelTimeouts } from './resources.js'
import { verifyGoal } from './verification.js'
import { buildTools, buildVerifierTools } from './tools.js'
import { writeTrace } from './trace.js'
import { validateRpcRequest } from './rpc.js'

const config: ModelConfig = { profileId: 'test', profileName: 'Test', provider: 'openai-compatible', model: 'test', apiKey: '', baseUrl: 'http://127.0.0.1:9', contextWindow: 100_000, maxOutputTokens: 2_000 }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'friday-reliability-'))
  const workspace = join(root, 'workspace')
  const home = join(root, 'home')
  await mkdir(workspace); await mkdir(home)
  const previous = process.env.FRIDAY_HOME
  process.env.FRIDAY_HOME = home
  return { workspace, home, root, async close() {
    if (previous === undefined) delete process.env.FRIDAY_HOME
    else process.env.FRIDAY_HOME = previous
    await rm(root, { recursive: true, force: true })
  } }
}
const options = (model: ChatModel): SessionOptions => ({ config, builtinCapabilities: ['workspace'], modelFactory: () => model })

test('completed file effects, usage and traces survive a subsequent failed model request', async () => {
  const f = await fixture()
  let requests = 0
  let session: FridaySession | undefined
  try {
    session = await FridaySession.create(f.workspace, 'failed', options({ async complete() {
      if (++requests > 1) throw new ModelRequestError(500, 'unavailable')
      return { role: 'assistant', content: '', tool_calls: [{ id: 'write', type: 'function', function: { name: 'Write', arguments: '{"path":"marker.txt","content":"kept"}' } }], usage: { input_tokens: 10, output_tokens: 5 } }
    } }))
    await assert.rejects(session.chat('Write a marker'), /unavailable/)
    assert.equal(await readFile(join(f.workspace, 'marker.txt'), 'utf8'), 'kept')
    const saved = await readRecord(f.workspace, join(projectStateDir(f.workspace), 'sessions', 'failed.json'))
    assert((saved.messages as Message[]).some(message => message.role === 'tool' && message.is_error === false))
    assert.equal((saved.execution as { status: string }).status, 'error')
    assert.equal((saved.last_usage as { input_tokens: number }).input_tokens, 10)
    assert.equal((saved.resources as { requests: number }).requests, 4)
    assert.equal((await readdir(join(projectStateDir(f.workspace), 'traces-ts'))).filter(name => name.endsWith('.json')).length, 1)
    const restored = await FridaySession.create(f.workspace, 'failed', options({ async complete() { return { role: 'assistant', content: 'resumed' } } }))
    assert(restored.context.messages.some(message => message.role === 'tool'))
    await restored.close()
  } finally { await session?.close(); await f.close() }
})

test('recovery repairs unknown tool outcomes without replaying tool side effects', async () => {
  const f = await fixture()
  try {
    await writeRecord(f.workspace, join(projectStateDir(f.workspace), 'sessions', 'crash.json'), {
      session_id: 'crash', turns: 1, revision: 1, execution: { id: 'prior-run', status: 'running' },
      messages: [{ role: 'user', content: 'write' }, { role: 'assistant', content: '', tool_calls: [{ id: 'uncertain', type: 'function', function: { name: 'Write', arguments: '{}' } }] }]
    })
    const session = await FridaySession.create(f.workspace, 'crash', options({ async complete() { assert.fail('recovery must not dispatch a model') } }))
    const result = session.context.messages.at(-1)!
    assert.equal(result.role, 'tool')
    assert.equal(result.is_error, true)
    assert.match(String(result.content), /Effects may already exist/)
    const saved = await readRecord(f.workspace, join(projectStateDir(f.workspace), 'sessions', 'crash.json'))
    assert.equal((saved.execution as { status: string }).status, 'interrupted')
    await session.close()
  } finally { await f.close() }
})

test('untrusted and disabled plugin modules never execute during discovery', async () => {
  const f = await fixture()
  try {
    const root = join(f.workspace, '.friday', 'plugins')
    await mkdir(root, { recursive: true })
    const marker = join(f.root, 'imported')
    await writeFile(join(root, 'entry.mjs'), `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'yes');export default {name:'stable-id'}`)
    await writeFile(join(root, 'entry.plugin.json'), JSON.stringify({ api_version: 1, name: 'stable-id' }))
    const discovered = await loadPlugins(f.workspace)
    assert.equal(discovered[0]?.trusted, false)
    await assert.rejects(stat(marker), /ENOENT/)
    await trustPlugin(f.workspace, 'stable-id', discovered[0]!.digest!)
    await writeFile(join(f.home, 'config.json'), JSON.stringify({ disabled_plugins: ['stable-id'] }))
    assert.equal((await loadPlugins(f.workspace))[0]?.disabled, true)
    await assert.rejects(stat(marker), /ENOENT/)
  } finally { await f.close() }
})

test('host plugins activate and dispose once per generation and reload only at idle boundaries', async () => {
  const f = await fixture()
  let activated = 0
  let disposed = 0
  let started!: () => void
  let finish!: () => void
  const running = new Promise<void>(resolve => { started = resolve })
  const pending = new Promise<void>(resolve => { finish = resolve })
  try {
    const session = await FridaySession.create(f.workspace, 'lifecycle', {
      ...options({ async complete() { started(); await pending; return { role: 'assistant', content: 'done' } } }), builtinCapabilities: [],
      plugins: [{ name: 'custom', activate() { activated++; return () => { disposed++ } }, tools: () => [] }]
    })
    const turn = session.chat('go')
    await running
    await assert.rejects(session.reloadPlugins(), /idle/)
    finish(); await turn
    await session.reloadPlugins()
    assert.equal(activated, 2)
    assert.equal(disposed, 1)
    await session.close()
    assert.equal(disposed, 2)
  } finally { finish?.(); await f.close() }
})

test('cross-process locks preserve every read-modify-write update', async () => {
  const f = await fixture()
  try {
    const path = join(f.root, 'counter.json')
    await writeFile(path, '0')
    const worker = `import {readFile} from 'node:fs/promises';import {withStateLock,writeJsonAtomic} from ${JSON.stringify(new URL('./storage.js', import.meta.url).href)};for(let i=0;i<4;i++) await withStateLock(process.argv[1],async()=>{const n=JSON.parse(await readFile(process.argv[1],'utf8'));await new Promise(r=>setTimeout(r,15));await writeJsonAtomic(process.argv[1],n+1)})`
    await Promise.all([1, 2].map(() => promisify(execFile)(process.execPath, ['--input-type=module', '-e', worker, path])))
    assert.equal(JSON.parse(await readFile(path, 'utf8')), 8)
  } finally { await f.close() }
})

test('atomic edits preserve executable mode and Read makes progress within long lines', async () => {
  const f = await fixture()
  try {
    const tools = buildTools(f.workspace)
    await writeFile(join(f.workspace, 'run.sh'), 'old', { mode: 0o755 })
    await tools.find(tool => tool.name === 'Edit')!.execute({ path: 'run.sh', edits: [{ old_text: 'old', new_text: 'new' }] })
    if (process.platform !== 'win32') assert.equal((await stat(join(f.workspace, 'run.sh'))).mode & 0o777, 0o755)
    await writeFile(join(f.workspace, 'long.txt'), 'x'.repeat(50_001))
    const read = tools.find(tool => tool.name === 'Read')!
    const page = await read.execute({ path: 'long.txt' }) as Record<string, unknown>
    assert.equal(String(page.content).length, 50_000)
    const tail = await read.execute({ path: 'long.txt', start_line: page.next_start_line, start_column: page.next_start_column }) as Record<string, unknown>
    assert.equal(tail.content, 'x')
    assert.equal(tail.next_start_line, undefined)
  } finally { await f.close() }
})

test('resource request limits and model timeouts stop even a custom model ignoring cancellation', async () => {
  const budget = new ResourceBudget({ requests: 2 })
  let calls = 0
  const model = budget.wrap({ async complete() { calls++; return { role: 'assistant', content: 'ok', usage: { input_tokens: 3, output_tokens: 2 } } } })
  await model.complete({ messages: [] }); await model.complete({ messages: [] })
  await assert.rejects(model.complete({ messages: [] }), /budget exhausted/)
  assert.equal(calls, 2)
  assert.equal(budget.state.tokens, 10)
  const stuck = withModelTimeouts({ complete: () => new Promise(() => {}) }, { firstByteMs: 15 })
  await assert.rejects(stuck.complete({ messages: [] }), /first-byte timeout/)
})

test('immutable pages are shared by checkpoints and forks and support bounded reads', async () => {
  const f = await fixture()
  try {
    const messages: Message[] = Array.from({ length: 70 }, (_, index) => ({ role: 'user', content: `message ${index}` }))
    const path = join(projectStateDir(f.workspace), 'sessions', 'pages.json')
    await writeRecord(f.workspace, path, { session_id: 'pages', messages })
    await writeRecord(f.workspace, join(f.root, 'checkpoint.json'), { before_messages: messages })
    assert.equal((await readdir(join(projectStateDir(f.workspace), 'message-objects'))).length, 3)
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    assert.deepEqual(await readMessagePage(f.workspace, raw.messages, 31, 3), messages.slice(31, 34))
  } finally { await f.close() }
})

test('verifier rejects fabricated evidence and accepts references to its actual successful checks', async () => {
  const f = await fixture()
  try {
    const result = await verifyGoal({ workspace: f.workspace, config, thinking: 'off', goal: 'inspect workspace', model: { async complete() { return { role: 'assistant', content: '{"verdict":"pass","evidence":["it passed [tool:fake]"]}' } } } })
    assert.equal(result.verdict, 'inconclusive')
    let calls = 0
    const verified = await verifyGoal({ workspace: f.workspace, config, thinking: 'off', goal: 'inspect workspace', model: { async complete() {
      return ++calls === 1 ? { role: 'assistant', content: '', tool_calls: [{ id: 'inspect', type: 'function', function: { name: 'Read', arguments: '{"path":"."}' } }] }
        : { role: 'assistant', content: '{"verdict":"pass","evidence":["directory inspected [tool:inspect]"]}' }
    } } })
    assert.equal(verified.verdict, 'pass')
  } finally { await f.close() }
})

test('protocol rejects unsupported versions and wrong parameter types before dispatch', () => {
  assert.throws(() => validateRpcRequest({ protocol_version: 99, method: 'session.info' }), /protocol version/)
  assert.throws(() => validateRpcRequest({ method: 'plugin.toggle', params: { name: 'web', enabled: 'true' } }), /boolean/)
  assert.throws(() => validateRpcRequest({ method: 'chat.send', params: [] }), /object/)
  assert.equal(validateRpcRequest({ method: 'session.info' }).method, 'session.info')
})

test('a killed process leaves the completed tool result recoverable from disk', async () => {
  const f = await fixture()
  let worker: ReturnType<typeof fork> | undefined
  try {
    const path = join(f.root, 'crash-worker.mjs')
    await writeFile(path, `import {FridaySession} from ${JSON.stringify(new URL('./session.js', import.meta.url).href)};
      let calls=0;const session=await FridaySession.create(${JSON.stringify(f.workspace)},'killed',{
        config:${JSON.stringify(config)},builtinCapabilities:['workspace'],modelFactory:()=>({async complete(){
          if(++calls===1)return {role:'assistant',content:'',tool_calls:[{id:'write',type:'function',function:{name:'Write',arguments:JSON.stringify({path:'survivor',content:'durable'})}}]};
          process.send('ready');return new Promise(()=>{});
        }})});await session.chat('write');`)
    worker = fork(path, [], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Crash worker did not reach durable boundary')), 10_000)
      worker!.once('message', () => { clearTimeout(timeout); resolve() })
      worker!.once('exit', code => { clearTimeout(timeout); reject(new Error(`Crash worker exited early: ${code}`)) })
    })
    const exited = new Promise<void>(resolve => worker!.once('exit', () => resolve()))
    worker.kill('SIGKILL'); await exited
    // Simulate the normal stale-lock expiry without making this regression wait 30 seconds.
    const old = new Date(Date.now() - 60_000)
    await utimes(join(projectStateDir(f.workspace), 'execution-killed.lock'), old, old)
    const recovered = await FridaySession.create(f.workspace, 'killed', options({ async complete() { assert.fail('recovery must not replay') } }))
    assert.equal(await readFile(join(f.workspace, 'survivor'), 'utf8'), 'durable')
    assert(recovered.context.messages.some(message => message.role === 'tool' && message.tool_call_id === 'write' && message.is_error === false))
    await recovered.close()
  } finally { worker?.kill('SIGKILL'); await f.close() }
})

test('execution backend receives verifier read-only policy and GC preserves live pages', async () => {
  const f = await fixture()
  try {
    const seen: boolean[] = []
    const execution = { name: 'test-isolation', async execute(request: { readOnly: boolean }) { seen.push(request.readOnly); return { stdout: 'checked', exit_code: 0 } } }
    await buildTools(f.workspace, { execution }).find(tool => tool.name === 'Bash')!.execute({ command: 'echo checked' })
    await buildVerifierTools(f.workspace, execution).find(tool => tool.name === 'Bash')!.execute({ command: 'echo checked' })
    assert.deepEqual(seen, [false, true])
    const path = join(projectStateDir(f.workspace), 'sessions', 'gc.json')
    await writeRecord(f.workspace, path, { session_id: 'gc', messages: [{ role: 'user', content: 'old' }] })
    await writeRecord(f.workspace, path, { session_id: 'gc', messages: [{ role: 'user', content: 'new' }] })
    assert.equal((await collectMessageObjects(f.workspace)).removed, 1)
    assert.equal(((await readRecord(f.workspace, path)).messages as Message[])[0]?.content, 'new')
    for (let index = 0; index < 3; index++) await writeTrace({ workspace: f.workspace, sessionId: 'gc', mode: 'test', status: 'done', events: [], retention: { maxFiles: 2 } })
    assert.equal((await readdir(join(projectStateDir(f.workspace), 'traces-ts'))).filter(name => name.endsWith('.json')).length, 2)
  } finally { await f.close() }
})
