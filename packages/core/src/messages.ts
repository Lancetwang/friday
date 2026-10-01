import { createHash } from 'node:crypto'
import type { AssistantMessage, Message, ModelOrigin, ToolCall } from './types.js'

export function modelOrigin(api: ModelOrigin['api'], options: { model: string; provider?: string; baseUrl?: string }): ModelOrigin {
  return { api, provider: options.provider ?? api, model: options.model,
    endpoint: (options.baseUrl ?? (api === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1')).replace(/\/+$/, '') }
}

/** Project a copy; the durable transcript retains original signatures and ids. */
export function projectMessages(source: readonly Message[], target: ModelOrigin, vision = true): Message[] {
  const result: Message[] = []
  const pending = new Map<string, string[]>()
  const used = new Set<string>()
  const flush = () => {
    for (const id of [...pending.values()].flat()) result.push({ role: 'tool', tool_call_id: id,
      content: 'Tool execution was interrupted; no result was recorded.', is_error: true })
    pending.clear()
  }
  for (const original of source) {
    if (original.role === 'user' || original.role === 'assistant') flush()
    const message = structuredClone(original)
    if (message.role === 'assistant') {
      if (!sameOrigin(message.model_origin, target)) delete message.reasoning_content
      if (Array.isArray(message.tool_calls)) {
        message.tool_calls = (message.tool_calls as ToolCall[]).map(call => {
          const id = normalizeToolId(call.id)
          const projectedId = used.has(id) ? normalizeToolId(`${call.id}|${used.size}`) : id
          used.add(projectedId)
          pending.set(call.id, [...pending.get(call.id) ?? [], projectedId])
          return { ...call, id: projectedId }
        })
      }
    } else if (message.role === 'tool') {
      const originalId = String(message.tool_call_id ?? '')
      const queue = pending.get(originalId)
      const id = queue?.shift()
      if (!id) continue // Orphan results are invalid in every supported API.
      message.tool_call_id = id
      if (!queue?.length) pending.delete(originalId)
    }
    if (!vision && Array.isArray(message.content)) {
      message.content = message.content.map(block => block && typeof block === 'object' && ['image_url', 'image', 'input_image'].includes(String(block.type))
        ? { type: 'text', text: '[Image omitted: the selected model does not support image input.]' } : block)
    }
    result.push(message)
  }
  flush()
  return result
}

export function withModelOrigin(message: AssistantMessage, origin: ModelOrigin): AssistantMessage {
  return { ...message, model_origin: origin }
}

function sameOrigin(source: unknown, target: ModelOrigin): boolean {
  if (!source || typeof source !== 'object') return false
  const value = source as Partial<ModelOrigin>
  return value.api === target.api && value.provider === target.provider && value.model === target.model && value.endpoint === target.endpoint
}

function normalizeToolId(id: string): string {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id) ? id : `call_${createHash('sha256').update(id).digest('hex').slice(0,32)}`
}
