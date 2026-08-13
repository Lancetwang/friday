export type JsonObject = Record<string, unknown>

export type Message = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: unknown
  [key: string]: unknown
}

export type ToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type AssistantMessage = Message & {
  role: 'assistant'
  content: string
  reasoning_content?: unknown
  tool_calls?: ToolCall[]
  usage?: JsonObject
}

export type ModelRequest = {
  messages: readonly Message[]
  tools?: readonly ToolSchema[]
  signal?: AbortSignal
  onDelta?: (text: string) => void
  onReasoningDelta?: (text: string) => void
}

export type ChatModel = {
  complete(request: ModelRequest): Promise<AssistantMessage>
}

export type ToolSchema = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: JsonObject
  }
}

export type Tool = {
  name: string
  description: string
  parameters: JsonObject
  parallel?: boolean
  preflight?(call: ToolCall, signal?: AbortSignal): ToolPreflight | Promise<ToolPreflight>
  execute(args: JsonObject, signal?: AbortSignal, onProgress?: (content: string) => void): unknown | Promise<unknown>
}

export type ToolPreflight =
  | { action: 'allow' }
  | { action: 'deny' | 'pause'; result: unknown }

export type AgentEvent = {
  type: string
  category: string
  runId: string
  step?: number
  data: JsonObject
  timestamp: number
}
