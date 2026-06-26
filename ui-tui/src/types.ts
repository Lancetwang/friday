export type GatewayEvent =
  | { type: 'gateway.ready'; payload: { cwd: string } }
  | { type: 'session.info'; payload: SessionInfo }
  | { type: 'message.start'; payload: { text: string } }
  | { type: 'message.delta'; payload: { text: string } }
  | { type: 'message.complete'; payload: { text: string } }
  | { type: 'tool.start'; payload: { name: string; arguments?: unknown } }
  | { type: 'tool.complete'; payload: { name: string; error?: boolean; content?: string } }
  | { type: 'gateway.stderr'; payload: { line: string } }
  | { type: 'gateway.protocol_error'; payload: { preview: string } }

export interface SessionInfo {
  cwd: string
  model: string
  tools: string[]
}

export interface Message {
  role: 'assistant' | 'system' | 'tool' | 'user'
  text: string
}
