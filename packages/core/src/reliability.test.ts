import assert from 'node:assert/strict'
import test from 'node:test'
import { Agent, AnthropicModel, ModelStreamError, OpenAIModel, RunContext, ToolExecutor, normalizeUsage, type Tool, type ToolCall } from './index.js'
import { readSseJson } from './sse.js'

const call = (args: string): ToolCall => ({ id: 'one', type: 'function', function: { name: 'Write', arguments: args } })

test('invalid JSON and schema violations never reach tool preflight or execution', async () => {
  let effects = 0
  const tool: Tool = { name: 'Write', description: '', parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string' } }, additionalProperties: false },
    preflight: () => { effects++; return { action: 'allow' } }, execute: () => { effects++ } }
  const executor = new ToolExecutor([tool])
  for (const args of ['{bad', '[]', '{}', '{"path":42}', '{"path":"a","extra":1}']) {
    assert.equal((await executor.preflightAll([call(args)]))?.results[0]?.isError, true)
    assert.equal((await executor.execute(call(args))).isError, true)
  }
  assert.equal(effects, 0)
})

test('tool error envelopes and durable checkpoints reach the transcript before the next model request', async () => {
  let checkpointed = false
  let requests = 0
  const agent = new Agent({
    model: { async complete() {
      if (++requests === 1) return { role: 'assistant', content: '', tool_calls: [call('{}')] }
      assert(checkpointed)
      assert.equal(agent.context.messages.at(-1)?.is_error, true)
      return { role: 'assistant', content: 'handled' }
    } },
    tools: [{ name: 'Write', description: '', parameters: {}, execute: () => ({ isError: true, message: 'failed' }) }],
    checkpoint: async (_context, boundary) => { if (boundary === 'tool') checkpointed = true }
  })
  assert.equal((await agent.run('go')).text, 'handled')
})

test('SSE supports multi-line events and releases the reader on terminal sentinel', async () => {
  const body = new Response('data: {"value":\ndata: 1}\n\ndata: [DONE]\n\n').body!
  let done = false
  const values = []
  for await (const value of readSseJson(body, { onDone: () => { done = true } })) values.push(value)
  assert.deepEqual(values, [{ value: 1 }])
  assert(done)
  assert.equal(body.locked, false)
})

test('unexpected EOF preserves partial output as failure and never executes tools', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial', tool_calls: [call('{}')] } }] })}\n\n`)
  let executed = false
  try {
    const agent = new Agent({ model: new OpenAIModel({ apiKey: 'test', model: 'test' }), tools: [{ name: 'Write', description: '', parameters: {}, execute() { executed = true } }] })
    await assert.rejects(agent.run('go'), ModelStreamError)
    assert.equal(agent.context.messages.at(-1)?.content, 'partial')
    assert.equal(agent.context.messages.at(-1)?.tool_calls, undefined)
    assert.equal(executed, false)
  } finally { globalThis.fetch = original }
})

test('Anthropic stream error is explicit and prompt occupancy includes cache reads and writes', async () => {
  const usage = { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 2_000 }
  const context = new RunContext()
  context.recordUsage(usage)
  assert.equal(context.usage.inputTokens, 102_050)
  assert.equal(context.usage.cachedTokens, 100_000)
  assert.equal(normalizeUsage(usage).cacheWrite, 2_000)
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response([
    { type: 'message_start', message: { usage } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
    { type: 'error', error: { type: 'overloaded_error' } }
  ].map(value => `data: ${JSON.stringify(value)}\n\n`).join(''))
  try { await assert.rejects(new AnthropicModel({ apiKey: 'test', model: 'test' }).complete({ messages: [] }), /overloaded_error/) }
  finally { globalThis.fetch = original }
})

test('output-length termination is incomplete and cannot execute even valid tool arguments', async () => {
  const agent = new Agent({ model: { async complete() { return { role: 'assistant', content: 'cut short', tool_calls: [call('{}')], termination: { reason: 'length' } } } },
    tools: [{ name: 'Write', description: '', parameters: {}, execute() { assert.fail('must not execute') } }] })
  assert.equal((await agent.run('go')).status, 'incomplete')
})
