/** Shared wire types. This package has no runtime and no dependency on Core or Harness. */

export type PermissionMode = 'auto' | 'bypass' | 'manual'

export type MessageMetrics = {
  cached_tokens?: number | null
  elapsed_ms?: number
  estimated_tokens?: boolean
  input_tokens?: number | null
  output_tokens?: number | null
  requests?: number | null
  window?: number | null
  window_tokens?: number | null
}

export type ProgressStep = {
  status: 'blocked' | 'completed' | 'in_progress' | 'pending'
  step: string
}

export type ProgressState = {
  latest_request?: string
  mode?: 'goal' | 'normal'
  next_action?: string
  objective?: string
  status?: 'blocked' | 'done' | 'waiting' | 'working'
  steps?: ProgressStep[]
  updated?: string
}

export type ApprovalInfo = {
  approval_required?: boolean
  command?: string
  id?: string
  message?: string
  pending?: boolean
  reason?: string
  timeout_seconds?: number
}

export type VerificationResult = {
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

export type ContextCompaction = {
  after_tokens?: number
  before_tokens?: number
  fallback?: boolean
  kept_turns?: number
  kind?: 'conversation' | 'tool_results'
  memories?: string[]
  notice?: string
  ok?: boolean
  reason?: string
  strategy?: 'insert' | 'none' | 'offline' | 'tombstone' | 'transcript'
  tool_results?: number
  window?: number
}

export type PluginInfo = {
  capabilities: string[]
  description: string
  disabled: boolean
  errors: string[]
  name: string
  required: boolean
  scope: 'builtin' | 'project' | 'user'
  source: string
  tools: string[]
  version: string
}

export type SessionInfo = {
  approval?: ApprovalInfo
  compaction?: { automatic: boolean; provider: string; strategy: CompactionSettings['strategy']; threshold_percent: number }
  cwd: string
  memory?: { provider: string }
  model: string
  model_configured?: boolean
  model_name?: string
  model_profile?: string
  /** Positive capability hint; absence means unknown, not unsupported. */
  model_vision?: boolean
  permission_mode: PermissionMode
  plugins?: PluginInfo[]
  progress?: ProgressState
  running?: boolean
  session_id?: string
  thinking_effort: string
  thinking_options?: string[]
  thinking_supported?: boolean
  tools: string[]
}

export type DiscoveredModel = { id: string; vision?: boolean }

export type ModelProfile = {
  api_key_configured: boolean
  auto?: boolean
  base_url: string
  context_window: number
  enabled: boolean
  id: string
  max_output_tokens: number
  model: string
  name: string
  provider: string
  run_token_budget: number
  thinking_options?: string[]
  vision?: boolean
}

export type ModelProvider = {
  api_key_configured: boolean
  base_url: string
  builtin: boolean
  enabled: boolean
  id: string
  label: string
  models: DiscoveredModel[]
}

export type ModelCatalog = {
  active: string
  disabled: string[]
  profiles: ModelProfile[]
  providers: ModelProvider[]
}

export type WebSearchSettings = {
  anysearch_configured: boolean
  tavily_configured: boolean
}

export type CompactionSettings = {
  automatic: boolean
  strategy: 'insert' | 'two-stage'
  threshold_percent: number
}

export type UserProfileSettings = {
  habits: string
  preferred_language: string
  preferred_name: string
}

export type MemoryFileScope = 'global' | 'user'
export type MemoryFileInfo = { chars: number; limit: number; path: string }
export type MemoryFileDetail = MemoryFileInfo & { content: string }

export type AppSettings = {
  compaction: CompactionSettings
  memory_files: Record<MemoryFileScope, MemoryFileInfo>
  user_profile: UserProfileSettings
  web_search: WebSearchSettings
}

export type ResumeChoice = {
  assistant: string
  id: string
  objective: string
  running?: boolean
  status: string
  time: string
  title: string
  turns: string
  user: string
}

export type CheckpointChoice = {
  created: string
  id: string
  session_id: string
  state: string
  user: string
}

export type SkillInfo = {
  description: string
  name: string
  path: string
  scope: 'project' | 'user'
}

export type SkillDetail = { content: string; skill: SkillInfo }

export type LocalAttachment = {
  kind: 'file' | 'folder'
  name: string
  path: string
  size?: number
}

export type PreparedLocalAttachments = {
  attachments: LocalAttachment[]
  images: Array<{ data_url: string; name: string; path: string; size: number }>
}

export type ArtifactInfo = {
  kind: 'image' | 'markdown' | 'pdf' | 'text'
  name: string
  path: string
  size: number
}

export type ArtifactDetail = ArtifactInfo & { content?: string; data_url?: string }

export type HistoryItem = {
  arguments?: unknown
  artifacts?: ArtifactInfo[]
  attachments?: LocalAttachment[]
  elapsed_ms?: number
  goal?: boolean
  images?: string[]
  kind: 'assistant' | 'reasoning' | 'system' | 'tool' | 'user'
  message_index?: number
  metrics?: MessageMetrics
  name?: string
  status?: 'approval' | 'done' | 'error' | 'running'
  text: string
  timestamp?: string
  tool_call_id?: string
}

export type ForkNode = {
  fork_message_index?: number
  fork_source?: string
  id: string
  parent: string
  time: string
  title: string
  turns?: number
}

export type ForkTree = { nodes: ForkNode[]; root: string }
export type SessionResult = { count?: number; history: HistoryItem[]; info: SessionInfo; progress?: ProgressState }

export type ClientMessage = {
  metrics?: MessageMetrics
  role: 'assistant' | 'system' | 'tool' | 'user'
  text: string
}

type SessionScoped = { session_id?: string }

export type GatewayEvent =
  | { type: 'gateway.ready'; payload: { cwd: string } }
  | { type: 'session.info'; payload: SessionInfo }
  | { type: 'message.start' | 'message.delta' | 'message.steered'; payload: { text: string } & SessionScoped }
  | { type: 'message.complete' | 'message.suspended'; payload: { artifacts?: ArtifactInfo[]; fork_points?: Array<{ kind: 'assistant'; message_index: number }>; metrics?: MessageMetrics; progress?: ProgressState; status?: string; text: string; verification?: VerificationResult } & SessionScoped }
  | { type: 'message.cancelled'; payload: SessionScoped }
  | { type: 'session.updated'; payload: { running?: boolean } & SessionScoped }
  | { type: 'session.titled'; payload: { title?: string } & SessionScoped }
  | { type: 'permission.updated'; payload: { permission_mode: PermissionMode } }
  | { type: 'reasoning.delta'; payload: { id: string; text: string } & SessionScoped }
  | { type: 'reasoning.complete'; payload: { elapsed_ms?: number; error?: boolean; id: string } & SessionScoped }
  | { type: 'tool.start' | 'tool.update' | 'tool.complete'; payload: { approval?: ApprovalInfo; arguments?: unknown; content?: string; elapsed_ms?: number; error?: boolean; name: string; tool_call_id: string } & SessionScoped }
  | { type: 'approval.pending'; payload: ApprovalInfo & SessionScoped }
  | { type: 'approval.resolved'; payload: { continued?: boolean; decision: string } & SessionScoped }
  | { type: 'verification.start'; payload: SessionScoped }
  | { type: 'verification.complete'; payload: VerificationResult & SessionScoped }
  | { type: 'progress.update'; payload: ProgressState & SessionScoped }
  | { type: 'context.compacted'; payload: ContextCompaction & SessionScoped }
  | { type: 'memory.updated'; payload: Record<string, unknown> & SessionScoped }
  | { type: 'gateway.stderr'; payload: { line: string } }
  | { type: 'gateway.protocol_error'; payload: { preview: string } }
