import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import { test } from 'node:test'

import { Agent } from './agent.js'
import { AnthropicModel } from './anthropic.js'
import { OpenAIModel } from './openai.js'
import { ResponsesModel } from './responses.js'
import { ToolExecutor } from './tools.js'
import type { JsonObject, Tool, ToolCall } from './types.js'

test('streams through a model-tool-model turn', async () => {
  const requests: JsonObject[] = []
  let turn = 0
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      requests.push(JSON.parse(body) as JsonObject)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (turn++ === 0) {
        sse(response, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'add', arguments: '{"a":2,' } }] } }] })
        sse(response, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"b":3}' } }] } }] })
        sse(response, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } })
      } else {
        sse(response, { choices: [{ delta: { content: 'The answer ' } }] })
        sse(response, { choices: [{ delta: { content: 'is 5.' } }] })
        sse(response, { choices: [], usage: { prompt_tokens: 15, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 6 } } })
      }
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')

  try {
    const add: Tool = {
      name: 'add',
      description: 'Add two numbers.',
      parameters: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b']
      },
      execute(args) {
        assert.equal(typeof args.a, 'number')
        assert.equal(typeof args.b, 'number')
        return (args.a as number) + (args.b as number)
      }
    }
    const chunks: string[] = []
    const agent = new Agent({
      model: new OpenAIModel({ apiKey: 'test', model: 'test-model', baseUrl: `http://127.0.0.1:${address.port}` }),
      instructions: 'Be concise.',
      tools: [add]
    })

    const answer = await agent.chat('What is 2 + 3?', { onDelta: chunk => chunks.push(chunk) })

    assert.equal(answer, 'The answer is 5.')
    assert.deepEqual(chunks, ['The answer ', 'is 5.'])
    assert.deepEqual(agent.context.messages.map(message => message.role), ['system', 'user', 'assistant', 'tool', 'assistant'])
    assert.equal(agent.context.messages[3]?.content, '5')
    assert.deepEqual(agent.context.usage, { requests: 2, inputTokens: 25, outputTokens: 7, cachedTokens: 6 })
    assert.deepEqual(agent.context.events.filter(event => event.category === 'tool').map(event => event.type), ['tool.call', 'tool.result'])
    const secondMessages = (requests[1]?.messages as JsonObject[])
    assert.equal(secondMessages.at(-1)?.role, 'tool')
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

test('parallel tools keep serial calls as exclusive barriers', async () => {
  let active = 0
  let peak = 0
  const order: string[] = []
  const parallel = (name: string): Tool => ({
    name,
    description: name,
    parameters: { type: 'object' },
    parallel: true,
    async execute() {
      active += 1
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 10))
      order.push(name)
      active -= 1
      return name
    }
  })
  const serial: Tool = {
    name: 'serial', description: 'serial', parameters: { type: 'object' },
    execute() {
      assert.equal(active, 0)
      order.push('serial')
      return 'serial'
    }
  }
  const executor = new ToolExecutor([parallel('one'), parallel('two'), serial, parallel('three')])
  const calls = ['one', 'two', 'serial', 'three'].map(call)

  const results = await executor.executeAll(calls)

  assert.equal(peak, 2)
  assert.deepEqual(order, ['one', 'two', 'serial', 'three'])
  assert.deepEqual(results.map(result => result.content), ['one', 'two', 'serial', 'three'])
})

test('a paused preflight short-circuits the whole tool batch and can resume', async () => {
  let modelCalls = 0
  let executions = 0
  const tool: Tool = {
    name: 'mutate', description: 'mutate', parameters: { type: 'object' },
    preflight(call) {
      return { action: 'pause', result: { approval_required: true, tool_call_id: call.id } }
    },
    execute() {
      executions += 1
      return 'should not run'
    }
  }
  const observer: Tool = {
    name: 'observe', description: 'observe', parameters: { type: 'object' }, parallel: true,
    execute() {
      executions += 1
      return 'should not run'
    }
  }
  const agent = new Agent({
    tools: [observer, tool],
    model: {
      async complete() {
        modelCalls += 1
        return modelCalls === 1
          ? { role: 'assistant', content: '', tool_calls: [call('observe', 0), call('mutate', 1)] }
          : { role: 'assistant', content: 'continued' }
      }
    }
  })

  const paused = await agent.run('change it')

  assert.deepEqual(paused, { status: 'paused', text: '' })
  assert.equal(executions, 0)
  assert.match(String(agent.context.messages.at(-2)?.content), /cancelled/)
  agent.context.messages.at(-1)!.content = '{"approved":true}'
  const resumed = await agent.resume()
  assert.deepEqual(resumed, { status: 'done', text: 'continued' })
})

test('unchanged repeated tool calls warn once and then finish without tools', async () => {
  let requests = 0
  let executions = 0
  const schemas: number[] = []
  const agent = new Agent({
    tools: [{
      name: 'inspect', description: 'Inspect an unchanged value.', parameters: { type: 'object' },
      execute() {
        executions += 1
        return { value: 'unchanged' }
      }
    }],
    model: {
      async complete(request) {
        requests += 1
        schemas.push(request.tools?.length ?? 0)
        return request.tools?.length
          ? {
              role: 'assistant', content: '',
              tool_calls: [{ id: `inspect-${requests}`, type: 'function', function: { name: 'inspect', arguments: '{}' } }]
            }
          : {
              role: 'assistant', content: 'I cannot make further progress.',
              tool_calls: [{ id: 'ignored', type: 'function', function: { name: 'inspect', arguments: '{}' } }]
            }
      }
    }
  })

  const result = await agent.run('Keep inspecting forever.')

  assert.deepEqual(result, { status: 'done', text: 'I cannot make further progress.' })
  assert.equal(requests, 5)
  assert.equal(executions, 4)
  assert.deepEqual(schemas, [1, 1, 1, 1, 0])
  assert.equal(agent.context.messages.at(-1)?.tool_calls, undefined)
  assert.deepEqual(agent.context.events.filter(event => event.type.startsWith('loop.')).map(event => event.type), [
    'loop.warning', 'loop.guard'
  ])
})

test('indexless streamed tool calls stay separate and ids are synthesized', async () => {
  // Several OpenAI-compatible providers stream one tool call per chunk with
  // no `index` field; some also resend the whole function name in every
  // fragment. Getting the merge wrong collapses every call into one slot of
  // concatenated garbage - which only shows up when a model calls several
  // tools at once.
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunkFor = (calls: unknown) => sse(response, { choices: [{ delta: { tool_calls: calls } }] })
      // Call 1: id, no index; arguments arrive as a later bare fragment.
      chunkFor([{ id: 'a1', type: 'function', function: { name: 'Read' } }])
      chunkFor([{ function: { arguments: '{"path":' } }])
      chunkFor([{ function: { arguments: '"x.txt"}' } }])
      // Call 2: new id, whole name resent twice, no index anywhere.
      chunkFor([{ id: 'b2', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } }])
      chunkFor([{ id: 'b2', type: 'function', function: { name: 'Bash' } }])
      // Call 3: no id and no index on its opening chunk would be ambiguous,
      // so providers of this shape always send the id; verify a third call.
      chunkFor([{ id: 'c3', type: 'function', function: { name: 'Glob', arguments: '{"pattern":"*"}' } }])
      sse(response, { choices: [{ delta: {} }], usage: { prompt_tokens: 4, completion_tokens: 2 } })
      response.write('data: [DONE]\n\n')
      response.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  try {
    const model = new OpenAIModel({ apiKey: 'k', model: 'mock', baseUrl: `http://127.0.0.1:${address.port}` })
    const result = await model.complete({ messages: [{ role: 'user', content: 'go' }] })
    assert.deepEqual(result.tool_calls?.map(call => [call.id, call.function.name, call.function.arguments]), [
      ['a1', 'Read', '{"path":"x.txt"}'],
      ['b2', 'Bash', '{"command":"ls"}'],
      ['c3', 'Glob', '{"pattern":"*"}']
    ])
    // Executor-side hardening: missing and duplicated ids are synthesized so
    // result pairing and the echoed next request stay consistent.
    const executor = new ToolExecutor([])
    const parsed = executor.parse({
      tool_calls: [
        { id: '', type: 'function', function: { name: 'A', arguments: '{}' } },
        { id: 'dup', type: 'function', function: { name: 'B', arguments: '{}' } },
        { id: 'dup', type: 'function', function: { name: 'C', arguments: '{}' } }
      ]
    })
    assert.deepEqual(parsed.map(call => call.id), ['call_0', 'dup', 'dup_2'])
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

test('Anthropic Messages preserves signed thinking and tool turns', async () => {
  let payload: JsonObject | undefined
  let requestPath = ''
  let apiKey = ''
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      payload = JSON.parse(body) as JsonObject
      requestPath = request.url || ''
      apiKey = String(request.headers['x-api-key'] || '')
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      sse(response, { type: 'message_start', message: { usage: { input_tokens: 12 } } })
      sse(response, { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } })
      sse(response, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'considering' } })
      sse(response, { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed' } })
      sse(response, { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'next-call', name: 'Read', input: {} } })
      sse(response, { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"README.md"}' } })
      sse(response, { type: 'message_delta', usage: { output_tokens: 5 } })
      sse(response, { type: 'message_stop' })
      response.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  const reasoning: string[] = []
  try {
    const model = new AnthropicModel({ apiKey: 'anthropic-secret', model: 'claude-test', baseUrl: `http://127.0.0.1:${address.port}` })
    const result = await model.complete({
      messages: [
        { role: 'system', content: 'System rules.' },
        { role: 'user', content: 'Inspect the file.' },
        {
          role: 'assistant', content: 'I will inspect it.',
          reasoning_content: [{ type: 'thinking', thinking: 'prior', signature: 'prior-signature' }],
          tool_calls: [call('Read', 0)]
        },
        { role: 'tool', tool_call_id: '0', content: 'contents' }
      ],
      tools: [{ type: 'function', function: { name: 'Read', description: 'Read a file.', parameters: { type: 'object' } } }],
      onReasoningDelta: value => reasoning.push(value)
    })

    assert.equal(requestPath, '/v1/messages')
    assert.equal(apiKey, 'anthropic-secret')
    assert.equal(payload?.system, 'System rules.')
    const messages = payload?.messages as JsonObject[]
    assert.deepEqual(messages.map(message => message.role), ['user', 'assistant', 'user'])
    assert.deepEqual((messages[2]?.content as JsonObject[]).map(block => block.type), ['tool_result'])
    assert.deepEqual(reasoning, ['considering'])
    assert.deepEqual(result.reasoning_content, [{ type: 'thinking', thinking: 'considering', signature: 'signed' }])
    assert.deepEqual(result.tool_calls, [{
      id: 'next-call', type: 'function',
      function: { name: 'Read', arguments: '{"path":"README.md"}' }
    }])
    assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 5 })
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

test('Anthropic cache breakpoints and tool_choice none reach the wire', async () => {
  let payload: JsonObject | undefined
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      payload = JSON.parse(body) as JsonObject
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      sse(response, { type: 'message_start', message: { usage: { input_tokens: 40, cache_read_input_tokens: 30, cache_creation_input_tokens: 8 } } })
      sse(response, { type: 'content_block_start', index: 0, content_block: { type: 'text' } })
      sse(response, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'summary' } })
      sse(response, { type: 'message_delta', usage: { output_tokens: 3 } })
      sse(response, { type: 'message_stop' })
      response.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  try {
    const model = new AnthropicModel({
      apiKey: 'k', model: 'claude-test', baseUrl: `http://127.0.0.1:${address.port}`, cacheControl: true
    })
    const result = await model.complete({
      messages: [
        { role: 'system', content: 'Rules.' },
        { role: 'user', content: 'Question.' }
      ],
      tools: [{ type: 'function', function: { name: 'Read', description: 'Read.', parameters: { type: 'object' } } }],
      toolChoice: 'none'
    })
    // System prompt carries a breakpoint block instead of a bare string.
    const system = payload?.system as JsonObject[]
    assert.deepEqual(system[0]?.cache_control, { type: 'ephemeral' })
    // The final message's last content block carries the rolling breakpoint.
    const messages = payload?.messages as JsonObject[]
    const content = messages.at(-1)?.content as JsonObject[]
    assert.deepEqual(content.at(-1)?.cache_control, { type: 'ephemeral' })
    // Tools stay in the request (cache prefix identity) but calls are barred.
    assert.equal((payload?.tools as JsonObject[]).length, 1)
    assert.deepEqual(payload?.tool_choice, { type: 'none' })
    // Cache figures reported by the provider survive into usage.
    assert.deepEqual(result.usage, {
      input_tokens: 40, output_tokens: 3, cache_read_input_tokens: 30, cache_creation_input_tokens: 8
    })
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

test('OpenAI Responses replays typed items and normalizes completed output', async () => {
  let payload: JsonObject | undefined
  let requestPath = ''
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      payload = JSON.parse(body) as JsonObject
      requestPath = request.url || ''
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      sse(response, { type: 'response.reasoning_summary_text.delta', delta: 'thinking' })
      sse(response, { type: 'response.output_text.delta', delta: 'finished' })
      sse(response, {
        type: 'response.completed',
        response: {
          output: [
            { type: 'reasoning', id: 'reasoning-2', summary: [] },
            { type: 'message', content: [{ type: 'output_text', text: 'finished' }] },
            { type: 'function_call', call_id: 'response-call', name: 'Read', arguments: '{"path":"package.json"}' }
          ],
          usage: { input_tokens: 20, output_tokens: 7 }
        }
      })
      response.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  const deltas: string[] = []
  const reasoning: string[] = []
  try {
    const model = new ResponsesModel({ apiKey: 'response-secret', model: 'gpt-test', baseUrl: `http://127.0.0.1:${address.port}/v1` })
    const result = await model.complete({
      messages: [
        { role: 'system', content: 'System rules.' },
        { role: 'user', content: 'Continue.' },
        {
          role: 'assistant', content: '', reasoning_content: [{ type: 'reasoning', id: 'reasoning-1', summary: [] }],
          tool_calls: [call('Read', 0)]
        },
        { role: 'tool', tool_call_id: '0', content: 'file contents' }
      ],
      onDelta: value => deltas.push(value),
      onReasoningDelta: value => reasoning.push(value)
    })

    assert.equal(requestPath, '/v1/responses')
    assert.equal(payload?.instructions, 'System rules.')
    assert.deepEqual((payload?.input as JsonObject[]).map(item => item.type ?? item.role), [
      'user', 'reasoning', 'function_call', 'function_call_output'
    ])
    assert.deepEqual(deltas, ['finished'])
    assert.deepEqual(reasoning, ['thinking'])
    assert.equal(result.content, 'finished')
    assert.deepEqual(result.reasoning_content, [{ type: 'reasoning', id: 'reasoning-2', summary: [] }])
    assert.equal(result.tool_calls?.[0]?.id, 'response-call')
    assert.deepEqual(result.usage, { input_tokens: 20, output_tokens: 7 })
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

test('a tool that ignores its abort signal cannot hold the turn hostage', async () => {
  const stuck: Tool = {
    name: 'stuck', description: 'never settles', parameters: { type: 'object' },
    execute: () => new Promise(() => {})
  }
  const executor = new ToolExecutor([stuck])
  const controller = new AbortController()
  const started = performance.now()

  const pending = executor.execute(call('stuck', 1), controller.signal)
  setTimeout(() => controller.abort(), 50)
  const result = await pending

  assert.equal(result.isError, true)
  assert.match(result.content, /AbortError/)
  assert(performance.now() - started < 2_000)
})

function call(name: string, index: number): ToolCall {
  return { id: String(index), type: 'function', function: { name, arguments: '{}' } }
}

function sse(response: ServerResponse, value: unknown): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`)
}
