import { isIP } from 'node:net'

import type { JsonObject, Tool } from 'friday-agent-core'

import { readWebSearchCredential } from './settings.js'

type Fetcher = typeof globalThis.fetch

const JSON_LIMIT = 2_000_000
const PAGE_LIMIT = 5_000_000

export function buildWebTools(): Tool[] {
  return [
    {
      name: 'WebSearch', description: 'Search the live web when current external information is needed.', parallel: true,
      parameters: {
        type: 'object', additionalProperties: false, required: ['query'],
        properties: {
          query: { type: 'string', description: 'Search query.' },
          max_results: { type: 'integer', minimum: 1, maximum: 10, description: 'Maximum results.' },
          search_depth: { type: 'string', enum: ['basic', 'advanced'], description: 'Search depth.' },
          topic: { type: 'string', enum: ['general', 'news', 'finance'], description: 'Search topic.' },
          include_answer: { type: 'boolean', description: 'Include a provider summary when available.' },
          time_range: { type: 'string', enum: ['', 'day', 'week', 'month', 'year'], description: 'Optional recency range.' }
        }
      },
      execute(args, signal) { return webSearch(args, signal) }
    },
    {
      name: 'WebFetch', description: 'Fetch a specific public URL as clean Markdown with Jina Reader.', parallel: true,
      parameters: {
        type: 'object', additionalProperties: false, required: ['url'],
        properties: {
          url: { type: 'string', description: 'Absolute HTTP or HTTPS URL.' },
          max_chars: { type: 'integer', minimum: 1, maximum: 50_000, description: 'Maximum returned characters.' }
        }
      },
      execute(args, signal) { return webFetch(args, signal) }
    }
  ]
}

export async function webSearch(
  args: JsonObject,
  signal?: AbortSignal,
  fetcher: Fetcher = globalThis.fetch
): Promise<JsonObject> {
  const query = requiredText(args.query, 'query', 500)
  const maxResults = integer(args.max_results, 5, 1, 10)
  const tavily = await tavilySearch(query, args, maxResults, signal, fetcher)
  if (!tavily.error) return { provider: 'tavily', ...tavily }
  const anysearch = await anysearchSearch(query, maxResults, signal, fetcher)
  if (!anysearch.error) return { provider: 'anysearch', ...anysearch }
  return {
    error: 'All WebSearch providers failed.',
    providers: { tavily: String(tavily.error), anysearch: String(anysearch.error) }
  }
}

export async function webFetch(
  args: JsonObject,
  signal?: AbortSignal,
  fetcher: Fetcher = globalThis.fetch
): Promise<JsonObject> {
  const target = requiredText(args.url, 'url', 4_096)
  const problem = remoteUrlError(target)
  if (problem) return { error: problem }
  const limit = integer(args.max_chars, 8_000, 1, 50_000)
  const headers: Record<string, string> = { Accept: 'text/markdown', 'User-Agent': 'FridayAgent/0.2' }
  const key = String(process.env.JINA_API_KEY || '').trim()
  if (key) headers.Authorization = `Bearer ${key}`
  try {
    const source = new URL(target).href.replaceAll('#', '%23')
    const response = await request(`https://r.jina.ai/${source}`, { headers }, 30_000, PAGE_LIMIT, signal, fetcher)
    if (!response.ok) return { error: `Jina HTTP ${response.status}`, detail: response.body.slice(0, 1_000) }
    return {
      url: target,
      content: clippedPage(response.body, limit),
      chars: response.body.length,
      truncated: response.body.length > limit
    }
  } catch (error) {
    if (signal?.aborted) throw error
    return { error: `Jina fetch failed: ${message(error)}` }
  }
}

async function tavilySearch(
  query: string,
  args: JsonObject,
  maxResults: number,
  signal: AbortSignal | undefined,
  fetcher: Fetcher
): Promise<JsonObject> {
  const key = readWebSearchCredential('tavily').trim()
  if (!key) return { error: 'TAVILY_API_KEY is not configured.' }
  const searchDepth = choice(args.search_depth, ['basic', 'advanced'], 'basic')
  const topic = choice(args.topic, ['general', 'news', 'finance'], 'general')
  const timeRange = choice(args.time_range, ['', 'day', 'week', 'month', 'year'], '')
  const payload: JsonObject = {
    query,
    search_depth: searchDepth,
    topic,
    max_results: maxResults,
    include_answer: args.include_answer !== false,
    include_favicon: true,
    include_raw_content: false,
    include_images: false,
    ...(timeRange ? { time_range: timeRange } : {})
  }
  try {
    const response = await request('https://api.tavily.com/search', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }, 20_000, JSON_LIMIT, signal, fetcher)
    if (!response.ok) return { error: `Tavily HTTP ${response.status}`, detail: response.body.slice(0, 1_000) }
    const data = record(JSON.parse(response.body))
    return {
      query: typeof data.query === 'string' ? data.query : query,
      answer: typeof data.answer === 'string' ? data.answer : '',
      results: Array.isArray(data.results) ? data.results.flatMap(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return []
        const value = item as JsonObject
        return [{
          title: text(value.title), url: text(value.url), content: compact(text(value.content)).slice(0, 800),
          favicon: text(value.favicon), score: typeof value.score === 'number' ? value.score : null,
          published_date: text(value.published_date)
        }]
      }).slice(0, maxResults) : []
    }
  } catch (error) {
    if (signal?.aborted) throw error
    return { error: `Tavily search failed: ${message(error)}` }
  }
}

async function anysearchSearch(
  query: string,
  maxResults: number,
  signal: AbortSignal | undefined,
  fetcher: Fetcher
): Promise<JsonObject> {
  const key = readWebSearchCredential('anysearch').trim()
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Anysearch-Client': 'friday/0.2' }
  if (key) headers.Authorization = `Bearer ${key}`
  try {
    const response = await request('https://api.anysearch.com/mcp', {
      method: 'POST', headers,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'search', arguments: { query, max_results: maxResults } }
      })
    }, 30_000, JSON_LIMIT, signal, fetcher)
    if (!response.ok) return { error: `AnySearch HTTP ${response.status}`, detail: response.body.slice(0, 1_000) }
    const data = record(JSON.parse(response.body))
    const apiError = data.error && typeof data.error === 'object' && !Array.isArray(data.error) ? data.error as JsonObject : undefined
    if (apiError) return { error: `AnySearch API error: ${text(apiError.message) || 'unknown error'}` }
    const result = data.result && typeof data.result === 'object' && !Array.isArray(data.result) ? data.result as JsonObject : {}
    const content = Array.isArray(result.content) ? result.content : []
    const value = content.find(item => item && typeof item === 'object' && !Array.isArray(item) && (item as JsonObject).type === 'text')
    const body = value && typeof value === 'object' && !Array.isArray(value) ? text((value as JsonObject).text) : ''
    if (result.isError || !body) return { error: `AnySearch API error: ${body.slice(0, 1_000) || 'missing text result'}` }
    const results = anysearchResults(body).slice(0, maxResults)
    return { query, answer: '', results, ...(!results.length ? { content: body.slice(0, 4_000) } : {}) }
  } catch (error) {
    if (signal?.aborted) throw error
    return { error: `AnySearch search failed: ${message(error)}` }
  }
}

async function request(
  url: string,
  init: RequestInit,
  timeout: number,
  maximum: number,
  signal: AbortSignal | undefined,
  fetcher: Fetcher
): Promise<{ ok: boolean; status: number; body: string }> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new DOMException('Request timed out.', 'TimeoutError'))
  }, timeout)
  const cancel = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    const response = await fetcher(url, { ...init, signal: controller.signal, redirect: 'follow' })
    const declared = Number(response.headers.get('content-length') || 0)
    if (declared > maximum) throw new Error(`Response exceeds the ${maximum}-byte safety limit.`)
    return { ok: response.ok, status: response.status, body: await limitedText(response, maximum) }
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error
    if (timedOut) throw new DOMException('Request timed out.', 'TimeoutError')
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
  }
}

async function limitedText(response: Response, maximum: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let output = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maximum) throw new Error(`Response exceeds the ${maximum}-byte safety limit.`)
      output += decoder.decode(value, { stream: true })
    }
    return output + decoder.decode()
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  }
}

function remoteUrlError(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { return 'WebFetch URL must be an absolute http:// or https:// URL.' }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return 'WebFetch URL must be an absolute http:// or https:// URL.'
  if (url.username || url.password) return 'WebFetch does not send credential-bearing URLs to the reader service.'
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost') || /\.(?:local|internal|lan|home\.arpa)$/.test(host)) {
    return 'WebFetch cannot read local addresses through the remote reader service.'
  }
  if (isIP(host) && !publicIp(host)) return 'WebFetch cannot read private or local network addresses.'
  return ''
}

function publicIp(host: string): boolean {
  if (isIP(host) === 6) {
    const value = host.toLowerCase()
    if (value.startsWith('::ffff:')) return publicIp(value.slice(7))
    return value !== '::' && value !== '::1' && !/^(?:fc|fd|fe[89ab]|ff)/.test(value) && !value.startsWith('2001:db8:')
  }
  const [a = 0, b = 0, c = 0] = host.split('.').map(Number)
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || a === 100 && b >= 64 && b <= 127
    || a === 169 && b === 254
    || a === 172 && b >= 16 && b <= 31
    || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2))
    || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)
    || a === 203 && b === 0 && c === 113)
}

function anysearchResults(value: string): JsonObject[] {
  return value.split(/^###\s+\d+\.\s+/m).slice(1).flatMap(block => {
    const [title = '', ...lines] = block.split('\n')
    const body = lines.join('\n')
    const match = /^-\s+\*\*URL\*\*:\s*(\S+)\s*$/m.exec(body)
    if (!match) return []
    const content = compact(`${body.slice(0, match.index)} ${body.slice(match.index + match[0].length)}`).replace(/^-\s+/, '')
    return [{ title: title.trim(), url: match[1]!, content: content.slice(0, 800), score: null, published_date: '' }]
  })
}

function clippedPage(value: string, maximum: number): string {
  if (value.length <= maximum) return value
  const marker = '\n\n… [content truncated] …\n\n'
  const available = Math.max(0, maximum - marker.length)
  const head = Math.ceil(available * 0.7)
  return value.slice(0, head) + marker + value.slice(-(available - head))
}

function requiredText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`)
  const result = value.trim()
  if (result.length > maximum) throw new Error(`${name} must be at most ${maximum} characters`)
  return result
}

function integer(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return Number.isSafeInteger(value) ? Math.max(minimum, Math.min(maximum, Number(value))) : fallback
}

function choice<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === 'string' && values.includes(value as T) ? value as T : fallback
}

function record(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Provider returned invalid JSON.')
  return value as JsonObject
}

function text(value: unknown): string { return typeof value === 'string' ? value : '' }
function compact(value: string): string { return value.split(/\s+/).filter(Boolean).join(' ') }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
