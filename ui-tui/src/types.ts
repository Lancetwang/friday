type SessionScoped = { session_id?: string }

export type GatewayEvent =
  | { type: 'gateway.ready'; payload: { cwd: string } }
  | { type: 'session.info'; payload: SessionInfo }
  | { type: 'message.start'; payload: { text: string } & SessionScoped }
  | { type: 'message.delta'; payload: { text: string } & SessionScoped }
  | { type: 'message.complete'; payload: { metrics?: MessageMetrics; progress?: ProgressState; status?: string; text: string } & SessionScoped }
  | { type: 'message.suspended'; payload: { metrics?: MessageMetrics; progress?: ProgressState; status?: string; text: string } & SessionScoped }
  | { type: 'message.cancelled'; payload: SessionScoped }
  | { type: 'session.updated'; payload: { running?: boolean } & SessionScoped }
  | { type: 'session.titled'; payload: { title?: string } & SessionScoped }
  | { type: 'reasoning.delta'; payload: { id: string; text: string } & SessionScoped }
  | { type: 'reasoning.complete'; payload: { elapsed_ms?: number; error?: boolean; id: string } & SessionScoped }
  | { type: 'tool.start'; payload: { tool_call_id: string; name: string; arguments?: unknown } & SessionScoped }
  | { type: 'tool.update'; payload: { tool_call_id: string; name: string; content?: string } & SessionScoped }
  | { type: 'tool.complete'; payload: { tool_call_id: string; name: string; error?: boolean; content?: string; elapsed_ms?: number } & SessionScoped }
  | { type: 'approval.pending'; payload: { command?: string; reason?: string } & SessionScoped }
  | { type: 'approval.resolved'; payload: { decision: string; continued?: boolean } & SessionScoped }
  | { type: 'verification.start'; payload: SessionScoped }
  | { type: 'verification.complete'; payload: VerificationResult & SessionScoped }
  | { type: 'progress.update'; payload: ProgressState & SessionScoped }
  | { type: 'context.compacted'; payload: ContextCompaction & SessionScoped }
  | { type: 'gateway.stderr'; payload: { line: string } }
  | { type: 'gateway.protocol_error'; payload: { preview: string } }

/** Friday rewrote the conversation to keep it inside the model's context window. */
export interface ContextCompaction {
  after_tokens?: number
  before_tokens?: number
  fallback?: boolean
  kept_turns?: number
  kind?: 'conversation' | 'tool_results'
  memories?: string[]
  notice?: string
  ok?: boolean
  reason?: string
  strategy?: string
  tool_results?: number
  window?: number
}

export interface SessionInfo {
  approval?: {
    command?: string
    id?: string
    message?: string
    pending?: boolean
    reason?: string
    timeout_seconds?: number
  }
  cwd: string
  model: string
  model_configured?: boolean
  model_name?: string
  model_profile?: string
  model_vision?: boolean
  permission_mode: 'auto' | 'bypass' | 'manual'
  thinking_effort: string
  thinking_options?: string[]
  thinking_supported?: boolean
  progress?: ProgressState
  running?: boolean
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
  cached_tokens?: number | null
  elapsed_ms?: number
  estimated_tokens?: boolean
  /** Cumulative over the turn's requests: what it cost, not how full the window is. */
  input_tokens?: number | null
  output_tokens?: number | null
  /** Model calls the turn made. The token totals are sums over these. */
  requests?: number | null
  window?: number | null
  /** How full the context is once the turn ends. */
  window_tokens?: number | null
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
