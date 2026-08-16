import { toolSchema, type AgentEvent, type ChatModel, type JsonObject, type Message, type RunContext, type Tool } from 'friday-agent-core'

import type { ModelConfig } from './config.js'
import { promptTemplate } from './prompts.js'

const COMPACT_AT = 0.85
const COMPACT_TARGET = 0.55
const SUMMARY_MAX_CHARS = 120_000
const MESSAGE_MAX_CHARS = 2_000
const USER_MESSAGE_MAX_CHARS = 8_000
const INSERT_PROMPT_TOKENS = 2_000
const RECENT_TURNS = [10, 6, 3, 2, 1]
const ANCHOR = 'friday.context_anchor'
const PENDING_ANCHOR = 'friday.pending_context_anchor'
const SUMMARY_SECTIONS = [
  '## Current Goal', '## Completed', '## Open Items', '## Tried Methods', '## Decisions',
  '## Working Files', '## Commands And Results', '## Verification State', '## Next Steps'
]

export type ContextCompaction = {
  kind: 'conversation' | 'tool_results'
  ok: boolean
  fallback: boolean
  /** How the summary was produced: full-fidelity in-place read, bounded transcript, or offline. */
  strategy: 'insert' | 'transcript' | 'offline' | 'none'
  reason: string
  before_tokens: number
  after_tokens: number
  window: number
  kept_turns: number
  tool_results: number
  memories: string[]
  notice: string
}

export function observeContextUsage(context: RunContext, event: AgentEvent): void {
  if (event.type === 'model.request.payload') {
    context.metadata[PENDING_ANCHOR] = {
      chars: wireLength(event.data.messages) + wireLength(event.data.tools),
      tool_chars: wireLength(event.data.tools)
    }
    return
  }
  if (event.type !== 'model.response.payload') return
  const pending = object(context.metadata[PENDING_ANCHOR])
  const message = object(event.data.message)
  const usage = object(message?.usage)
  const promptTokens = integer(usage?.prompt_tokens) ?? integer(usage?.input_tokens)
  if (pending && promptTokens !== undefined) {
    context.metadata[ANCHOR] = { ...pending, prompt_tokens: promptTokens }
  }
  delete context.metadata[PENDING_ANCHOR]
}

export function tokenMeasurement(context: RunContext, tools: readonly Tool[]): Record<string, unknown> {
  const toolChars = wireLength(tools.map(toolSchema))
  const chars = wireLength(context.messages) + toolChars
  const anchor = object(context.metadata[ANCHOR])
  const promptTokens = integer(anchor?.prompt_tokens)
  const anchorChars = integer(anchor?.chars)
  if (promptTokens !== undefined && anchorChars !== undefined) {
    const delta = tokenDelta(chars - anchorChars)
    return {
      tokens: Math.max(1, promptTokens + delta), provider_tokens: promptTokens,
      delta_tokens: delta, chars, source: delta ? 'provider+local-delta' : 'provider'
    }
  }
  return { tokens: estimatedTokens(chars), provider_tokens: null, delta_tokens: null, chars, source: 'local' }
}

export function contextReport(context: RunContext, tools: readonly Tool[], window: number): string {
  const measurement = tokenMeasurement(context, tools)
  const tokens = Number(measurement.tokens)
  const chars = Number(measurement.chars)
  const source = String(measurement.source)
  const system = context.messages.filter(message => message.role === 'system').map(message => messageText(message.content)).join('\n')
  const ordinary = context.messages.filter(message => message.role === 'user' || message.role === 'assistant').map(message => messageText(message.content)).join('\n')
  const results = context.messages.filter(message => message.role === 'tool').map(message => messageText(message.content)).join('\n')
  const schemas = JSON.stringify(tools.map(toolSchema))
  return [
    '# Context',
    `- window: ${window} tokens`,
    `- in the window now: ${source === 'provider' ? '' : '~'}${tokens} tokens / ${chars} chars / ${(tokens / window * 100).toFixed(1)}% (${source})`,
    `- compaction starts at: ${Math.floor(window * COMPACT_AT)} tokens (${Math.round(COMPACT_AT * 100)}%)`,
    '',
    '| Part | Local est. tokens | Exact chars |',
    '| --- | ---: | ---: |',
    ...[
      ['system prompt', system], ['tool schemas', schemas], ['messages', ordinary], ['tool results', results]
    ].map(([name, value]) => `| ${name} | ~${estimatedTokens(value!.length)} | ${value!.length} |`)
  ].join('\n')
}

export async function compactIfNeeded(options: {
  context: RunContext
  tools: readonly Tool[]
  config: ModelConfig
  model: ChatModel
  archive(messages: Message[]): void
  force?: boolean
  signal?: AbortSignal
}): Promise<{ record?: ContextCompaction; summary?: string }> {
  const before = Number(tokenMeasurement(options.context, options.tools).tokens)
  const window = options.config.contextWindow
  if (!options.force && before / window < COMPACT_AT) return {}
  try {
    return await compactConversation(options, before, window)
  } catch (error) {
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    const record = recordFor('conversation', before, before, window, 0, 'none', reason, false)
    options.context.emit('context.compacted', 'context', record)
    return { record }
  }
}

async function compactConversation(
  options: Parameters<typeof compactIfNeeded>[0],
  before: number,
  window: number
): Promise<{ record: ContextCompaction; summary: string }> {
  const body = conversationBody(options.context.messages)
  let summary = ''
  let strategy: ContextCompaction['strategy'] = 'insert'
  let fallback = false
  let reason = ''
  // Strategy 1 - insert-and-compact: append one instruction to the LIVE
  // conversation, tools and all, so the provider serves the whole prefix
  // from its prompt cache and the summarizer reads the full original, not
  // a bounded re-rendering. tool_choice 'none' keeps it text-only.
  const insertFits = before + INSERT_PROMPT_TOKENS + options.config.maxOutputTokens <= window
  if (insertFits) {
    try {
      const response = await options.model.complete({
        messages: [
          ...options.context.messages,
          { role: 'user', content: promptTemplate('COMPACT_INSERT.md').trim() }
        ],
        tools: options.tools.map(toolSchema),
        toolChoice: 'none',
        ...(options.signal ? { signal: options.signal } : {})
      })
      options.context.recordUsage(response.usage)
      summary = cleanSummary(response.content)
      if (!usableSummary(summary)) throw new Error('the model did not return session state')
    } catch (error) {
      if (options.signal?.aborted) throw error
      summary = ''
      reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    }
  }
  // Strategy 2 - bounded transcript: a fresh two-message request that fits
  // any window; the fallback when insert has no headroom or failed.
  if (!summary) {
    strategy = 'transcript'
    const transcriptText = transcript(body, SUMMARY_MAX_CHARS)
    try {
      const response = await options.model.complete({
        messages: [
          { role: 'system', content: promptTemplate('COMPACT_SYSTEM.md').trim() },
          { role: 'user', content: `${promptTemplate('COMPACT.md').trim()}\n\n# Conversation\n\n${transcriptText}` }
        ],
        ...(options.signal ? { signal: options.signal } : {})
      })
      options.context.recordUsage(response.usage)
      summary = cleanSummary(response.content)
      if (!usableSummary(summary)) throw new Error('the model did not return session state')
    } catch (error) {
      if (options.signal?.aborted) throw error
      // Strategy 3 - offline: never let compaction block the loop.
      strategy = 'offline'
      fallback = true
      reason = [reason, error instanceof Error ? `${error.name}: ${error.message}` : String(error)]
        .filter(Boolean).join('; ')
      summary = fallbackSummary(body, reason)
    }
  }
  const { summary: withoutMemory, memories } = splitMemory(summary)
  summary = withoutMemory
  const prefixLength = options.context.messages.length - body.length
  const prefix = options.context.messages.slice(0, prefixLength)
  const overhead = estimatedTokens(wireLength([...prefix, ...options.tools.map(toolSchema)]))
  const budget = Math.max(0, Math.floor(window * COMPACT_TARGET) - overhead - estimatedTokens(summary.length))
  const { recent, kept, request } = fitReplay(body, budget)
  if (!recent.length && !request) throw new Error('the run has no completed turn to replay')
  // The replayed request is prompt scaffolding. Archive its original so the
  // product transcript keeps one real user message while the cloned replay is hidden.
  const keptSet = new Set(recent)
  options.archive(body.filter(message => !keptSet.has(message) && !message.friday_compaction_artifact))
  const replacement: Message[] = [{
    role: 'assistant', content: `## Session Summary\n${summary.trim()}`, friday_compaction_artifact: true
  }]
  if (request) replacement.push({ ...structuredClone(request), friday_compaction_artifact: true })
  replacement.push(...recent)
  options.context.messages.splice(prefixLength, body.length, ...replacement)
  delete options.context.metadata[ANCHOR]
  const after = Number(tokenMeasurement(options.context, options.tools).tokens)
  const record = recordFor('conversation', before, after, window, kept, strategy, reason, true, memories, fallback)
  options.context.emit('context.compacted', 'context', record)
  return { record, summary }
}

function fitReplay(body: Message[], budget: number): { recent: Message[]; kept: number; request?: Message } {
  const users = body.flatMap((message, index) => message.role === 'user' && !message.friday_internal ? [index] : [])
  if (!users.length) return { recent: [], kept: 0 }
  const latestUser = users.at(-1)!
  const cycles = body.slice(latestUser + 1).flatMap((message, index) => message.role === 'assistant' ? [latestUser + 1 + index] : [])
  if (cycles.length) {
    let recent = body.slice(cycles.at(-1)!)
    let kept = 1
    for (let count = 1; count <= cycles.length; count += 1) {
      const candidate = body.slice(cycles[cycles.length - count]!)
      if (estimatedTokens(wireLength(candidate)) > budget) break
      recent = candidate
      kept = count
    }
    return { recent, kept, ...(body[latestUser] ? { request: body[latestUser] } : {}) }
  }
  let recent: Message[] = []
  let kept = 0
  for (const limit of RECENT_TURNS) {
    const start = users[Math.max(0, users.length - limit)]!
    const candidate = repairBody(body.slice(start))
    if (!candidate.length) continue
    recent = candidate
    kept = Math.min(limit, users.length)
    if (estimatedTokens(wireLength(candidate)) <= budget) break
  }
  return { recent, kept }
}

function transcript(messages: readonly Message[], maximum: number): string {
  const rows = messages.flatMap(message => {
    if (message.friday_compaction_artifact) return []
    // User messages are the ground truth of intent; they get a far larger
    // slice of the transcript budget than tool noise.
    const text = messageText(message.content).slice(0, message.role === 'user' ? USER_MESSAGE_MAX_CHARS : MESSAGE_MAX_CHARS)
    if (!text && message.role !== 'assistant') return []
    const calls = Array.isArray(message.tool_calls)
      ? `\nTool calls: ${message.tool_calls.map(call => call.function?.name).filter(Boolean).join(', ')}`
      : ''
    return [`${message.role.toUpperCase()}: ${text}${calls}`]
  })
  const selected: string[] = []
  let used = 0
  for (const row of [...rows].reverse()) {
    if (selected.length > 2 && used + row.length > maximum) break
    selected.push(row)
    used += row.length
  }
  return selected.reverse().join('\n\n')
}

function fallbackSummary(messages: readonly Message[], reason: string): string {
  const requests = messages.filter(message => message.role === 'user' && !message.friday_internal).map(message => messageText(message.content))
  const files = new Set<string>()
  for (const message of messages) {
    if (!Array.isArray(message.tool_calls)) continue
    for (const call of message.tool_calls) {
      try {
        const args = JSON.parse(call.function.arguments) as { path?: unknown }
        if (typeof args.path === 'string') files.add(args.path)
      } catch {}
    }
  }
  return [
    '## Current Goal', requests.at(-1) || 'Continue the current request.', '',
    '## Completed', '', '## Open Items', '', '## Tried Methods', '', '## Decisions', '',
    '## Working Files', ...[...files].slice(-20).map(path => `- ${path}`), '',
    '## Commands And Results', '', '## Verification State', 'status: working', '',
    '## Next Steps', 'Re-read the recent turns below and continue.', '',
    `Friday wrote this summary locally because compaction failed (${reason}).`
  ].join('\n')
}

function cleanSummary(value: string): string {
  return value
    .replace(/<(tool_call|tool_calls|function_calls|invoke)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/^\s*```[\w-]*\s*$/gm, '')
    .trim()
}

function usableSummary(value: string): boolean {
  return value.length >= 40 && SUMMARY_SECTIONS.some(section => value.includes(section)) && !/<(?:tool_call|function_calls|invoke)\b/i.test(value)
}

function splitMemory(value: string): { summary: string; memories: string[] } {
  const lines = value.split('\n')
  const start = lines.findIndex(line => line.trim() === '## Memory')
  if (start < 0) return { summary: value, memories: [] }
  let end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  if (end < 0) end = lines.length
  const memories = lines.slice(start + 1, end).flatMap(line => {
    const item = /^\s*[-*]\s+(.+)$/.exec(line)?.[1]?.trim()
    return item && !['none', '(none)', 'n/a'].includes(item.toLowerCase()) ? [item] : []
  }).slice(0, 12)
  return { summary: [...lines.slice(0, start), ...lines.slice(end)].join('\n').trim(), memories }
}

function recordFor(
  kind: ContextCompaction['kind'], before: number, after: number, window: number,
  kept: number, strategy: ContextCompaction['strategy'], reason: string, ok = true,
  memories: string[] = [], fallback = false
): ContextCompaction {
  const notice = ok
    ? `conversation compacted (${strategy}): ${before} -> ${after} tokens${fallback ? ' (offline summary)' : ''}`
    : `conversation compaction skipped: ${reason || 'unavailable'}`
  return {
    kind, ok, fallback, strategy, reason, before_tokens: before, after_tokens: after,
    window, kept_turns: kept, tool_results: 0, memories, notice
  }
}

function conversationBody(messages: readonly Message[]): Message[] {
  let start = 0
  while (messages[start]?.role === 'system') start += 1
  return messages.slice(start)
}

function repairBody(messages: Message[]): Message[] {
  let start = 0
  while (messages[start]?.role === 'tool') start += 1
  return messages.slice(start)
}

function messageText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return value == null ? '' : String(value)
  return value.flatMap(part => object(part)?.type === 'text' ? [String(object(part)?.text ?? '')] : []).join('\n')
}

function wireLength(value: unknown): number {
  return JSON.stringify(wireValue(value))?.length ?? 0
}

function wireValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(wireValue)
  const item = object(value)
  if (!item) return value
  if (item.type === 'image_url') return { type: 'image_url', image_url: { url: '[image attachment]' } }
  return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, wireValue(child)]))
}

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
}

function integer(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined
}

function estimatedTokens(chars: number): number {
  return Math.max(1, Math.ceil(chars / 4))
}

function tokenDelta(chars: number): number {
  return chars >= 0 ? Math.ceil(chars / 4) : -Math.ceil(-chars / 4)
}
