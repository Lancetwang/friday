import assert from 'node:assert/strict'
import test from 'node:test'
import { AnthropicModel, OpenAIModel, ResponsesModel, ToolExecutor, modelOrigin, projectMessages, type Message, type ModelOrigin } from './index.js'

const fixtures = {
  'chat-completions': [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }, '[DONE]'],
  responses: [{ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] } }],
  anthropic: [{ type: 'message_start', message: {} }, { type: 'content_block_start', index: 0, content_block: { type: 'text' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }, { type: 'message_stop' }]
}

test('every adapter applies request-only output caps and cannot override them with body options', async () => {
  const original = globalThis.fetch
  try {
    for (const api of ['chat-completions', 'responses', 'anthropic'] as const) {
      const Adapter = api === 'anthropic' ? AnthropicModel : api === 'responses' ? ResponsesModel : OpenAIModel
      const field = api === 'responses' ? 'max_output_tokens' : 'max_tokens'
      let captured: Record<string, unknown> = {}
      globalThis.fetch = async (_url, init) => {
        captured = JSON.parse(String(init?.body))
        return new Response(fixtures[api].map(value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`).join(''))
      }
      for (const [configured, requested, expected] of [[undefined, 7, 7], [20, 7, 7], [5, 7, 5], [8, undefined, 8]]) {
        const model = new Adapter({ apiKey: 'test', model: 'test', ...(configured === undefined ? {} : { maxOutputTokens: configured }), body: { [field]: 999 } })
        await model.complete({ messages: [{ role: 'user', content: 'hello' }], ...(requested === undefined ? {} : { maxOutputTokens: requested }) })
        assert.equal(captured[field], expected, api)
      }
      await assert.rejects(new Adapter({ apiKey: 'test', model: 'test' }).complete({ messages: [], maxOutputTokens: 0 }), /positive integer/)
    }
  } finally { globalThis.fetch = original }
})

test('provider reasoning is replayed only to its producing model and never corrupts another API', async () => {
  const original = globalThis.fetch
  try {
    for (const api of ['chat-completions', 'responses', 'anthropic'] as const) {
      const Adapter = api === 'anthropic' ? AnthropicModel : api === 'responses' ? ResponsesModel : OpenAIModel
      let captured = ''
      globalThis.fetch = async (_url, init) => {
        captured = String(init?.body)
        return new Response(fixtures[api].map(value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`).join(''))
      }
      for (const sourceApi of ['chat-completions', 'responses', 'anthropic'] as const) {
        const reasoning = sourceApi === 'anthropic' ? [{ type: 'thinking', thinking: 'private', signature: 'signed-original' }]
          : sourceApi === 'responses' ? [{ type: 'reasoning', id: 'rs_original', summary: [] }] : 'private-original'
        const messages: Message[] = [{ role: 'user', content: 'inspect' }, { role: 'assistant', content: 'public answer',
          reasoning_content: reasoning, model_origin: modelOrigin(sourceApi, { model: 'test' }) }]
        const before = JSON.stringify(messages)
        const result = await new Adapter({ apiKey: 'test', model: 'test' }).complete({ messages })
        assert.equal(captured.includes(sourceApi === 'anthropic' ? 'signed-original' : sourceApi === 'responses' ? 'rs_original' : 'private-original'), sourceApi === api)
        assert(captured.includes('public answer'))
        assert.equal(result.model_origin?.api, api)
        assert.equal(JSON.stringify(messages), before)
      }
      await new Adapter({ apiKey: 'test', model: 'different' }).complete({ messages: [{ role: 'assistant', content: 'public',
        reasoning_content: api === 'anthropic' ? [{ type: 'thinking', thinking: 'private', signature: 'signed-original' }]
          : api === 'responses' ? [{ type: 'reasoning', id: 'rs_original', summary: [] }] : 'private-original',
        model_origin: modelOrigin(api, { model: 'test' }) }] })
      assert(!captured.includes('original'))
    }
  } finally { globalThis.fetch = original }
})

test('legacy replay repairs interrupted tool turns and projects unsupported images without changing storage', () => {
  const target: ModelOrigin = modelOrigin('anthropic', { model: 'test' })
  const longId = 'foreign/id|'.repeat(20)
  const source: Message[] = [{ role: 'assistant', content: '', reasoning_content: [{ type: 'reasoning', id: 'foreign' }],
    tool_calls: [{ id: longId, type: 'function', function: { name: 'Read', arguments: '{}' } }] },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,test' } }] }]
  const projected = projectMessages(source, target, false)
  assert.equal(projected[0]?.reasoning_content, undefined)
  assert.equal(projected[1]?.role, 'tool')
  assert.equal(projected[1]?.is_error, true)
  assert.match(String(projected[1]?.tool_call_id), /^[A-Za-z0-9_-]{1,64}$/)
  assert.equal((projected[0]?.tool_calls as Array<{id:string}>)[0]?.id, projected[1]?.tool_call_id)
  assert.match(JSON.stringify(projected[2]?.content), /Image omitted/)
  const duplicate = projectMessages([{ role: 'assistant', content: '', tool_calls: [
    { id: 'repeated', type: 'function', function: { name: 'Read', arguments: '{}' } },
    { id: 'repeated', type: 'function', function: { name: 'Read', arguments: '{}' } }
  ] }, { role: 'tool', tool_call_id: 'repeated', content: 'first' }, { role: 'tool', tool_call_id: 'repeated', content: 'second' }], target)
  const ids = (duplicate[0]?.tool_calls as Array<{ id: string }>).map(call => call.id)
  assert.notEqual(ids[0], ids[1]); assert.deepEqual(duplicate.slice(1).map(message => message.tool_call_id), ids)
  assert.equal((source[0]?.tool_calls as Array<{id:string}>)[0]?.id, longId)
  assert(source[0]?.reasoning_content)
})

test('cooperative tools finish cleanup before cancellation is observable', async () => {
  const controller = new AbortController()
  let cleanup = false
  let began = () => {}
  const started = new Promise<void>(resolve => { began = resolve })
  const executor = new ToolExecutor([{ name: 'Write', description: '', parameters: {}, abortMode: 'settle', async execute(_args, signal) {
    began()
    await new Promise<void>(resolve => signal!.addEventListener('abort', () => setTimeout(resolve, 20), { once: true }))
    cleanup = true
    signal!.throwIfAborted()
  } }])
  const pending = executor.execute({ id: 'write', type: 'function', function: { name: 'Write', arguments: '{}' } }, controller.signal)
  await started
  controller.abort()
  assert.equal((await pending).isError, true)
  assert(cleanup)
})

test('failed tool envelopes and execution accounting survive parallel and rejected calls', async () => {
  let charged = 0
  let ran = 0
  const executor = new ToolExecutor([{ name: 'Fetch', description: '', parameters: {}, execute() { ran++; return { error: 'blocked URL' } } }], 4,
    () => { if (charged >= 1) throw new Error('budget exhausted'); charged++ })
  const call = { id: 'fetch', type: 'function' as const, function: { name: 'Fetch', arguments: '{}' } }
  assert.equal((await executor.execute(call)).isError, true)
  assert.equal((await executor.execute(call)).isError, true)
  assert.equal(charged, 1)
  assert.equal(ran, 1)
})
