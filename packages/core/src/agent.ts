import { createHash } from 'node:crypto'

import { RunContext } from './context.js'
import { ModelStreamError } from './errors.js'
import { ToolExecutor, toolSchema } from './tools.js'
import type { AssistantMessage, ChatModel, JsonObject, ModelTermination, Tool, ToolCall } from './types.js'

export type AgentOptions = {
  model: ChatModel
  instructions?: string
  tools?: readonly Tool[]
  maxSteps?: number
  maxEmptyRetries?: number
  /** Awaited at execution boundaries. Hosts may durably record progress here. */
  checkpoint?(context: RunContext, boundary: 'model' | 'tool'): void | Promise<void>
  beforeStep?(
    context: RunContext,
    step: number,
    signal?: AbortSignal
  ): void | { tools?: boolean } | Promise<void | { tools?: boolean }>
}

export type AgentRunOptions = {
  /** Cancels the complete turn, including model calls. */
  signal?: AbortSignal
  /** Optionally stops new/active tool work while leaving time for a final model response. */
  toolSignal?: AbortSignal
  onDelta?: (text: string) => void
}

export type AgentRunResult = { status: 'done' | 'paused' | 'incomplete'; text: string; termination?: ModelTermination }

export class Agent {
  readonly context: RunContext
  private readonly executor: ToolExecutor
  private readonly tools: readonly Tool[]
  private readonly recentRounds: Array<Map<string, { result: string; count: number }>> = []
  private warned = new Map<string, string>()

  constructor(private readonly options: AgentOptions, context = new RunContext()) {
    this.context = context
    this.tools = options.tools ?? []
    this.executor = new ToolExecutor(this.tools)
    if (options.instructions && !context.messages.some(message => message.role === 'system')) {
      context.addMessage({ role: 'system', content: options.instructions })
    }
  }

  async run(text: string, options: AgentRunOptions = {}): Promise<AgentRunResult> {
    this.resetLoopGuard()
    this.context.addMessage({ role: 'user', content: text })
    return this.loop(options)
  }

  async resume(options: AgentRunOptions = {}): Promise<AgentRunResult> {
    return this.loop(options)
  }

  async chat(text: string, options: AgentRunOptions = {}): Promise<string> {
    return (await this.run(text, options)).text
  }

  resetLoopGuard(): void {
    this.recentRounds.length = 0
    this.warned.clear()
  }

  private async loop(options: AgentRunOptions): Promise<AgentRunResult> {
    const maxSteps = this.options.maxSteps ?? 100
    const maxEmptyRetries = this.options.maxEmptyRetries ?? 2
    let toolsEnabled = true
    let emptyRetries = 0
    for (let step = 1; step <= maxSteps; step += 1) {
      options.signal?.throwIfAborted()
      this.context.step = step
      const control = toolsEnabled
        ? await this.options.beforeStep?.(this.context, step, options.signal)
        : undefined
      if (control?.tools === false) toolsEnabled = false
      options.signal?.throwIfAborted()
      const message = await this.complete(options, toolsEnabled)
      const incomplete = ['length', 'incomplete', 'content_filter'].includes(message.termination?.reason ?? '')
      const incompleteCalls = incomplete && !!message.tool_calls?.length
      if (incomplete && message.tool_calls?.length) {
        message.incomplete_tool_calls = message.tool_calls
        delete message.tool_calls
      }
      if (!toolsEnabled) delete message.tool_calls
      const calls = this.executor.parse(message)
      this.context.addMessage(message)
      await this.options.checkpoint?.(this.context, 'model')
      if (incomplete && (message.content.trim() || incompleteCalls)) {
        return { status: 'incomplete', text: message.content, ...(message.termination ? { termination: message.termination } : {}) }
      }
      if (!calls.length || !toolsEnabled) {
        if (message.content.trim()) {
          return {
            status: 'done',
            text: message.content,
            ...(message.termination ? { termination: message.termination } : {})
          }
        }
        emptyRetries += 1
        this.context.emit('loop.warning', 'runtime', {
          reason: 'empty_model_response',
          attempt: emptyRetries,
          termination: message.termination ?? {}
        })
        if (emptyRetries > maxEmptyRetries) {
          throw new Error(`Model returned an empty response ${emptyRetries} times without an executable tool call.`)
        }
        this.context.addMessage({
          role: 'system',
          content: emptyRecovery(message.termination, toolsEnabled),
          agent_internal: true
        })
        continue
      }
      emptyRetries = 0

      this.emitCalls(calls)
      const toolSignal = options.toolSignal ?? options.signal
      const preflight = await this.executor.preflightAll(calls, toolSignal)
      if (preflight) {
        this.appendResults(preflight.results)
        await this.options.checkpoint?.(this.context, 'tool')
        if (preflight.paused) {
          this.context.emit('agent.paused', 'runtime', {})
          return { status: 'paused', text: '' }
        }
        if (this.applyNoProgress(calls, preflight.results) === 'halt') toolsEnabled = false
        continue
      }
      let recording = Promise.resolve()
      const results = await this.executor.executeAll(calls, toolSignal, (call, content) => {
        this.context.emit('tool.progress', 'tool', {
          tool_call_id: call.id,
          name: call.function.name,
          content
        })
      }, result => {
        recording = recording.then(async () => {
          this.appendResults([result])
          await this.options.checkpoint?.(this.context, 'tool')
        })
        return recording
      })
      if (this.applyNoProgress(calls, results) === 'halt') toolsEnabled = false
    }
    throw new Error(`Agent exceeded maxSteps=${maxSteps}.`)
  }

  private applyNoProgress(calls: readonly ToolCall[], results: readonly ToolResult[]): Guard['action'] {
    const guard = noProgress(calls, results, this.recentRounds, this.warned)
    this.warned = guard.warned
    if (guard.action === 'warn') {
      this.context.emit('loop.warning', 'runtime', { reason: guard.reason })
      this.context.addMessage({ role: 'system', content: guard.reason, agent_internal: true })
    } else if (guard.action === 'halt') {
      this.context.emit('loop.guard', 'runtime', { reason: 'no_progress' })
      this.context.addMessage({
        role: 'system',
        content: 'Loop guard: exact tool calls kept returning the same result after a warning. Do not call more tools. Return the best supported answer, state unresolved items, and stop.',
        agent_internal: true
      })
    }
    return guard.action
  }

  private emitCalls(calls: ReturnType<ToolExecutor['parse']>): void {
    for (const call of calls) {
      this.context.emit('tool.call', 'tool', {
        tool_call_id: call.id,
        name: call.function.name,
        arguments: parseArguments(call.function.arguments)
      })
    }
  }

  private appendResults(results: Awaited<ReturnType<ToolExecutor['executeAll']>>): void {
    for (const result of results) {
      this.context.emit('tool.result', 'tool', {
        tool_call_id: result.toolCallId,
        content: result.content,
        is_error: result.isError,
        elapsed_ms: result.elapsedMs
      })
      this.context.addMessage({ role: 'tool', tool_call_id: result.toolCallId, content: result.content, is_error: result.isError })
    }
  }

  private async complete(
    options: AgentRunOptions,
    toolsEnabled: boolean
  ): Promise<AssistantMessage> {
    const schemas = toolsEnabled ? this.tools.map(toolSchema) : []
    this.context.observe('model.request.payload', 'model', { messages: this.context.messages, tools: schemas })
    this.context.emit('model.request', 'model', {
      message_count: this.context.messages.length,
      tool_names: toolsEnabled ? this.tools.map(tool => tool.name) : []
    })
    let message: AssistantMessage
    try {
    message = await this.options.model.complete({
      messages: this.context.messages,
      ...(schemas.length ? { tools: schemas } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      onDelta: text => {
        this.context.emit('model.delta', 'model', { content: text })
        options.onDelta?.(text)
      },
      onReasoningDelta: text => this.context.emit('model.reasoning.delta', 'model', { content: text })
    })
    } catch (error) {
      if (error instanceof ModelStreamError) {
        this.context.recordUsage(error.partial.usage)
        this.context.addMessage(error.partial)
        await this.options.checkpoint?.(this.context, 'model')
      }
      options.signal?.throwIfAborted()
      throw error
    }
    this.context.recordUsage(message.usage)
    this.context.observe('model.response.payload', 'model', { message })
    this.context.emit('model.response', 'model', {
      has_tool_calls: !!message.tool_calls?.length,
      has_reasoning: !!message.reasoning_content,
      content_length: message.content.length,
      termination: message.termination ?? {},
      usage: message.usage ?? {}
    })
    return message
  }
}

function emptyRecovery(value: ModelTermination | undefined, toolsEnabled: boolean): string {
  const reason = value?.reason === 'length'
    ? 'The previous response exhausted its output budget during reasoning.'
    : 'The previous response contained neither a visible answer nor an executable tool call.'
  return `${reason} Continue now with a concise user-visible answer${toolsEnabled ? ' or one concrete tool action' : ''}; do not return another empty response.`
}

type ToolResult = Awaited<ReturnType<ToolExecutor['executeAll']>>[number]
type Guard = { action: 'continue' | 'warn' | 'halt'; reason: string; warned: Map<string, string> }

function noProgress(
  calls: readonly ToolCall[],
  results: readonly ToolResult[],
  rounds: Array<Map<string, { result: string; count: number }>>,
  warned: Map<string, string>
): Guard {
  const byId = new Map(results.map(result => [result.toolCallId, result]))
  const current = new Map<string, { result: string; count: number }>()
  for (const call of calls) {
    const result = byId.get(call.id)
    if (!result) continue
    const signature = digest(stable({ name: call.function.name, arguments: parseArguments(call.function.arguments) }))
    const outcome = digest(`${result.isError ? 1 : 0}\0${result.content}`)
    const prior = current.get(signature)
    current.set(signature, {
      result: prior?.result === outcome || !prior ? outcome : '',
      count: (prior?.count ?? 0) + 1
    })
  }
  if (!current.size) return { action: 'continue', reason: '', warned: new Map() }
  rounds.push(current)
  rounds.splice(0, Math.max(0, rounds.length - 3))
  const repeatedAfterWarning = [...current].filter(([signature, item]) => item.result && warned.get(signature) === item.result)
  if (repeatedAfterWarning.length) {
    return { action: 'halt', reason: 'exact tool calls repeated after a no-progress warning', warned }
  }
  const stalled = new Map([...current].filter(([, item]) => item.count >= 3))
  if (rounds.length === 3) {
    for (const [signature, item] of current) {
      const matches = rounds.map(round => round.get(signature))
      if (matches.every(match => match?.result && match.result === item.result)) stalled.set(signature, item)
    }
  }
  if (!stalled.size) return { action: 'continue', reason: '', warned: new Map() }
  return {
    action: 'warn',
    reason: 'Exact tool calls repeated without a changed result. Do not repeat them; change approach or report the concrete blocker.',
    warned: new Map([...stalled].map(([signature, item]) => [signature, item.result]))
  }
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  return `{${Object.entries(value as JsonObject).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function parseArguments(value: string): JsonObject {
  try {
    const result: unknown = JSON.parse(value || '{}')
    return result && typeof result === 'object' && !Array.isArray(result) ? result as JsonObject : {}
  } catch {
    return {}
  }
}
