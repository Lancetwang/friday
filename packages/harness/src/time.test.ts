import assert from 'node:assert/strict'
import test from 'node:test'

import { localTimestamp, zonedTimestamp } from './time.js'

test('local timestamps match Python naive-local and offset-aware session formats', () => {
  const date = new Date(2026, 7, 13, 14, 5, 6, 789)

  assert.equal(localTimestamp(false, date), '2026-08-13T14:05:06')
  assert.equal(localTimestamp(true, date), '2026-08-13T14:05:06.789')
  assert.match(zonedTimestamp(date), /^2026-08-13T14:05:06[+-]\d\d:\d\d$/)
})
