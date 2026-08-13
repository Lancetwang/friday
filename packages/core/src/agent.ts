import { createHash } from 'node:crypto'

import { RunContext } from './context.js'
import { ToolExecutor, toolSchema } from './tools.js'
import type { AssistantMessage, ChatModel, JsonObject, Tool, ToolCall } from './types.js'

export type AgentOptions = {
  model: ChatModel
  instructions?: string
  tools?: readonly Tool[]
  maxSteps?: number
  beforeStep?(
    context: RunContext,
    step: number,
    signal?: AbortSignal
  ): void | { tools?: boolean } | Promise<void | { tools?: boolean }>
}

export type AgentRunResult = { status: 'done' | 'paused'; text: string }

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

  async run(text: string, options: { signal?: AbortSignal; onDelta?: (text: string) => void } = {}): Promise<AgentRunResult> {
    this.resetLoopGuard()
    this.context.addMessage({ role: 'user', content: text })
    return this.loop(options)
  }

  async resume(options: { signal?: AbortSignal; onDelta?: (text: string) => void } = {}): Promise<AgentRunResult> {
    return this.loop(options)
  }

  async chat(text: string, options: { signal?: AbortSignal; onDelta?: (text: string) => void } = {}): Promise<string> {
    return (await this.run(text, options)).text
  }

  resetLoopGuard(): void {
    this.recentRounds.length = 0
    this.warned.clear()
  }

  private async loop(options: { signal?: AbortSignal; onDelta?: (text: string) => void }): Promise<AgentRunResult> {
    const maxSteps = this.options.maxSteps ?? 100
    let toolsEnabled = true
    for (let step = 1; step <= maxSteps; step += 1) {
      options.signal?.throwIfAborted()
      this.context.step = step
      const control = toolsEnabled
        ? await this.options.beforeStep?.(this.context, step, options.signal)
        : undefined
      if (control?.tools === false) toolsEnabled = false
      options.signal?.throwIfAborted()
      const message = await this.complete(options, toolsEnabled)
      if (!toolsEnabled) delete message.tool_calls
      this.context.addMessage(message)
      const calls = this.executor.parse(message)
      if (!calls.length || !toolsEnabled) return { status: 'done', text: message.content }

      this.emitCalls(calls)
      const preflight = await this.executor.preflightAll(calls, options.signal)
      if (preflight) {
        this.appendResults(preflight.results)
        if (preflight.paused) {
          this.context.emit('agent.paused', 'runtime', {})
          return { status: 'paused', text: '' }
        }
        if (this.applyNoProgress(calls, preflight.results) === 'halt') toolsEnabled = false
        continue
      }
      const results = await this.executor.executeAll(calls, options.signal, (call, content) => {
        this.context.emit('tool.progress', 'tool', {
          tool_call_id: call.id,
          name: call.function.name,
          content
        })
      })
      this.appendResults(results)
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
      this.context.addMessage({ role: 'tool', tool_call_id: result.toolCallId, content: result.content })
    }
  }

  private async complete(
    options: { signal?: AbortSignal; onDelta?: (text: string) => void },
    toolsEnabled: boolean
  ): Promise<AssistantMessage> {
    const schemas = toolsEnabled ? this.tools.map(toolSchema) : []
    this.context.observe('model.request.payload', 'model', { messages: this.context.messages, tools: schemas })
    this.context.emit('model.request', 'model', {
      message_count: this.context.messages.length,
      tool_names: toolsEnabled ? this.tools.map(tool => tool.name) : []
    })
    const message = await this.options.model.complete({
      messages: this.context.messages,
      ...(schemas.length ? { tools: schemas } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      onDelta: text => {
        this.context.emit('model.delta', 'model', { content: text })
        options.onDelta?.(text)
      },
      onReasoningDelta: text => this.context.emit('model.reasoning.delta', 'model', { content: text })
    })
    this.context.recordUsage(message.usage)
    this.context.observe('model.response.payload', 'model', { message })
    this.context.emit('model.response', 'model', {
      has_tool_calls: !!message.tool_calls?.length,
      has_reasoning: !!message.reasoning_content,
      content_length: message.content.length,
      usage: message.usage ?? {}
    })
    return message
  }
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
