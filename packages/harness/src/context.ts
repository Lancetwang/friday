import { createHash } from 'node:crypto'

import {
  toolSchema,
  type AgentEvent,
  type JsonObject,
  type Message,
  type RunContext,
  type Tool,
  type ToolCall
} from 'friday-agent-core'

import type { CompactionSettings } from './config.js'
import type {
  CompactionRequest,
  CompactionResult,
  ContextCompaction,
  ContextCompactor
} from './plugin-api.js'
import { promptTemplate } from './prompts.js'

export type { CompactionRequest, CompactionResult, ContextCompaction, ContextCompactor } from './plugin-api.js'

const COMPACT_TARGET = 0.55
const TOOL_RESULT_TARGET_DELTA = 0.15
const PROTECTED_TOOL_BATCHES = 3
const MIN_TOMBSTONE_SAVINGS = 512
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

export function contextReport(
  context: RunContext,
  tools: readonly Tool[],
  window: number,
  settings: CompactionSettings,
  provider = ''
): string {
  const measurement = tokenMeasurement(context, tools)
  const tokens = Number(measurement.tokens)
  const chars = Number(measurement.chars)
  const source = String(measurement.source)
  const system = context.messages.filter(message => message.role === 'system').map(message => messageText(message.content)).join('\n')
  const ordinary = context.messages.filter(message => message.role === 'user' || message.role === 'assistant').map(message => messageText(message.content)).join('\n')
  const results = context.messages.filter(message => message.role === 'tool').map(message => messageText(message.content)).join('\n')
  const schemas = JSON.stringify(tools.map(toolSchema))
  const automatic = !provider
    ? 'unavailable (no plugin)'
    : settings.automatic ? `at ${settings.threshold_percent}% using ${settings.strategy}` : 'off (use /compact)'
  return [
    '# Context',
    `- window: ${window} tokens`,
    `- in the window now: ${source === 'provider' ? '' : '~'}${tokens} tokens / ${chars} chars / ${(tokens / window * 100).toFixed(1)}% (${source})`,
    `- compaction plugin: ${provider || 'none'}`,
    `- automatic compaction: ${automatic}`,
    '',
    '| Part | Local est. tokens | Exact chars |',
    '| --- | ---: | ---: |',
    ...[
      ['system prompt', system], ['tool schemas', schemas], ['messages', ordinary], ['tool results', results]
    ].map(([name, value]) => `| ${name} | ~${estimatedTokens(value!.length)} | ${value!.length} |`)
  ].join('\n')
}

export const compactIfNeeded: ContextCompactor = async options => {
  const before = Number(tokenMeasurement(options.context, options.tools).tokens)
  const window = options.config.contextWindow
  const threshold = options.settings.threshold_percent / 100
  if (!options.force && (!options.settings.automatic || before / window < threshold)) return {}
  try {
    if (options.settings.strategy === 'two-stage') {
      const toolResults = compactToolResults(options, before, window, threshold)
      if (toolResults) return toolResults
    }
    return await compactConversation(options, before, window)
  } catch (error) {
    if (options.signal?.aborted) throw error
    return recordCompactionFailure(options.context, before, window, error)
  }
}

/** Convert a provider failure into an observable no-op; cancellation still propagates. */
export function recordCompactionFailure(
  context: RunContext,
  before: number,
  window: number,
  error: unknown
): CompactionResult {
  const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  const record = recordFor('conversation', before, before, window, 0, 'none', reason, false)
  context.emit('context.compacted', 'context', record)
  return { record }
}

/** Materialize the durable transcript instead of the smaller model projection. */
export function restoreCompactedMessage(message: Message): Message {
  if (!Object.prototype.hasOwnProperty.call(message, 'friday_original_tool_content')) return message
  const restored = structuredClone(message)
  restored.content = structuredClone(restored.friday_original_tool_content)
  delete restored.friday_original_tool_content
  return restored
}

/**
 * Deterministic stage one: keep calls and their ids intact, but replace old,
 * already-consumed results with small receipts. The edits are transactional;
 * if they cannot free a useful amount, semantic compaction sees the originals.
 */
function compactToolResults(
  options: CompactionRequest,
  before: number,
  window: number,
  threshold: number
): CompactionResult | undefined {
  const body = conversationBody(options.context.messages)
  const batches = completeToolBatches(body)
  const eligible = batches.slice(0, Math.max(0, batches.length - PROTECTED_TOOL_BATCHES))
  const outcomes = toolOutcomes(body)
  const changed: Array<{ message: Message; content: unknown }> = []
  for (const batch of eligible) {
    for (const { call, result } of batch.results) {
      if (Object.prototype.hasOwnProperty.call(result, 'friday_original_tool_content')) continue
      const original = messageText(result.content)
      const receipt = JSON.stringify({
        compacted: true,
        tool: call.function.name,
        status: outcomes.get(call.id) === 'error' ? 'error' : 'completed',
        original_chars: original.length,
        digest: `sha256:${createHash('sha256').update(original).digest('hex')}`,
        message: 'Exact tool result archived after use; rerun the tool if details are needed.'
      })
      if (original.length - receipt.length < MIN_TOMBSTONE_SAVINGS) continue
      changed.push({ message: result, content: result.content })
      result.friday_original_tool_content = structuredClone(result.content)
      result.content = receipt
    }
  }
  if (!changed.length) return undefined

  const candidateAfter = Number(tokenMeasurement(options.context, options.tools).tokens)
  const target = Math.max(0.4, threshold - TOOL_RESULT_TARGET_DELTA)
  if (candidateAfter / window > target) {
    for (const change of changed) {
      change.message.content = change.content
      delete change.message.friday_original_tool_content
    }
    return undefined
  }

  delete options.context.metadata[ANCHOR]
  const after = Number(tokenMeasurement(options.context, options.tools).tokens)
  const record = recordFor(
    'tool_results', before, after, window, 0, 'tombstone', '', true, [], false, changed.length
  )
  options.context.emit('context.compacted', 'context', record)
  return { record }
}

type CompleteToolBatch = {
  results: Array<{ call: ToolCall; result: Message }>
}

function completeToolBatches(messages: readonly Message[]): CompleteToolBatch[] {
  const batches: CompleteToolBatch[] = []
  for (let index = 0; index < messages.length; index += 1) {
    const assistant = messages[index]
    if (assistant?.role !== 'assistant' || !Array.isArray(assistant.tool_calls) || !assistant.tool_calls.length) continue
    const calls = assistant.tool_calls.filter(validToolCall)
    if (!calls.length) continue
    const byId = new Map<string, Message>()
    for (let cursor = index + 1; messages[cursor]?.role === 'tool'; cursor += 1) {
      const result = messages[cursor]!
      const id = String(result.tool_call_id ?? '')
      if (!byId.has(id)) byId.set(id, result)
    }
    if (calls.some(call => !byId.has(call.id))) continue
    batches.push({ results: calls.map(call => ({ call, result: byId.get(call.id)! })) })
  }
  return batches
}

function validToolCall(value: unknown): value is ToolCall {
  if (!value || typeof value !== 'object') return false
  const call = value as Partial<ToolCall>
  return typeof call.id === 'string'
    && !!call.function
    && typeof call.function.name === 'string'
    && typeof call.function.arguments === 'string'
}

function toolOutcomes(messages: readonly Message[]): Map<string, string> {
  const outcomes = new Map<string, string>()
  for (const message of messages) {
    if (!Array.isArray(message.friday_activities)) continue
    for (const value of message.friday_activities) {
      const activity = object(value)
      if (activity?.kind !== 'tool' || typeof activity.tool_call_id !== 'string') continue
      outcomes.set(activity.tool_call_id, String(activity.status || ''))
    }
  }
  return outcomes
}

async function compactConversation(
  options: CompactionRequest,
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
  memories: string[] = [], fallback = false, toolResults = 0
): ContextCompaction {
  const notice = ok
    ? kind === 'tool_results'
      ? `tool results compacted (${strategy}): ${before} -> ${after} tokens`
      : `conversation compacted (${strategy}): ${before} -> ${after} tokens${fallback ? ' (offline summary)' : ''}`
    : `conversation compaction skipped: ${reason || 'unavailable'}`
  return {
    kind, ok, fallback, strategy, reason, before_tokens: before, after_tokens: after,
    window, kept_turns: kept, tool_results: toolResults, memories, notice
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
  return Object.fromEntries(Object.entries(item)
    .filter(([key]) => key !== 'friday_original_tool_content')
    .map(([key, child]) => [key, wireValue(child)]))
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
