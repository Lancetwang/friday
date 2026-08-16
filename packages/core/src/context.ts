import { randomUUID } from 'node:crypto'

import type { AgentEvent, JsonObject, Message } from './types.js'

export type Usage = {
  requests: number
  inputTokens: number | null
  outputTokens: number | null
  /**
   * Prompt tokens the provider served from its cache. Null means no request in
   * the span reported a cache figure, which is different from a reported zero:
   * zero is "nothing was cached", null is "the provider does not say".
   */
  cachedTokens: number | null
}

export class RunContext {
  readonly runId = randomUUID().replaceAll('-', '')
  readonly messages: Message[] = []
  readonly events: AgentEvent[] = []
  readonly metadata: JsonObject = {}
  readonly artifacts: JsonObject = {}
  readonly usage: Usage = { requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: null }
  onEvent?: (event: AgentEvent) => void
  onObservation?: (event: AgentEvent) => void
  step?: number
  private sequence = 0

  addMessage(message: Message): Message {
    this.messages.push(message)
    this.emit('message.add', 'message', { role: message.role })
    return message
  }

  emit(type: string, category = 'runtime', data: JsonObject = {}): AgentEvent {
    const event = this.event(type, category, data)
    this.events.push(event)
    this.onObservation?.(event)
    this.onEvent?.(event)
    return event
  }

  observe(type: string, category = 'runtime', data: JsonObject = {}): void {
    this.onObservation?.(this.event(type, category, data))
  }

  recordUsage(value: unknown): void {
    this.usage.requests += 1
    if (!isObject(value)) {
      this.usage.inputTokens = null
      this.usage.outputTokens = null
      return
    }
    // Cache accumulates independently of the input/output null poisoning: a
    // provider that reports a cache figure has told us something true about
    // this request even when a sibling request reported no token counts.
    const cached = cachedTokensOf(value)
    if (cached !== undefined) this.usage.cachedTokens = (this.usage.cachedTokens ?? 0) + cached
    const input = integer(value.input_tokens) ?? integer(value.prompt_tokens)
    const output = integer(value.output_tokens) ?? integer(value.completion_tokens)
    if (input === undefined || output === undefined || this.usage.inputTokens === null || this.usage.outputTokens === null) {
      this.usage.inputTokens = null
      this.usage.outputTokens = null
      return
    }
    this.usage.inputTokens += input
    this.usage.outputTokens += output
  }

  snapshotUsage(): Usage {
    return { ...this.usage }
  }

  usageSince(before: Usage): Usage {
    return {
      requests: this.usage.requests - before.requests,
      inputTokens: subtract(this.usage.inputTokens, before.inputTokens),
      outputTokens: subtract(this.usage.outputTokens, before.outputTokens),
      cachedTokens: subtractCached(this.usage.cachedTokens, before.cachedTokens)
    }
  }

  private event(type: string, category: string, data: JsonObject): AgentEvent {
    return {
      type,
      category,
      runId: this.runId,
      seq: ++this.sequence,
      ...(this.step === undefined ? {} : { step: this.step }),
      data,
      timestamp: Date.now()
    }
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function integer(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined
}

function subtract(current: number | null, previous: number | null): number | null {
  return current === null || previous === null ? null : current - previous
}

/** A span that only ever saw unreported cache stays unreported, not zero. */
function subtractCached(current: number | null, previous: number | null): number | null {
  if (current === null) return null
  return current - (previous ?? 0)
}

/**
 * Every provider spells cached prompt tokens differently, so read all the known
 * shapes rather than one. Anthropic splits the figure into a read and a write
 * half and both are prompt tokens the request did not pay full price for.
 */
function cachedTokensOf(usage: JsonObject): number | undefined {
  const read = integer(usage.cache_read_input_tokens)
  const written = integer(usage.cache_creation_input_tokens)
  if (read !== undefined || written !== undefined) return (read ?? 0) + (written ?? 0)
  const details = isObject(usage.prompt_tokens_details) ? usage.prompt_tokens_details
    : isObject(usage.input_tokens_details) ? usage.input_tokens_details
      : undefined
  return integer(details?.cached_tokens)
    ?? integer(usage.cached_tokens)
    ?? integer(usage.prompt_cache_hit_tokens)
}
