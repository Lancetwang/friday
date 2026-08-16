import { isObject, readSseJson } from './sse.js'
import type { AssistantMessage, ChatModel, JsonObject, ModelRequest, ToolCall } from './types.js'

export type OpenAIModelOptions = {
  apiKey: string
  model: string
  baseUrl?: string
  maxOutputTokens?: number
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  body?: JsonObject
}

export class OpenAIModel implements ChatModel {
  constructor(private readonly options: OpenAIModelOptions) {
    if (!options.apiKey) throw new Error('OpenAI-compatible model requires an API key.')
    if (!options.model) throw new Error('OpenAI-compatible model requires a model name.')
  }

  async complete(request: ModelRequest): Promise<AssistantMessage> {
    const response = await fetch(`${normalizeBaseUrl(this.options.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.options.model,
        messages: openaiMessages(request.messages),
        stream: true,
        stream_options: { include_usage: true },
        ...(request.tools?.length ? { tools: request.tools, tool_choice: request.toolChoice ?? 'auto' } : {}),
        ...(this.options.maxOutputTokens
          ? { [this.options.maxTokensField ?? 'max_tokens']: this.options.maxOutputTokens }
          : {}),
        ...this.options.body
      }),
      ...(request.signal ? { signal: request.signal } : {})
    })
    if (!response.ok) throw new Error(`Model request failed (${response.status}): ${(await response.text()).slice(0, 4_000)}`)
    if (!response.body) throw new Error('Model response had no body.')
    return readStream(response.body, request)
  }
}

export function openaiMessages(messages: ModelRequest['messages']): JsonObject[] {
  return messages.map(message => ({
    role: message.role,
    content: message.content,
    ...(message.role === 'assistant' && Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls } : {}),
    ...(message.role === 'assistant' && message.reasoning_content !== undefined ? { reasoning_content: message.reasoning_content } : {}),
    ...(message.role === 'tool' ? { tool_call_id: String(message.tool_call_id ?? '') } : {})
  }))
}

async function readStream(body: ReadableStream<Uint8Array>, request: ModelRequest): Promise<AssistantMessage> {
  let content = ''
  let reasoning = ''
  let usage: JsonObject | undefined
  const calls = new Map<number, ToolCall>()

  for await (const chunk of readSseJson(body)) {
    if (isObject(chunk.usage)) usage = chunk.usage
    const delta = firstDelta(chunk)
    if (!delta) continue
    if (typeof delta.content === 'string') {
      content += delta.content
      request.onDelta?.(delta.content)
    }
    if (typeof delta.reasoning_content === 'string') {
      reasoning += delta.reasoning_content
      request.onReasoningDelta?.(delta.reasoning_content)
    }
    mergeToolCalls(calls, delta.tool_calls)
  }
  return {
    role: 'assistant',
    content,
    ...(reasoning ? { reasoning_content: reasoning } : {}),
    ...(calls.size ? { tool_calls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call) } : {}),
    ...(usage ? { usage } : {})
  }
}

function firstDelta(chunk: JsonObject): JsonObject | undefined {
  const choices = chunk.choices
  if (!Array.isArray(choices) || !isObject(choices[0])) return undefined
  return isObject(choices[0].delta) ? choices[0].delta : undefined
}

function mergeToolCalls(target: Map<number, ToolCall>, value: unknown): void {
  if (!Array.isArray(value)) return
  value.forEach((raw, fallback) => {
    if (!isObject(raw)) return
    const index = typeof raw.index === 'number' ? raw.index : fallback
    const current = target.get(index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } }
    if (typeof raw.id === 'string') current.id = raw.id
    const fn = raw.function
    if (isObject(fn)) {
      if (typeof fn.name === 'string') current.function.name += fn.name
      if (typeof fn.arguments === 'string') current.function.arguments += fn.arguments
    }
    target.set(index, current)
  })
}

function normalizeBaseUrl(value?: string): string {
  return (value || 'https://api.openai.com/v1').replace(/\/$/, '')
}
