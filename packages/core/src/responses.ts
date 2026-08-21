import { throwModelRequestError } from './errors.js'
import { isObject, readSseJson } from './sse.js'
import type { AssistantMessage, ChatModel, JsonObject, Message, ModelRequest, ToolCall, ToolSchema } from './types.js'

export type ResponsesModelOptions = {
  apiKey: string
  model: string
  baseUrl?: string
  maxOutputTokens?: number
  body?: JsonObject
}

export class ResponsesModel implements ChatModel {
  constructor(private readonly options: ResponsesModelOptions) {
    if (!options.apiKey) throw new Error('OpenAI Responses model requires an API key.')
    if (!options.model) throw new Error('OpenAI Responses model requires a model name.')
  }

  async complete(request: ModelRequest): Promise<AssistantMessage> {
    const { instructions, input } = responsesInput(request.messages)
    const response = await fetch(`${normalizeBaseUrl(this.options.baseUrl)}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.options.model,
        input,
        stream: true,
        ...(instructions ? { instructions } : {}),
        ...(request.tools?.length ? { tools: request.tools.map(responsesTool), tool_choice: request.toolChoice ?? 'auto' } : {}),
        ...(this.options.maxOutputTokens ? { max_output_tokens: this.options.maxOutputTokens } : {}),
        ...this.options.body
      }),
      ...(request.signal ? { signal: request.signal } : {})
    })
    if (!response.ok) await throwModelRequestError(response)
    if (!response.body) throw new Error('Model response had no body.')
    let completed: JsonObject | undefined
    for await (const event of readSseJson(response.body)) {
      const type = String(event.type ?? '')
      if (type === 'response.output_text.delta') {
        request.onDelta?.(String(event.delta ?? ''))
      } else if (type === 'response.reasoning_text.delta' || type === 'response.reasoning_summary_text.delta') {
        request.onReasoningDelta?.(String(event.delta ?? ''))
      } else if (type === 'response.completed' && isObject(event.response)) completed = event.response
    }
    if (!completed) throw new Error('Responses stream ended without a completed response.')
    return responsesMessage(completed)
  }
}

export function responsesInput(source: readonly Message[]): { instructions: string; input: JsonObject[] } {
  const system: string[] = []
  const input: JsonObject[] = []
  for (const message of source) {
    if (message.role === 'system') {
      system.push(textContent(message.content))
      continue
    }
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: String(message.tool_call_id ?? ''), output: textContent(message.content) })
      continue
    }
    if (message.role !== 'user' && message.role !== 'assistant') continue
    if (message.role === 'assistant' && Array.isArray(message.reasoning_content)) {
      input.push(...message.reasoning_content.filter(isObject).map(value => ({ ...value })))
    }
    const content = responsesContent(message.content)
    if (content && (!Array.isArray(content) || content.length)) input.push({ role: message.role, content })
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        input.push({
          type: 'function_call', call_id: call.id, name: call.function.name,
          arguments: call.function.arguments || '{}'
        })
      }
    }
  }
  return { instructions: system.filter(Boolean).join('\n\n'), input }
}

export function responsesMessage(response: JsonObject): AssistantMessage {
  let content = ''
  const reasoning: JsonObject[] = []
  const calls: ToolCall[] = []
  if (Array.isArray(response.output)) {
    for (const item of response.output) {
      if (!isObject(item)) continue
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const block of item.content) {
          if (isObject(block) && block.type === 'output_text') content += String(block.text ?? '')
        }
      } else if (item.type === 'reasoning') reasoning.push({ ...item })
      else if (item.type === 'function_call') {
        calls.push({
          id: String(item.call_id ?? item.id ?? ''), type: 'function',
          function: { name: String(item.name ?? ''), arguments: String(item.arguments ?? '{}') }
        })
      }
    }
  }
  return {
    role: 'assistant', content,
    ...(reasoning.length ? { reasoning_content: reasoning } : {}),
    ...(calls.length ? { tool_calls: calls } : {}),
    ...(isObject(response.usage) ? { usage: response.usage } : {})
  }
}

function responsesContent(value: unknown): string | JsonObject[] {
  if (!Array.isArray(value)) return textContent(value)
  const parts: JsonObject[] = []
  for (const part of value) {
    if (!isObject(part)) continue
    if (part.type === 'text') {
      parts.push({ type: 'input_text', text: String(part.text ?? '') })
      continue
    }
    if (part.type === 'image_url' && isObject(part.image_url)) {
      const imageUrl = String(part.image_url.url ?? '')
      if (imageUrl) parts.push({ type: 'input_image', image_url: imageUrl })
    }
  }
  return parts
}

function responsesTool(tool: ToolSchema): JsonObject {
  return {
    type: 'function', name: tool.function.name, description: tool.function.description,
    parameters: tool.function.parameters
  }
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return value == null ? '' : String(value)
  return value.filter(isObject).filter(part => part.type === 'text').map(part => String(part.text ?? '')).join('\n')
}

function normalizeBaseUrl(value?: string): string {
  return (value || 'https://api.openai.com/v1').replace(/\/$/, '')
}
