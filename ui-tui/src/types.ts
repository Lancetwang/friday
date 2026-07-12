export type GatewayEvent =
  | { type: 'gateway.ready'; payload: { cwd: string } }
  | { type: 'session.info'; payload: SessionInfo }
  | { type: 'message.start'; payload: { text: string } }
  | { type: 'message.delta'; payload: { text: string } }
  | { type: 'message.complete'; payload: { metrics?: MessageMetrics; text: string } }
  | { type: 'tool.start'; payload: { name: string; arguments?: unknown } }
  | { type: 'tool.complete'; payload: { name: string; error?: boolean; content?: string } }
  | { type: 'verification.start'; payload: Record<string, never> }
  | { type: 'verification.complete'; payload: VerificationResult }
  | { type: 'gateway.stderr'; payload: { line: string } }
  | { type: 'gateway.protocol_error'; payload: { preview: string } }

export interface SessionInfo {
  cwd: string
  model: string
  tools: string[]
}

export interface Message {
  metrics?: MessageMetrics
  role: 'assistant' | 'system' | 'tool' | 'user'
  text: string
}

export interface MessageMetrics {
  elapsed_ms?: number
  estimated_tokens?: boolean
  input_tokens?: number | null
  output_tokens?: number | null
}

export interface VerificationResult {
  approval_required?: boolean
  evidence?: unknown[]
  error?: boolean
  feedback?: string
  next_check?: string
  passed?: boolean
  required?: boolean
  stop_reason?: string
  verdict?: 'blocked' | 'inconclusive' | 'pass' | 'repair'
}
