import assert from 'node:assert/strict'
import test from 'node:test'
import { ModelStreamError } from 'friday-agent-core'
import { ResourceBudget } from './resources.js'

test('failed streams charge reported usage before another request can start', async () => {
  const budget = new ResourceBudget({ tokens: 100 })
  const failure = new ModelStreamError('interrupted', {
    role: 'assistant', content: 'partial', usage: { input_tokens: 60, output_tokens: 40 }
  })
  let calls = 0
  const model = budget.wrap({ async complete() { calls++; throw failure } })
  await assert.rejects(model.complete({ messages: [] }), error => error === failure)
  assert.equal(budget.state.tokens, 100)
  assert.equal(budget.state.estimated, false)
  await assert.rejects(model.complete({ messages: [] }), /budget exhausted/)
  assert.equal(calls, 1)
})

test('missing usage estimates final text, reasoning and tool calls without requiring deltas', async () => {
  const budget = new ResourceBudget()
  const response = { role: 'assistant' as const, content: 'answer'.repeat(50), reasoning_content: 'think'.repeat(60),
    tool_calls: [{ id: 'call', type: 'function' as const, function: { name: 'Read', arguments: '{"path":"README.md"}' } }] }
  const model = budget.wrap({ async complete() { return response } })
  await model.complete({ messages: [] })
  assert(budget.state.tokens >= Math.ceil((response.content.length + response.reasoning_content.length + JSON.stringify(response.tool_calls).length) / 3))
  assert.equal(budget.state.estimated, true)
})

test('reasoning received before a generic stream failure is charged and forwarded', async () => {
  const budget = new ResourceBudget()
  let reasoning = ''
  const model = budget.wrap({ async complete(request) {
    request.onReasoningDelta?.('x'.repeat(300))
    throw new Error('transport lost')
  } })
  await assert.rejects(model.complete({ messages: [], onReasoningDelta: text => { reasoning += text } }), /transport lost/)
  assert.equal(reasoning.length, 300)
  assert(budget.state.tokens >= 100)
})

test('reported usage takes precedence over streamed and final output estimates', async () => {
  const budget = new ResourceBudget()
  const model = budget.wrap({ async complete(request) {
    request.onDelta?.('x'.repeat(300))
    return { role: 'assistant', content: 'x'.repeat(300), usage: { input_tokens: 7, output_tokens: 9 } }
  } })
  await model.complete({ messages: [] })
  assert.equal(budget.state.tokens, 16)
  assert.equal(budget.state.estimated, false)
})
