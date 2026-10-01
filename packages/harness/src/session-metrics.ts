import type { AgentEvent } from 'friday-agent-core'


export type TurnMetrics = {
  elapsed_ms: number
  requests: number
  /** Summed over the turn's requests: what it cost, not how full the window is. */
  input_tokens: number | null
  output_tokens: number | null
  /** Part of `input_tokens` the providers served from cache. Null when unreported. */
  cached_tokens: number | null
  /** How full the context is once the turn ends, and the model's window. */
  window_tokens?: number | null
  window?: number | null
  /** True when `window_tokens` is Friday's own estimate rather than provider-anchored. */
  estimated_tokens?: boolean
}


export function turnActivities(events: readonly AgentEvent[]): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = []
  const requests = new Map<string, number>()
  const reasoning = new Map<string, { item: Record<string, unknown>; parts: string[]; started: number; ended: number }>()
  for (const event of events) {
    const key = `${event.runId}:${event.step ?? ''}`
    if (event.type === 'model.request') {
      requests.set(key, event.timestamp)
    } else if (event.type === 'model.reasoning.delta') {
      let current = reasoning.get(key)
      if (!current) {
        const item: Record<string, unknown> = { kind: 'reasoning', text: '', status: 'done' }
        current = { item, parts: [], started: requests.get(key) ?? event.timestamp, ended: event.timestamp }
        reasoning.set(key, current)
        items.push(item)
      }
      current.parts.push(String(event.data.content ?? ''))
      current.ended = event.timestamp
    } else if (event.type === 'model.response') {
      finishReasoning(reasoning.get(key), event.timestamp)
      requests.delete(key)
    } else if (event.type === 'tool.result') {
      const elapsed = event.data.elapsed_ms
      items.push({
        kind: 'tool',
        tool_call_id: String(event.data.tool_call_id ?? ''),
        status: event.data.is_error ? 'error' : 'done',
        ...(typeof elapsed === 'number' && Number.isFinite(elapsed) ? { elapsed_ms: Math.max(0, Math.round(elapsed)) } : {})
      })
    }
  }
  for (const current of reasoning.values()) finishReasoning(current, current.ended)
  return items.filter(item => item.kind !== 'reasoning' || String(item.text || '').trim())
}


function finishReasoning(
  current: { item: Record<string, unknown>; parts: string[]; started: number; ended: number } | undefined,
  ended: number
): void {
  if (!current) return
  current.item.text = current.parts.join('')
  current.item.elapsed_ms = Math.max(0, Math.round(ended - current.started))
}


export function emptyMetrics(): TurnMetrics {
  return { elapsed_ms: 0, requests: 0, input_tokens: 0, output_tokens: 0, cached_tokens: null }
}


export function turnMetrics(value: unknown): TurnMetrics | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const metrics = value as Record<string, unknown>
  if (!finite(metrics.elapsed_ms) || !finite(metrics.requests)) return undefined
  return {
    elapsed_ms: Math.max(0, Math.round(metrics.elapsed_ms as number)),
    requests: Math.max(0, Math.round(metrics.requests as number)),
    input_tokens: finite(metrics.input_tokens) ? Math.max(0, Math.round(metrics.input_tokens as number)) : null,
    output_tokens: finite(metrics.output_tokens) ? Math.max(0, Math.round(metrics.output_tokens as number)) : null,
    cached_tokens: finite(metrics.cached_tokens) ? Math.max(0, Math.round(metrics.cached_tokens as number)) : null,
    ...(finite(metrics.window_tokens) ? { window_tokens: Math.max(0, Math.round(metrics.window_tokens as number)) } : {}),
    ...(finite(metrics.window) ? { window: Math.max(0, Math.round(metrics.window as number)) } : {}),
    ...(typeof metrics.estimated_tokens === 'boolean' ? { estimated_tokens: metrics.estimated_tokens } : {})
  }
}


function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}


/**
 * Spend adds up across a turn's phases; occupancy does not. The window figures
 * describe a single moment, so the newer side wins rather than being summed.
 */
export function addMetrics(
  left: TurnMetrics,
  right: {
    elapsed_ms: number
    requests: number
    input_tokens: number | null
    output_tokens: number | null
    cached_tokens?: number | null
    window_tokens?: number | null
    window?: number | null
    estimated_tokens?: boolean
  }
): TurnMetrics {
  const occupancy = right.window_tokens == null
    ? {
      ...(left.window_tokens == null ? {} : { window_tokens: left.window_tokens, window: left.window }),
      ...(left.estimated_tokens === undefined ? {} : { estimated_tokens: left.estimated_tokens })
    }
    : {
      window_tokens: right.window_tokens,
      window: right.window ?? left.window ?? null,
      ...(right.estimated_tokens === undefined ? {} : { estimated_tokens: right.estimated_tokens })
    }
  return {
    elapsed_ms: left.elapsed_ms + right.elapsed_ms,
    requests: left.requests + right.requests,
    input_tokens: addTokens(left.input_tokens, right.input_tokens),
    output_tokens: addTokens(left.output_tokens, right.output_tokens),
    cached_tokens: addCached(left.cached_tokens, right.cached_tokens ?? null),
    ...occupancy
  }
}


function addTokens(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : left + right
}


/** Unreported on one side must not erase a real figure from the other. */
function addCached(left: number | null, right: number | null): number | null {
  if (left === null && right === null) return null
  return (left ?? 0) + (right ?? 0)
}
