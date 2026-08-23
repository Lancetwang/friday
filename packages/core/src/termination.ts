import type { ModelFinishReason, ModelTermination } from './types.js'

const reasons: Record<string, ModelFinishReason> = {
  stop: 'stop',
  end_turn: 'stop',
  stop_sequence: 'stop',
  completed: 'stop',
  tool_calls: 'tool_calls',
  tool_use: 'tool_calls',
  function_call: 'tool_calls',
  length: 'length',
  max_tokens: 'length',
  max_output_tokens: 'length',
  content_filter: 'content_filter',
  refusal: 'content_filter',
  safety: 'content_filter',
  incomplete: 'incomplete',
  cancelled: 'incomplete',
  canceled: 'incomplete',
  failed: 'incomplete',
  pause_turn: 'incomplete'
}

export function normalizeTermination(value: unknown): ModelTermination | undefined {
  if (typeof value !== 'string' || !value) return undefined
  const reason = reasons[value.toLowerCase()] ?? 'unknown'
  return { reason, ...(value === reason ? {} : { raw: value }) }
}

export function termination(reason: ModelFinishReason, raw?: string): ModelTermination {
  return { reason, ...(raw && raw !== reason ? { raw } : {}) }
}
