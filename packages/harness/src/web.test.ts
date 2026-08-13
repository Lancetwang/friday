import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { JsonObject } from 'friday-agent-core'

import { buildWebTools, webFetch, webSearch } from './web.js'

test('WebSearch prefers Tavily and returns bounded structured results', async () => {
  const home = await mkdtemp(join(tmpdir(), 'friday-web-'))
  const previousHome = process.env.FRIDAY_HOME
  const previous = process.env.TAVILY_API_KEY
  process.env.FRIDAY_HOME = home
  process.env.TAVILY_API_KEY = 'tvly-test'
  let request: { url: string; init: RequestInit | undefined } | undefined
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    request = { url: String(input), init }
    return new Response(JSON.stringify({
      query: 'Friday TypeScript', answer: 'current answer',
      results: [{ title: 'Result', url: 'https://example.com', content: `  ${'word '.repeat(300)}  `, score: 0.9 }]
    }), { status: 200 })
  }) as typeof fetch
  try {
    const result = await webSearch({ query: 'Friday TypeScript', max_results: 1 }, undefined, fetcher)
    assert.equal(result.provider, 'tavily')
    assert.equal((result.results as JsonObject[]).length, 1)
    assert.equal(String((result.results as JsonObject[])[0]!.content).length, 800)
    assert.equal(request?.url, 'https://api.tavily.com/search')
    assert.equal((request?.init?.headers as Record<string, string>).Authorization, 'Bearer tvly-test')
    assert(!JSON.stringify(result).includes('tvly-test'))
  } finally {
    if (previousHome === undefined) delete process.env.FRIDAY_HOME
    else process.env.FRIDAY_HOME = previousHome
    if (previous === undefined) delete process.env.TAVILY_API_KEY
    else process.env.TAVILY_API_KEY = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('WebSearch falls back to AnySearch without an API key', async () => {
  const home = await mkdtemp(join(tmpdir(), 'friday-web-'))
  const previousHome = process.env.FRIDAY_HOME
  const previousTavily = process.env.TAVILY_API_KEY
  const previousAnysearch = process.env.ANYSEARCH_API_KEY
  process.env.FRIDAY_HOME = home
  delete process.env.TAVILY_API_KEY
  delete process.env.ANYSEARCH_API_KEY
  const fetcher = (async () => new Response(JSON.stringify({
    result: { content: [{ type: 'text', text: '### 1. Example\nUseful summary\n- **URL**: https://example.com/page\n' }] }
  }), { status: 200 })) as typeof fetch
  try {
    const result = await webSearch({ query: 'fallback' }, undefined, fetcher)
    assert.equal(result.provider, 'anysearch')
    assert.deepEqual(result.results, [{
      title: 'Example', url: 'https://example.com/page', content: 'Useful summary', score: null, published_date: ''
    }])
  } finally {
    if (previousHome === undefined) delete process.env.FRIDAY_HOME
    else process.env.FRIDAY_HOME = previousHome
    if (previousTavily === undefined) delete process.env.TAVILY_API_KEY
    else process.env.TAVILY_API_KEY = previousTavily
    if (previousAnysearch === undefined) delete process.env.ANYSEARCH_API_KEY
    else process.env.ANYSEARCH_API_KEY = previousAnysearch
    await rm(home, { recursive: true, force: true })
  }
})

test('WebFetch rejects local targets and bounds Jina Markdown', async () => {
  let calls = 0
  let requested = ''
  const fetcher = (async (input: URL | RequestInfo) => {
    calls += 1
    requested = String(input)
    return new Response('head\n' + 'x'.repeat(500) + '\ntail', { status: 200 })
  }) as typeof fetch
  for (const url of [
    'file:///etc/passwd', 'http://127.0.0.1/private', 'http://[::1]/private',
    'https://user:secret@example.com', 'http://host.internal/private'
  ]) assert.equal(typeof (await webFetch({ url }, undefined, fetcher)).error, 'string')
  assert.equal(calls, 0)

  const result = await webFetch({ url: 'https://example.com/a b#section', max_chars: 100 }, undefined, fetcher)
  assert.equal(result.truncated, true)
  assert.equal(String(result.content).length, 100)
  assert.equal(calls, 1)
  assert.match(requested, /^https:\/\/r\.jina\.ai\/https:\/\/example\.com\/a%20b%23section$/)
  assert.deepEqual(buildWebTools().map(tool => tool.name), ['WebSearch', 'WebFetch'])
})
