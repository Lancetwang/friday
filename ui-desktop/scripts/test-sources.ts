import assert from 'node:assert/strict'

import { collectMessageSources, type SourceItem } from '../src/sources.ts'

let checks = 0
function check(name: string, run: () => void) {
  run()
  checks += 1
  console.log(`ok  ${name}`)
}

function searchRound(id: string, hosts: string[]): SourceItem {
  return {
    id,
    kind: 'tool',
    name: 'WebSearch',
    text: JSON.stringify({
      query: 'cross-border trade llm agent',
      results: hosts.map(host => ({
        title: `Report on ${host}`,
        url: `https://${host}/article`,
        favicon: `https://${host}/favicon.ico`
      }))
    })
  }
}

check('every search round reaches the answer, not just the first', () => {
  const rounds = Array.from({ length: 6 }, (_, round) =>
    searchRound(`t${round}`, Array.from({ length: 8 }, (_, index) => `site${round}-${index}.example`))
  )
  const items: SourceItem[] = [
    { id: 'u1', kind: 'user', text: 'research this' },
    ...rounds,
    { id: 'a1', kind: 'assistant', text: 'Here is the report.' }
  ]

  const sources = collectMessageSources(items).get('a1')
  assert.equal(sources?.length, 48)
  // The last round is present, which the old eight-item cap dropped.
  assert.ok(sources?.some(source => source.url.includes('site5-7.example')))
})

check('the same page found in several rounds is counted once', () => {
  const items: SourceItem[] = [
    { id: 'u1', kind: 'user', text: 'research this' },
    searchRound('t0', ['a.example', 'b.example']),
    searchRound('t1', ['b.example', 'c.example']),
    { id: 'a1', kind: 'assistant', text: 'done' }
  ]

  const sources = collectMessageSources(items).get('a1')
  assert.deepEqual(sources?.map(source => source.url), [
    'https://a.example/article',
    'https://b.example/article',
    'https://c.example/article'
  ])
})

check('a fetch counts the page fetched, not the links inside it', () => {
  const body = [
    '# Trade report',
    '[Home](https://portal.example/home) [Careers](https://portal.example/jobs)',
    'See also https://portal.example/privacy and https://ads.example/track?id=9',
    Array.from({ length: 40 }, (_, index) => `[nav ${index}](https://portal.example/nav-${index})`).join(' ')
  ].join('\n')
  const items: SourceItem[] = [
    { id: 'u1', kind: 'user', text: 'read it' },
    {
      id: 't0',
      kind: 'tool',
      name: 'WebFetch',
      arguments: JSON.stringify({ url: 'https://portal.example/trade-report' }),
      text: JSON.stringify({ url: 'https://portal.example/trade-report', content: body, chars: body.length })
    },
    { id: 'a1', kind: 'assistant', text: 'summarised' }
  ]

  const sources = collectMessageSources(items).get('a1')
  assert.deepEqual(sources?.map(source => source.url), ['https://portal.example/trade-report'])
})

check('a fetch still resolves when the call arguments are unavailable', () => {
  const items: SourceItem[] = [
    { id: 'u1', kind: 'user', text: 'read it' },
    {
      id: 't0',
      kind: 'tool',
      name: 'WebFetch',
      text: JSON.stringify({ url: 'https://portal.example/only-in-result', content: 'body' })
    },
    { id: 'a1', kind: 'assistant', text: 'summarised' }
  ]

  assert.deepEqual(
    collectMessageSources(items).get('a1')?.map(source => source.url),
    ['https://portal.example/only-in-result']
  )
})

check('a provider without structured results falls back to its text links', () => {
  const items: SourceItem[] = [
    { id: 'u1', kind: 'user', text: 'search' },
    {
      id: 't0',
      kind: 'tool',
      name: 'WebSearch',
      text: '1. [Tariff outlook](https://one.example/a)\n2. https://two.example/b'
    },
    { id: 'a1', kind: 'assistant', text: 'done' }
  ]

  assert.deepEqual(
    collectMessageSources(items).get('a1')?.map(source => source.url),
    ['https://one.example/a', 'https://two.example/b']
  )
})

check('sources do not leak across turns', () => {
  const items: SourceItem[] = [
    { id: 'u1', kind: 'user', text: 'first' },
    searchRound('t0', ['a.example']),
    { id: 'a1', kind: 'assistant', text: 'first answer' },
    { id: 'u2', kind: 'user', text: 'second' },
    { id: 'a2', kind: 'assistant', text: 'second answer with no research' }
  ]

  const collected = collectMessageSources(items)
  assert.equal(collected.get('a1')?.length, 1)
  assert.equal(collected.get('a2'), undefined)
})

check('links the answer itself cites lead the list', () => {
  const items: SourceItem[] = [
    { id: 'u1', kind: 'user', text: 'research' },
    searchRound('t0', ['found.example']),
    { id: 'a1', kind: 'assistant', text: 'Per [the filing](https://cited.example/doc) the tariff changed.' }
  ]

  const sources = collectMessageSources(items).get('a1')
  assert.deepEqual(sources?.map(source => source.url), [
    'https://cited.example/doc',
    'https://found.example/article'
  ])
  assert.equal(sources?.[0]?.title, 'the filing')
})

check('non-web tools contribute nothing', () => {
  const items: SourceItem[] = [
    { id: 'u1', kind: 'user', text: 'work' },
    { id: 't0', kind: 'tool', name: 'Bash', text: 'cloned https://github.com/example/repo' },
    { id: 't1', kind: 'tool', name: 'Read', text: 'see https://docs.example/page' },
    { id: 'a1', kind: 'assistant', text: 'done' }
  ]

  assert.equal(collectMessageSources(items).get('a1'), undefined)
})

console.log(`\n${checks} checks passed`)
