import assert from 'node:assert/strict'
import test from 'node:test'

import { ModelRequestError, type ChatModel } from 'friday-agent-core'

import { withModelRetries } from './model.js'

test('transient model failures are retried before reaching the Harness caller', async () => {
  let calls = 0
  const model: ChatModel = {
    async complete() {
      calls += 1
      if (calls < 3) throw new ModelRequestError(503, 'temporary')
      return { role: 'assistant', content: 'ready' }
    }
  }

  const response = await withModelRetries(model, [0, 0]).complete({ messages: [] })

  assert.equal(response.content, 'ready')
  assert.equal(calls, 3)
})

test('deterministic provider rejections are not retried or rewritten', async () => {
  let calls = 0
  const rejection = new ModelRequestError(400, 'invalid request')
  const model: ChatModel = {
    async complete() {
      calls += 1
      throw rejection
    }
  }

  await assert.rejects(withModelRetries(model, [0, 0]).complete({ messages: [] }), error => error === rejection)
  assert.equal(calls, 1)
})

test('a failed stream is not replayed after user-visible output', async () => {
  let calls = 0
  let output = ''
  const model: ChatModel = {
    async complete(request) {
      calls += 1
      request.onDelta?.('partial')
      throw new Error('connection closed')
    }
  }

  await assert.rejects(withModelRetries(model, [0, 0]).complete({
    messages: [],
    onDelta: text => { output += text }
  }), /connection closed/)
  assert.equal(calls, 1)
  assert.equal(output, 'partial')
})
