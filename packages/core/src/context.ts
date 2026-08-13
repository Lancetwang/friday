import { randomUUID } from 'node:crypto'

import type { AgentEvent, JsonObject, Message } from './types.js'

export type Usage = {
  requests: number
  inputTokens: number | null
  outputTokens: number | null
}

export class RunContext {
  readonly runId = randomUUID().replaceAll('-', '')
  readonly messages: Message[] = []
  readonly events: AgentEvent[] = []
  readonly metadata: JsonObject = {}
  readonly artifacts: JsonObject = {}
  readonly usage: Usage = { requests: 0, inputTokens: 0, outputTokens: 0 }
  onEvent?: (event: AgentEvent) => void
  onObservation?: (event: AgentEvent) => void
  step?: number

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
      outputTokens: subtract(this.usage.outputTokens, before.outputTokens)
    }
  }

  private event(type: string, category: string, data: JsonObject): AgentEvent {
    return {
      type,
      category,
      runId: this.runId,
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
