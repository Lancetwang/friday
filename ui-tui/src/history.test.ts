import assert from 'node:assert/strict'
import test from 'node:test'

import { restoredMessages } from './app.js'

test('restored reasoning and failed tools keep the same shape as live turns', () => {
  const messages = restoredMessages([
    { kind: 'user', text: 'inspect this' },
    { elapsed_ms: 120, kind: 'reasoning', status: 'done', text: 'checking' },
    { kind: 'tool', name: 'Read', status: 'error', text: 'missing', tool_call_id: 'read-1' },
    { kind: 'assistant', text: 'The file is missing.' }
  ])

  assert.equal(messages.length, 2)
  assert.equal(messages[0]?.role, 'user')
  assert.equal(messages[0]?.thinking?.[0]?.text, 'checking')
  assert.equal(messages[0]?.tools?.[0]?.error, true)
  assert.equal(messages[1]?.role, 'assistant')
})
