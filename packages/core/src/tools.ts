import { AsyncLocalStorage } from 'node:async_hooks'

import type { JsonObject, Tool, ToolCall, ToolSchema } from './types.js'

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
    return Array.isArray(message.tool_calls) ? message.tool_calls.filter(validCall) : []
  }

  async preflightAll(calls: readonly ToolCall[], signal?: AbortSignal): Promise<ToolBatchPreflight | undefined> {
    for (const call of calls) {
      const decision = await this.tools.get(call.function.name)?.preflight?.(call, signal)
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
    onProgress?: (call: ToolCall, content: string) => void
  ): Promise<ToolResult[]> {
    const results: ToolResult[] = []
    let parallel: ToolCall[] = []
    const flush = async () => {
      if (!parallel.length) return
      for (let index = 0; index < parallel.length; index += this.maxParallel) {
        results.push(...await Promise.all(parallel.slice(index, index + this.maxParallel)
          .map(call => this.execute(call, signal, onProgress))))
      }
      parallel = []
    }
    for (const call of calls) {
      if (this.tools.get(call.function.name)?.parallel) parallel.push(call)
      else {
        await flush()
        results.push(await this.execute(call, signal, onProgress))
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
      const args = parseArguments(call.function.arguments)
      const value = await currentCall.run(call, () => tool.execute(args, signal, content => onProgress?.(call, content)))
      return { toolCallId: call.id, content: stringify(value), isError: false, elapsedMs: performance.now() - started }
    } catch (error) {
      return failure(call.id, `Tool '${tool.name}' failed: ${errorText(error)}`, started)
    }
  }
}

function validCall(value: unknown): value is ToolCall {
  if (!value || typeof value !== 'object') return false
  const call = value as Partial<ToolCall>
  return typeof call.id === 'string' && !!call.function && typeof call.function.name === 'string'
}

function parseArguments(value: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(value || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : {}
  } catch {
    return {}
  }
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
