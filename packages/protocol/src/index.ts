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

export type ModelTermination = {
  reason: 'content_filter' | 'incomplete' | 'length' | 'stop' | 'tool_calls' | 'unknown'
  raw?: string
}

export type ProgressStep = {
  status: 'blocked' | 'completed' | 'in_progress' | 'pending'
  step: string
}

export type AcceptanceCriterion = { id: string; description: string }
export type CriterionVerification = {
  id: string
  description?: string
  verdict: 'blocked' | 'inconclusive' | 'pass' | 'repair'
  evidence: string[]
  feedback?: string
}

export type ProgressState = {
  latest_request?: string
  mode?: 'goal' | 'normal'
  next_action?: string
  objective?: string
  status?: 'blocked' | 'done' | 'waiting' | 'working'
  steps?: ProgressStep[]
  acceptance?: AcceptanceCriterion[]
  verification?: { criteria?: CriterionVerification[]; verdict?: string; attempt?: number; stop_reason?: string }
  updated?: string
}

export type ApprovalInfo = {
  approval_required?: boolean
  background?: boolean
  command?: string
  id?: string
  message?: string
  pending?: boolean
  reason?: string
  timeout_seconds?: number
}

export type VerificationResult = {
  criteria?: CriterionVerification[]
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
  trusted?: boolean
  digest?: string
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
  execution_backend?: string
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

export type ModelApi = 'chat-completions' | 'responses' | 'anthropic'
export type ModelReasoning = {
  mode: 'none' | 'effort' | 'adaptive' | 'toggle' | 'disabled-toggle'
  options: string[]
  default?: string
}
/** Explicit profile overrides take precedence over compatibility defaults. */
export type ModelCapabilities = {
  api?: ModelApi
  reasoning?: ModelReasoning
  tools?: boolean
  max_tokens_field?: 'max_tokens' | 'max_completion_tokens'
}
export type DiscoveredModel = { id: string; vision?: boolean; capabilities?: ModelCapabilities; context_window?: number; max_output_tokens?: number }

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
  capabilities?: ModelCapabilities
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

export type ExecutionSettings = {
  backend: 'native' | 'docker'
  image: string
  network: 'none' | 'bridge'
  managed_by?: 'environment'
}

export type AppSettings = {
  execution: ExecutionSettings
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

type SessionScoped = { session_id?: string; run_id?: string }

export type GatewayEvent =
  | { type: 'run.start'; payload: SessionScoped }
  | { type: 'gateway.ready'; payload: { cwd: string } }
  | { type: 'session.info'; payload: SessionInfo }
  | { type: 'message.start' | 'message.delta' | 'message.steered'; payload: { text: string } & SessionScoped }
  | { type: 'message.complete' | 'message.suspended'; payload: { artifacts?: ArtifactInfo[]; fork_points?: Array<{ kind: 'assistant'; message_index: number }>; metrics?: MessageMetrics; progress?: ProgressState; status?: string; termination?: ModelTermination; text: string; verification?: VerificationResult } & SessionScoped }
  | { type: 'message.cancelled'; payload: { stop_reason?: string } & SessionScoped }
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
  | { type: 'memory.warning'; payload: { message: string } & SessionScoped }
  | { type: 'gateway.stderr'; payload: { line: string } }
  | { type: 'gateway.protocol_error'; payload: { preview: string } }

/** Version 1 clients may omit protocol_version for compatibility. */
export type RpcRequest = { id?: string | number; jsonrpc?: '2.0'; protocol_version?: 1; method: string; params?: Record<string, unknown> }
export type RuntimeMethods = {
  'gateway.shutdown': { params: Record<string, never>; result: { stopped: boolean } }
  'session.info': { params: Record<string, never>; result: SessionInfo }
  'session.current': { params: Record<string, never>; result: { info: SessionInfo; history: HistoryItem[] } }
  'session.list': { params: { offset?: number; limit?: number }; result: { choices: ResumeChoice[]; next_offset?: number } }
  'plugin.list': { params: Record<string, never>; result: { plugins: PluginInfo[] } }
  'plugin.toggle': { params: { name: string; enabled: boolean; trust_digest?: string }; result: { plugins: PluginInfo[]; info: SessionInfo } }
  'plugin.reload': { params: Record<string, never>; result: { plugins: PluginInfo[]; info: SessionInfo } }
  'session.resume_choices': { params: Record<string, never>; result: { choices: ResumeChoice[] } }
  'session.tree': { params: { id?: string }; result: ForkTree }
  'session.messages': { params: { id?: string; offset?: number; limit?: number }; result: { messages: unknown[] } }
  'session.new': { params: Record<string, never>; result: SessionResult }
  'session.reset': { params: Record<string, never>; result: SessionResult }
  'session.resume': { params: { id: string }; result: SessionResult }
  'session.rename': { params: { id: string; title: string }; result: Record<string, unknown> }
  'session.fork': { params: { id: string; message_index?: number }; result: SessionResult & { tree: ForkTree } }
  'session.delete': { params: { id: string }; result: SessionResult & { deleted: string[] } }
  'session.compact': { params: Record<string, never>; result: { text: string } }
  'context.get': { params: Record<string, never>; result: { text: string } }
  'progress.get': { params: Record<string, never>; result: { progress: ProgressState } }
  'trace.serve': { params: Record<string, never>; result: { url: string } }
  'trace.stop': { params: Record<string, never>; result: { stopped: boolean } }
  'memory.command': { params: { command: string }; result: { text: string } }
  'checkpoint.list': { params: Record<string, never>; result: { checkpoints: CheckpointChoice[] } }
  'checkpoint.undo': { params: { id: string }; result: SessionResult & { changed_paths?: string[]; user?: string } }
  'skill.list': { params: Record<string, never>; result: { skills: SkillInfo[] } }
  'skill.get': { params: { path: string }; result: SkillDetail }
  'artifact.get': { params: { path: string }; result: ArtifactDetail }
  'attachment.prepare': { params: { attachments: Array<{ path: string }> }; result: PreparedLocalAttachments }
  'model.list': { params: Record<string, never>; result: ModelCatalog }
  'model.save': { params: { profile: Partial<ModelProfile> & Pick<ModelProfile, 'name' | 'provider'>; api_key?: string; clear_api_key?: boolean; activate?: boolean }; result: ModelUpdate }
  'model.key.get': { params: ModelTarget; result: { api_key: string } }
  'model.key.clear': { params: ModelTarget; result: ModelUpdate }
  'model.refresh': { params: ModelTarget; result: ModelUpdate & { models: string[] } }
  'model.enabled.set': { params: ModelTarget & { enabled: boolean }; result: ModelUpdate }
  'model.select': { params: { id: string }; result: ModelUpdate }
  'model.delete': { params: { id: string }; result: ModelUpdate }
  'projects.list': { params: Record<string, never>; result: { projects: Array<{ workspace: string; updated?: string }> } }
  'projects.close': { params: { workspace: string }; result: { closed: boolean } }
  'settings.get': { params: Record<string, never>; result: AppSettings }
  'settings.web.get': { params: Record<string, never>; result: WebSearchSettings }
  'settings.web.key.get': { params: { provider: string }; result: { api_key: string } }
  'settings.web.save': { params: Record<string, unknown>; result: WebSearchSettings }
  'settings.compaction.get': { params: Record<string, never>; result: CompactionSettings }
  'settings.compaction.save': { params: CompactionSettings; result: CompactionSettings }
  'settings.execution.save': { params: ExecutionSettings; result: ExecutionSettings }
  'settings.user.save': { params: { profile: Partial<UserProfileSettings> }; result: UserProfileSettings }
  'settings.memory.read': { params: { file: MemoryFileScope }; result: MemoryFileDetail }
  'settings.memory.save': { params: { file: MemoryFileScope; content: string }; result: MemoryFileInfo }
  'permission.set': { params: { mode: PermissionMode }; result: { permission_mode: PermissionMode } }
  'thinking.set': { params: { effort: string }; result: { thinking_effort: string; info: SessionInfo } }
  'chat.send': { params: ChatParams; result: TurnResponse }
  'goal.run': { params: ChatParams & { criteria?: AcceptanceCriterion[] }; result: TurnResponse & { verification?: VerificationResult } }
  'chat.steer': { params: { text: string }; result: { steered: boolean; session_id: string } }
  'chat.cancel': { params: { session_id?: string }; result: { cancelled: boolean; dropped_steers?: string[]; session_id?: string } }
  'approval.pending': { params: Record<string, never>; result: ApprovalInfo }
  'approval.approve': { params: { session?: boolean }; result: Record<string, unknown> }
  'approval.instruct': { params: { text: string }; result: Record<string, unknown> }
  'approval.reject': { params: Record<string, never>; result: Record<string, unknown> }
}
type ModelTarget = { provider?: string; profile?: string }
type ModelUpdate = { catalog: ModelCatalog; info: SessionInfo }
type ChatParams = { text: string; images?: string[]; attachments?: Array<{ path: string }>; run?: { timeout_ms: number; reserve_ms?: number } }
type TurnResponse = { text: string; session_id?: string; stop_reason?: string; termination?: ModelTermination; cancelled?: boolean }
export type RuntimeRequest<M extends keyof RuntimeMethods> = Omit<RpcRequest, 'method' | 'params'> & { method: M; params: RuntimeMethods[M]['params'] }
