import { ModelStreamError, normalizeUsage, type AssistantMessage, type ChatModel, type ModelRequest } from 'friday-agent-core'
import type { RunBudgetSpec } from './budget.js'

export type ResourceLimits = {
  tokens?: number
  requests?: number
  toolCalls?: number
  timeoutMs?: number
  firstByteMs?: number
  idleMs?: number
}
export type ResourceState = { limits: ResourceLimits; deadline: RunBudgetSpec; requests: number; tokens: number; toolCalls: number; estimated: boolean }

/** One ledger belongs to the user run, including auxiliary model requests and retries. */
export class ResourceBudget {
  readonly state: ResourceState
  constructor(limits: ResourceLimits = {}, deadline?: RunBudgetSpec, state?: ResourceState) {
    for (const [name, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid resource limit: ${name}`)
    this.state = state ?? { limits, deadline: deadline ?? { deadlineMs: Date.now() + (limits.timeoutMs ?? 900_000), reserveMs: Math.min(30_000, (limits.timeoutMs ?? 900_000) / 5) }, requests: 0, tokens: 0, toolCalls: 0, estimated: false }
  }
  check(): void {
    if (Date.now() >= this.state.deadline.deadlineMs || this.state.requests >= (this.state.limits.requests ?? 100)
      || this.state.tokens >= (this.state.limits.tokens ?? 40_000_000) || this.state.toolCalls > (this.state.limits.toolCalls ?? 400)) {
      throw new ResourceLimitError('Run resource budget exhausted.')
    }
  }
  tool(): void {
    this.state.toolCalls += 1
    if (this.state.toolCalls > (this.state.limits.toolCalls ?? 400)) throw new ResourceLimitError('Run tool-call limit exceeded.')
  }
  wrap(model: ChatModel): ChatModel {
    return { complete: async request => {
      this.check()
      const estimatedInput = Math.ceil(JSON.stringify([request.messages, request.tools]).length / 3)
      const remaining = (this.state.limits.tokens ?? 40_000_000) - this.state.tokens - estimatedInput
      if (remaining < 1) throw new ResourceLimitError('The remaining token budget cannot cover the next prompt.')
      this.state.requests += 1
      let textChars = 0
      let reasoningChars = 0
      let completed: AssistantMessage | undefined
      try {
        completed = await model.complete({
          ...request,
          maxOutputTokens: Math.min(request.maxOutputTokens ?? Infinity, remaining),
          onDelta: text => { textChars += text.length; request.onDelta?.(text) },
          onReasoningDelta: text => { reasoningChars += text.length; request.onReasoningDelta?.(text) }
        })
        return completed
      } catch (error) {
        if (error instanceof ModelStreamError) completed = error.partial
        throw error
      } finally {
        const counts = normalizeUsage(completed?.usage)
        if (counts.input === undefined || counts.output === undefined) this.state.estimated = true
        // Final messages include non-streamed text and tool arguments. Take the
        // larger text/reasoning count so deltas are not charged a second time.
        const outputChars = Math.max(textChars, completed?.content.length ?? 0)
          + Math.max(reasoningChars, typeof completed?.reasoning_content === 'string' ? completed.reasoning_content.length : 0)
          + (completed?.tool_calls ? JSON.stringify(completed.tool_calls).length : 0)
        this.state.tokens += (counts.input ?? estimatedInput) + (counts.output ?? Math.ceil(outputChars / 3))
      }
    } }
  }
}
export class ResourceLimitError extends Error { constructor(message: string) { super(message); this.name = 'ResourceLimitError' } }

/** Independent first-byte and stream-idle timers, even when no visible text is emitted. */
export function withModelTimeouts(model: ChatModel, limits: ResourceLimits = {}): ChatModel {
  return { complete: async (request: ModelRequest) => {
    const controller = new AbortController()
    const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal
    signal.throwIfAborted()
    let rejectAbort: (error: unknown) => void
    const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
    const abort = () => rejectAbort(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    let timer: NodeJS.Timeout
    let finished = false
    const arm = (ms: number, phase: string) => {
      clearTimeout(timer)
      timer = setTimeout(() => controller.abort(new DOMException(`Model ${phase} timeout.`, 'TimeoutError')), ms)
    }
    arm(limits.firstByteMs ?? 60_000, 'first-byte')
    const activity = () => { if (!finished && !signal.aborted) { arm(limits.idleMs ?? 45_000, 'idle'); request.onActivity?.() } }
    try {
      return await Promise.race([cancelled, model.complete({ ...request, signal, onActivity: activity,
        onDelta: text => { if (!finished && !signal.aborted) { activity(); request.onDelta?.(text) } }, onReasoningDelta: text => { if (!finished && !signal.aborted) { activity(); request.onReasoningDelta?.(text) } } })])
    } catch (error) { signal.throwIfAborted(); throw error }
    finally { finished = true; clearTimeout(timer!); signal.removeEventListener('abort', abort) }
  } }
}
