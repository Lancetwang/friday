import { AsyncLocalStorage } from 'node:async_hooks'

import type { JsonObject, Tool, ToolCall, ToolPreflight, ToolSchema } from './types.js'
import { validateArguments } from './schema.js'

export type ToolResult = {
  toolCallId: string
  content: string
  isError: boolean
  elapsedMs: number
}

export type ToolBatchPreflight = {
  paused: boolean
  results: ToolResult[]
}

const currentCall = new AsyncLocalStorage<ToolCall>()

export function getCurrentToolCall(): ToolCall | undefined {
  return currentCall.getStore()
}

export function toolSchema(tool: Tool): ToolSchema {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters }
  }
}

export class ToolExecutor {
  private readonly tools: Map<string, Tool>

  constructor(tools: readonly Tool[] = [], private readonly maxParallel = 4) {
    if (!Number.isSafeInteger(maxParallel) || maxParallel < 1) throw new Error('maxParallel must be a positive integer.')
    this.tools = new Map()
    for (const tool of tools) {
      if (this.tools.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`)
      this.tools.set(tool.name, tool)
    }
  }

  parse(message: { tool_calls?: ToolCall[] }): ToolCall[] {
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls.filter(validCall) : []
    if (message.tool_calls) message.tool_calls = calls
    // Providers occasionally omit or repeat call ids; downstream everything
    // pairs results to calls by id, and the next request echoes them back.
    // Synthesize unique ids in place so the stored assistant message and the
    // tool results it pairs with stay consistent.
    const seen = new Set<string>()
    for (const [index, call] of calls.entries()) {
      if (!call.id || seen.has(call.id)) call.id = uniqueCallId(call.id, index, seen)
      seen.add(call.id)
    }
    return calls
  }

  async preflightAll(calls: readonly ToolCall[], signal?: AbortSignal): Promise<ToolBatchPreflight | undefined> {
    for (const call of calls) {
      if (signal?.aborted) return cancelledPreflight(calls, signal.reason)
      let decision: ToolPreflight | undefined
      try {
        this.arguments(call)
      } catch (error) {
        return { paused: false, results: calls.map(current => failure(current.id,
          current.id === call.id ? `Invalid tool arguments: ${errorText(error)}` : 'Tool batch skipped because another call has invalid arguments.', performance.now())) }
      }
      try {
        decision = await this.tools.get(call.function.name)?.preflight?.(call, signal)
      } catch (error) {
        if (signal?.aborted) return cancelledPreflight(calls, signal.reason ?? error)
        throw error
      }
      if (signal?.aborted) return cancelledPreflight(calls, signal.reason)
      if (!decision || decision.action === 'allow') continue
      return {
        paused: decision.action === 'pause',
        results: calls.map(current => ({
          toolCallId: current.id,
          content: stringify(current.id === call.id
            ? decision.result
            : { cancelled: true, message: `Tool batch was not executed because another call was ${decision.action === 'pause' ? 'paused' : 'denied'}.` }),
          isError: decision.action === 'deny',
          elapsedMs: 0
        }))
      }
    }
    return undefined
  }

  async executeAll(
    calls: readonly ToolCall[],
    signal?: AbortSignal,
    onProgress?: (call: ToolCall, content: string) => void,
    onResult?: (result: ToolResult) => void | Promise<void>
  ): Promise<ToolResult[]> {
    const results: ToolResult[] = []
    const execute = async (call: ToolCall) => {
      const result = await this.execute(call, signal, onProgress)
      await onResult?.(result)
      return result
    }
    let parallel: ToolCall[] = []
    const flush = async () => {
      if (!parallel.length) return
      for (let index = 0; index < parallel.length; index += this.maxParallel) {
        results.push(...await Promise.all(parallel.slice(index, index + this.maxParallel)
          .map(execute)))
      }
      parallel = []
    }
    for (const call of calls) {
      if (this.tools.get(call.function.name)?.parallel) parallel.push(call)
      else {
        await flush()
        results.push(await execute(call))
      }
    }
    await flush()
    return results
  }

  async execute(
    call: ToolCall,
    signal?: AbortSignal,
    onProgress?: (call: ToolCall, content: string) => void
  ): Promise<ToolResult> {
    const started = performance.now()
    const tool = this.tools.get(call.function.name)
    if (!tool) return failure(call.id, `Tool '${call.function.name}' not found.`, started)
    try {
      signal?.throwIfAborted()
      const args = this.arguments(call)
      // The race is what keeps cancellation honest: a tool that ignores its
      // signal (or a child process the kernel will not release) must not hold
      // the whole turn hostage. On abort the tool's own promise is orphaned
      // and settles in the background.
      const work = Promise.resolve(currentCall.run(call, () => tool.execute(args, signal, content => onProgress?.(call, content))))
      const value = await raceAbort(work, signal)
      const envelope = value && typeof value === 'object' ? value as JsonObject : undefined
      return { toolCallId: call.id, content: stringify(value), isError: envelope?.isError === true || envelope?.is_error === true, elapsedMs: performance.now() - started }
    } catch (error) {
      return failure(call.id, `Tool '${tool.name}' failed: ${errorText(error)}`, started)
    }
  }

  private arguments(call: ToolCall): JsonObject {
    const tool = this.tools.get(call.function.name)
    if (!tool) throw new Error(`Unknown tool: ${call.function.name}`)
    const args = parseArguments(call.function.arguments)
    if (tool.validate) tool.validate(args)
    else validateArguments(args, tool.parameters)
    return args
  }
}

function cancelledPreflight(calls: readonly ToolCall[], reason: unknown): ToolBatchPreflight {
  const message = errorText(reason instanceof Error ? reason : new Error('Tool work was cancelled.'))
  return {
    paused: false,
    results: calls.map(call => ({
      toolCallId: call.id,
      content: stringify({ cancelled: true, message }),
      isError: true,
      elapsedMs: 0
    }))
  }
}

function raceAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      work.catch(() => {})
      const reason = signal.reason
      const error = reason instanceof Error ? reason : new Error('Tool execution was cancelled.')
      if (!(reason instanceof Error)) error.name = 'AbortError'
      reject(error)
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

function uniqueCallId(base: string, index: number, seen: ReadonlySet<string>): string {
  let candidate = base ? `${base}_${index}` : `call_${index}`
  while (seen.has(candidate)) candidate = `${candidate}x`
  return candidate
}

function validCall(value: unknown): value is ToolCall {
  if (!value || typeof value !== 'object') return false
  const call = value as Partial<ToolCall>
  return typeof call.id === 'string' && !!call.function && typeof call.function.name === 'string'
}

function parseArguments(value: string): JsonObject {
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Tool arguments must be a JSON object.')
  return parsed as JsonObject
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  const json = JSON.stringify(value)
  return json === undefined ? String(value) : json
}

function failure(id: string, content: string, started: number): ToolResult {
  return { toolCallId: id, content, isError: true, elapsedMs: performance.now() - started }
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
