import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { ModelRequestError } from 'friday-agent-core'
import { FridaySession } from 'friday-agent-harness'

// A fixed, offline runtime baseline. Harbor remains the model-quality evaluation path.
const baseline = JSON.parse(await readFile(new URL('../evaluations/runtime/baseline.json', import.meta.url), 'utf8'))
const previous = process.env.FRIDAY_HOME
const root = await mkdtemp(join(tmpdir(), 'friday-runtime-eval-'))
const results = []
try {
  for (const task of baseline.cases) {
    const workspace = join(root, task.id)
    await mkdir(workspace)
    process.env.FRIDAY_HOME = join(root, 'state', task.id)
    let requests = 0
    const started = performance.now()
    const session = await FridaySession.create(workspace, task.id, {
      builtinCapabilities: ['workspace'],
      config: { profileId: 'eval', profileName: 'Eval', model: 'scripted', provider: 'openai-compatible', apiKey: '', baseUrl: 'http://127.0.0.1:9', contextWindow: 100_000, maxOutputTokens: 2_000 },
      modelFactory: () => ({ async complete(request) {
        requests++
        if (requests === 1) return { role: 'assistant', content: task.mode === 'truncated' ? 'partial' : '',
          tool_calls: [{ id: 'write', type: 'function', function: { name: 'Write', arguments: '{"path":"marker.txt","content":"persisted"}' } }],
          ...(task.mode === 'truncated' ? { termination: { reason: 'length' } } : {}), usage: { input_tokens: 10, output_tokens: 4 } }
        if (task.mode === 'failure') throw new ModelRequestError(500, 'scripted upstream failure')
        if (requests === 2) return { role: 'assistant', content: '', tool_calls: [{ id: 'read', type: 'function', function: { name: 'Read', arguments: '{"path":"marker.txt"}' } }] }
        assert.match(String(request.messages.at(-1)?.content), /persisted/)
        return { role: 'assistant', content: 'verified' }
      } })
    })
    let status
    try { status = (await session.chat('Write and verify a marker')).status }
    catch { status = 'error' }
    const content = await readFile(join(workspace, 'marker.txt'), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error })
    const passed = status === task.expectedStatus && content === task.expectedFile
      && (task.mode !== 'failure' || session.context.messages.some(message => message.role === 'tool' && message.is_error === false))
    results.push({ id: task.id, passed, status, requests, elapsed_ms: Math.round(performance.now() - started) })
    await session.close()
  }
} finally {
  if (previous === undefined) delete process.env.FRIDAY_HOME
  else process.env.FRIDAY_HOME = previous
  await rm(root, { recursive: true, force: true })
}
const output = resolve('artifacts/evals/runtime-latest.json')
await mkdir(resolve('artifacts/evals'), { recursive: true })
await writeFile(output, JSON.stringify({ baseline_version: baseline.version, created: new Date().toISOString(), results }, null, 2) + '\n')
console.log(`${results.filter(result => result.passed).length}/${results.length} runtime cases passed. ${output}`)
if (results.some(result => !result.passed)) process.exitCode = 1
