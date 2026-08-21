import assert from 'node:assert/strict'
import { test } from 'node:test'

import { RunContext, type ChatModel, type ToolCall } from 'friday-agent-core'

import type { CompactionSettings, ModelConfig } from './config.js'
import { compactIfNeeded, restoreCompactedMessage, tokenMeasurement } from './context.js'

const INSERT: CompactionSettings = { automatic: true, threshold_percent: 85, strategy: 'insert' }
const TWO_STAGE: CompactionSettings = { automatic: true, threshold_percent: 85, strategy: 'two-stage' }

test('two-stage compaction tombstones only old consumed tool results', async () => {
  const context = toolConversation('old detail '.repeat(8_000), 'recent '.repeat(100))
  const before = Number(tokenMeasurement(context, []).tokens)
  const config = modelConfig(Math.ceil(before / 0.9))
  const original = context.messages.find(message => message.tool_call_id === 'call-0')!
  const originalContent = original.content
  let modelCalls = 0

  const result = await compactIfNeeded({
    context,
    tools: [],
    config,
    settings: TWO_STAGE,
    model: { async complete() { modelCalls += 1; throw new Error('semantic compaction should not run') } },
    archive() {}
  })

  assert.equal(modelCalls, 0)
  assert.equal(result.record?.kind, 'tool_results')
  assert.equal(result.record?.strategy, 'tombstone')
  assert.equal(result.record?.tool_results, 1)
  assert.match(String(original.content), /"compacted":true/)
  assert.equal(original.friday_original_tool_content, originalContent)
  assert.equal(restoreCompactedMessage(original).content, originalContent)
  assert.equal(String(context.messages.find(message => message.tool_call_id === 'call-1')!.content).includes('recent'), true)
  assert(Number(tokenMeasurement(context, []).tokens) < before)
})

test('an insufficient tombstone candidate is rolled back before semantic compaction', async () => {
  const oldest = 'small old result '.repeat(70)
  const context = toolConversation(oldest, 'large recent result '.repeat(1_400))
  const before = Number(tokenMeasurement(context, []).tokens)
  const config = modelConfig(Math.ceil(before / 0.89))
  let sawOriginal = false
  const model: ChatModel = {
    async complete(request) {
      sawOriginal = request.messages.some(message => message.role === 'tool' && message.content === oldest)
      return { role: 'assistant', content: summary() }
    }
  }

  const result = await compactIfNeeded({ context, tools: [], config, settings: TWO_STAGE, model, archive() {} })

  assert.equal(sawOriginal, true)
  assert.equal(result.record?.kind, 'conversation')
  assert.equal(context.messages.some(message => message.friday_original_tool_content !== undefined), false)
})

test('automatic off is a policy decision, while force still permits manual compact', async () => {
  const context = toolConversation('old detail '.repeat(8_000), 'recent '.repeat(100))
  const before = Number(tokenMeasurement(context, []).tokens)
  const config = modelConfig(Math.ceil(before / 0.9))
  const off = { ...INSERT, automatic: false }
  let modelCalls = 0
  const model: ChatModel = {
    async complete() {
      modelCalls += 1
      return { role: 'assistant', content: summary() }
    }
  }

  assert.deepEqual(await compactIfNeeded({ context, tools: [], config, settings: off, model, archive() {} }), {})
  assert.equal(modelCalls, 0)
  const forced = await compactIfNeeded({ context, tools: [], config, settings: off, model, archive() {}, force: true })
  assert.equal(forced.record?.kind, 'conversation')
  assert.equal(modelCalls > 0, true)
})

function toolConversation(oldest: string, recent: string): RunContext {
  const context = new RunContext()
  context.addMessage({ role: 'system', content: 'system' })
  context.addMessage({ role: 'user', content: 'inspect the workspace' })
  for (let index = 0; index < 4; index += 1) {
    const call: ToolCall = {
      id: `call-${index}`,
      type: 'function',
      function: { name: 'Read', arguments: JSON.stringify({ path: `file-${index}.ts` }) }
    }
    context.addMessage({ role: 'assistant', content: '', tool_calls: [call] })
    context.addMessage({ role: 'tool', tool_call_id: call.id, content: index ? recent : oldest })
  }
  return context
}

function modelConfig(contextWindow: number): ModelConfig {
  return {
    profileId: 'test', profileName: 'Test', provider: 'openai-compatible', model: 'mock',
    baseUrl: 'http://127.0.0.1:9', vision: false, contextWindow, maxOutputTokens: 1, apiKey: 'test'
  }
}

function summary(): string {
  return [
    '## Current Goal', 'Inspect the workspace.', '## Completed', '', '## Open Items', '',
    '## Tried Methods', '', '## Decisions', '', '## Working Files', '',
    '## Commands And Results', '', '## Verification State', 'not run', '## Next Steps', 'Continue.'
  ].join('\n')
}
