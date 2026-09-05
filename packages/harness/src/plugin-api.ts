import type { ChatModel, JsonObject, Message, RunContext, Tool } from 'friday-agent-core'

/** Stable, deliberately narrow contract for Friday product plugins. */
export type PluginApi = { workspace: string; sessionId?: string; signal?: AbortSignal }

/** Host-selected execution boundary; plugins cannot replace verifier isolation. */
export type ExecutionBackend = {
  name: string
  execute(request: { workspace: string; command: string; timeoutSeconds: number; readOnly: boolean; signal?: AbortSignal; onProgress?: (content: string) => void; spillPath?: string }): Promise<JsonObject>
}

export type MemoryPreparation = { capture?: JsonObject; recall?: string }

export type MemoryProvider = {
  prepare(request: { sessionId: string; text: string; workspace: string; signal?: AbortSignal }): Promise<MemoryPreparation>
  consolidate?(request: {
    days: number
    review(payload: JsonObject): Promise<unknown>
    signal: AbortSignal
    workspace: string
  }): Promise<Record<string, unknown>>
}

export type PluginCompactionSettings = {
  automatic: boolean
  strategy: 'insert' | 'two-stage'
  threshold_percent: number
}

export type PluginModelConfig = {
  apiKey: string
  baseUrl: string
  contextWindow: number
  maxOutputTokens: number
  model: string
  profileId: string
  profileName: string
  provider: string
  vision?: boolean
}

export type ContextCompaction = {
  after_tokens: number
  before_tokens: number
  fallback: boolean
  kept_turns: number
  kind: 'conversation' | 'tool_results'
  memories: string[]
  notice: string
  ok: boolean
  reason: string
  strategy: 'insert' | 'none' | 'offline' | 'tombstone' | 'transcript'
  tool_results: number
  window: number
}

export type CompactionResult = { record?: ContextCompaction; summary?: string }

export type CompactionRequest = {
  archive(messages: Message[]): void
  config: PluginModelConfig
  context: RunContext
  force?: boolean
  model: ChatModel
  settings: PluginCompactionSettings
  signal?: AbortSignal
  tools: readonly Tool[]
}

export type ContextCompactor = (request: CompactionRequest) => Promise<CompactionResult>

export type FridayPlugin = {
  /** Per-session lifecycle. Return cleanup for reload/close. Activation must be reversible. */
  activate?(api: PluginApi): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>
  name: string
  version?: string
  description?: string
  /** Re-evaluated when the Harness rebuilds its system instructions. */
  instructions?: string | ((api: PluginApi) => string)
  tools?: (api: PluginApi) => Tool[]
  /** Transparent middleware: the returned tool must preserve name and schema. */
  wrapTool?: (api: PluginApi, tool: Tool) => Tool
  /** Singleton service; disable the current provider before selecting another. */
  memory?: MemoryProvider
  /** Singleton service; the Harness retains threshold and safety ownership. */
  compact?: ContextCompactor
}
