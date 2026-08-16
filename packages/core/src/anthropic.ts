import { isObject, readSseJson } from './sse.js'
import type { AssistantMessage, ChatModel, JsonObject, Message, ModelRequest, ToolCall, ToolSchema } from './types.js'

export type AnthropicModelOptions = {
  apiKey: string
  model: string
  baseUrl?: string
  maxOutputTokens?: number
  /**
   * Mark the prompt for Anthropic's explicit prompt cache: one breakpoint
   * after the system prompt and one on the final message, so each request
   * reads the previous request's prefix at cache price. Enable only for
   * real Anthropic endpoints; compatible proxies may reject the field.
   */
  cacheControl?: boolean
  body?: JsonObject
}

export class AnthropicModel implements ChatModel {
  constructor(private readonly options: AnthropicModelOptions) {
    if (!options.apiKey) throw new Error('Anthropic Messages model requires an API key.')
    if (!options.model) throw new Error('Anthropic Messages model requires a model name.')
  }

  async complete(request: ModelRequest): Promise<AssistantMessage> {
    const { system, messages } = anthropicMessages(request.messages)
    const cached = this.options.cacheControl === true
    if (cached) markCacheBreakpoint(messages)
    const response = await fetch(`${normalizeBaseUrl(this.options.baseUrl)}/v1/messages`, {
      method: 'POST',
      headers: {
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'x-api-key': this.options.apiKey
      },
      body: JSON.stringify({
        model: this.options.model,
        messages,
        max_tokens: this.options.maxOutputTokens ?? 4_096,
        stream: true,
        ...(system
          ? { system: cached ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : system }
          : {}),
        ...(request.tools?.length
          ? { tools: request.tools.map(anthropicTool), tool_choice: { type: request.toolChoice === 'none' ? 'none' : 'auto' } }
          : {}),
        ...this.options.body
      }),
      ...(request.signal ? { signal: request.signal } : {})
    })
    if (!response.ok) throw new Error(`Model request failed (${response.status}): ${(await response.text()).slice(0, 4_000)}`)
    if (!response.body) throw new Error('Model response had no body.')
    return readAnthropicStream(response.body, request)
  }
}

export function anthropicMessages(source: readonly Message[]): { system: string; messages: JsonObject[] } {
  const system: string[] = []
  const messages: JsonObject[] = []
  let results: JsonObject[] = []
  const flushResults = () => {
    if (results.length) messages.push({ role: 'user', content: results })
    results = []
  }
  for (const message of source) {
    if (message.role === 'system') {
      system.push(textContent(message.content))
      continue
    }
    if (message.role === 'tool') {
      results.push({ type: 'tool_result', tool_use_id: String(message.tool_call_id ?? ''), content: textContent(message.content) })
      continue
    }
    flushResults()
    if (message.role === 'user') messages.push({ role: 'user', content: anthropicContent(message.content) })
    else if (message.role === 'assistant') {
      const content: JsonObject[] = []
      if (Array.isArray(message.reasoning_content)) {
        content.push(...message.reasoning_content.filter(isObject).map(value => ({ ...value })))
      }
      const text = textContent(message.content)
      if (text) content.push({ type: 'text', text })
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          content.push({
            type: 'tool_use', id: call.id, name: call.function.name,
            input: parseArguments(call.function.arguments)
          })
        }
      }
      messages.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] })
    }
  }
  flushResults()
  return { system: system.filter(Boolean).join('\n\n'), messages }
}

async function readAnthropicStream(body: ReadableStream<Uint8Array>, request: ModelRequest): Promise<AssistantMessage> {
  let content = ''
  let inputTokens: number | undefined
  let outputTokens: number | undefined
  // Cache counts only ever arrive on message_start; keep them verbatim so the
  // usage this returns stays a faithful copy of what Anthropic reported.
  let cacheUsage: JsonObject = {}
  const blocks = new Map<number, JsonObject>()
  for await (const event of readSseJson(body)) {
    const type = String(event.type ?? '')
    if (type === 'message_start' && isObject(event.message) && isObject(event.message.usage)) {
      inputTokens = integer(event.message.usage.input_tokens)
      cacheUsage = cacheFields(event.message.usage)
    } else if (type === 'content_block_start' && typeof event.index === 'number' && isObject(event.content_block)) {
      blocks.set(event.index, { ...event.content_block })
    } else if (type === 'content_block_delta' && typeof event.index === 'number' && isObject(event.delta)) {
      const block = blocks.get(event.index) ?? {}
      const deltaType = String(event.delta.type ?? '')
      if (deltaType === 'text_delta') {
        const text = String(event.delta.text ?? '')
        content += text
        request.onDelta?.(text)
      } else if (deltaType === 'thinking_delta') {
        const text = String(event.delta.thinking ?? '')
        block.thinking = String(block.thinking ?? '') + text
        request.onReasoningDelta?.(text)
      } else if (deltaType === 'signature_delta') {
        block.signature = String(block.signature ?? '') + String(event.delta.signature ?? '')
      } else if (deltaType === 'input_json_delta') {
        block.partial_json = String(block.partial_json ?? '') + String(event.delta.partial_json ?? '')
      }
      blocks.set(event.index, block)
    } else if (type === 'message_delta' && isObject(event.usage)) {
      outputTokens = integer(event.usage.output_tokens)
    }
  }
  const reasoning: JsonObject[] = []
  const calls: ToolCall[] = []
  for (const [, block] of [...blocks].sort(([left], [right]) => left - right)) {
    const type = String(block.type ?? '')
    if (type === 'thinking' || type === 'redacted_thinking') {
      const { partial_json: _partial, ...kept } = block
      reasoning.push(kept)
    } else if (type === 'tool_use') {
      calls.push({
        id: String(block.id ?? ''), type: 'function',
        function: { name: String(block.name ?? ''), arguments: completeArguments(block) }
      })
    }
  }
  return {
    role: 'assistant', content,
    ...(reasoning.length ? { reasoning_content: reasoning } : {}),
    ...(calls.length ? { tool_calls: calls } : {}),
    ...(inputTokens !== undefined || outputTokens !== undefined
      ? { usage: { input_tokens: inputTokens ?? 0, output_tokens: outputTokens ?? 0, ...cacheUsage } }
      : {})
  }
}

function cacheFields(usage: JsonObject): JsonObject {
  const read = integer(usage.cache_read_input_tokens)
  const written = integer(usage.cache_creation_input_tokens)
  return {
    ...(read === undefined ? {} : { cache_read_input_tokens: read }),
    ...(written === undefined ? {} : { cache_creation_input_tokens: written })
  }
}

/**
 * A rolling breakpoint on the last content block of the final message: the
 * next request extends this prefix, so its reads land on this cache entry.
 */
function markCacheBreakpoint(messages: JsonObject[]): void {
  const last = messages.at(-1)
  if (!last) return
  if (typeof last.content === 'string') {
    last.content = [{ type: 'text', text: last.content || ' ', cache_control: { type: 'ephemeral' } }]
    return
  }
  if (!Array.isArray(last.content)) return
  const block = last.content.at(-1)
  if (isObject(block)) block.cache_control = { type: 'ephemeral' }
}

function anthropicTool(tool: ToolSchema): JsonObject {
  return {
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters
  }
}

function anthropicContent(value: unknown): unknown {
  if (!Array.isArray(value)) return textContent(value)
  const blocks: JsonObject[] = []
  for (const part of value) {
    if (!isObject(part)) continue
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: String(part.text ?? '') })
      continue
    }
    if (part.type !== 'image_url' || !isObject(part.image_url)) continue
    const url = String(part.image_url.url ?? '')
    const data = /^data:([^;,]+);base64,(.+)$/s.exec(url)
    if (data) blocks.push({ type: 'image', source: { type: 'base64', media_type: data[1] ?? '', data: data[2] ?? '' } })
    else if (url) blocks.push({ type: 'image', source: { type: 'url', url } })
  }
  return blocks
}

function completeArguments(block: JsonObject): string {
  if (typeof block.partial_json === 'string') return block.partial_json || '{}'
  return JSON.stringify(isObject(block.input) ? block.input : {})
}

function parseArguments(value: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(value || '{}')
    return isObject(parsed) ? parsed : { raw: value }
  } catch {
    return { raw: value }
  }
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return value == null ? '' : String(value)
  return value.filter(isObject).filter(part => part.type === 'text').map(part => String(part.text ?? '')).join('\n')
}

function normalizeBaseUrl(value?: string): string {
  return (value || 'https://api.anthropic.com').replace(/\/$/, '').replace(/\/v1$/, '')
}

function integer(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined
}
