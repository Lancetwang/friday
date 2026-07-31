export type GatewayEvent =
  | { type: 'gateway.ready'; payload: { cwd: string } }
  | { type: 'session.info'; payload: SessionInfo }
  | { type: 'message.start'; payload: { text: string } }
  | { type: 'message.delta'; payload: { text: string } }
  | { type: 'message.complete'; payload: { metrics?: MessageMetrics; progress?: ProgressState; text: string } }
  | { type: 'reasoning.delta'; payload: { id: string; text: string } }
  | { type: 'reasoning.complete'; payload: { error?: boolean; id: string } }
  | { type: 'tool.start'; payload: { tool_call_id: string; name: string; arguments?: unknown } }
  | { type: 'tool.complete'; payload: { tool_call_id: string; name: string; error?: boolean; content?: string } }
  | { type: 'approval.pending'; payload: { command?: string; reason?: string } }
  | { type: 'approval.resolved'; payload: { decision: string; continued?: boolean } }
  | { type: 'verification.start'; payload: Record<string, never> }
  | { type: 'verification.complete'; payload: VerificationResult }
  | { type: 'progress.update'; payload: ProgressState }
  | { type: 'gateway.stderr'; payload: { line: string } }
  | { type: 'gateway.protocol_error'; payload: { preview: string } }

export interface SessionInfo {
  cwd: string
  model: string
  model_configured?: boolean
  model_name?: string
  model_profile?: string
  model_vision?: boolean
  permission_mode: 'accept-edits' | 'bypass' | 'dont-ask' | 'manual'
  thinking_effort: 'high' | 'low' | 'max' | 'off'
  thinking_supported?: boolean
  progress?: ProgressState
  session_id?: string
  tools: string[]
}

export interface ProgressState {
  latest_request?: string
  mode?: 'goal' | 'normal'
  next_action?: string
  objective?: string
  status?: 'blocked' | 'done' | 'waiting' | 'working'
  steps?: Array<{ status: 'blocked' | 'completed' | 'in_progress' | 'pending'; step: string }>
  updated?: string
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
