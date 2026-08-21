import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open } from '@tauri-apps/plugin-dialog'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { CSSProperties, FormEvent, KeyboardEvent, memo, MouseEvent, PointerEvent as ReactPointerEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'

import fridayAvatar from './assets/friday-avatar.svg'
import { getLanguage, loadLanguage, setLanguage, t, type Language } from './i18n'
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronIcon,
  CloseIcon,
  DiamondIcon,
  EyeIcon,
  FileIcon,
  FolderIcon as FileFolderIcon,
  InfoIcon,
  MinusIcon,
  PencilIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  TargetIcon,
  TrashIcon,
  UndoIcon
} from './Icons'
import { normalizeMarkdown } from './markdown'
import { MenuDetails } from './MenuDetails'
import { SaveFooter, SettingsMessage, useSettingsSave } from './SettingsForm'
import { collectMessageSources, hostOf, safeIconUrl, type WebSource } from './sources'

const markdownRemarkPlugins = [remarkGfm, remarkMath]
const markdownRehypePlugins = [rehypeKatex]

// Markdown here is model- and tool-authored, so a link is untrusted input. Anything
// that is not plain http(s) is dropped rather than handed to the webview: a
// protocol-relative or app-internal URL would navigate the window away from Friday.
function externalUrl(value: string | undefined) {
  if (!value) return ''
  try {
    const parsed = new URL(value, 'friday:invalid')
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : ''
  } catch {
    return ''
  }
}

// Inline artifact data or a remote image; every other scheme is dropped.
function imageUrl(value: string | undefined) {
  if (!value) return ''
  if (/^data:(?:image\/(?:gif|jpeg|png|webp)|application\/pdf);base64,/i.test(value)) return value
  return externalUrl(value)
}

function markdownComponents(onOpenLink: (url: string) => void): Components {
  return {
    a: ({ children, node: _node, ...props }) => {
      // A bare fragment stays in the document, so it needs no external handling.
      if (props.href?.startsWith('#')) return <a {...props}>{children}</a>
      const href = externalUrl(props.href)
      if (!href) return <span>{children}</span>
      return (
        <a
          {...props}
          href={href}
          onClick={event => {
            event.preventDefault()
            onOpenLink(href)
          }}
          rel="noreferrer"
        >
          {children}
        </a>
      )
    },
    img: ({ node: _node, ...props }) => {
      const src = imageUrl(props.src)
      return src ? <img {...props} src={src} /> : null
    }
  }
}

type Metrics = {
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

type PermissionMode = 'auto' | 'bypass' | 'manual'
type ProjectStatus = 'connecting' | 'error' | 'idle' | 'ready'
type ThinkingEffort = string

const permissionOptions: ReadonlyArray<{
  descriptionKey: string
  labelKey: string
  value: PermissionMode
}> = [
  { descriptionKey: 'permission.manual.desc', labelKey: 'permission.manual', value: 'manual' },
  { descriptionKey: 'permission.auto.desc', labelKey: 'permission.auto', value: 'auto' },
  { descriptionKey: 'permission.bypass.desc', labelKey: 'permission.bypass', value: 'bypass' }
]

const thinkingOptions: ReadonlyArray<{
  descriptionKey: string
  labelKey: string
  value: ThinkingEffort
}> = [
  { descriptionKey: 'effort.off.desc', labelKey: 'effort.off', value: 'off' },
  { descriptionKey: 'effort.on.desc', labelKey: 'effort.on', value: 'on' },
  { descriptionKey: 'effort.none.desc', labelKey: 'effort.none', value: 'none' },
  { descriptionKey: 'effort.minimal.desc', labelKey: 'effort.minimal', value: 'minimal' },
  { descriptionKey: 'effort.low.desc', labelKey: 'effort.low', value: 'low' },
  { descriptionKey: 'effort.medium.desc', labelKey: 'effort.medium', value: 'medium' },
  { descriptionKey: 'effort.high.desc', labelKey: 'effort.high', value: 'high' },
  { descriptionKey: 'effort.xhigh.desc', labelKey: 'effort.xhigh', value: 'xhigh' },
  { descriptionKey: 'effort.max.desc', labelKey: 'effort.max', value: 'max' }
]

type Approval = {
  approval_required?: boolean
  command?: string
  pending?: boolean
  reason?: string
}

type VerificationStatus = {
  approval_required?: boolean
  error?: boolean
  feedback?: string
  passed?: boolean
  verdict?: string
}

/** Friday rewrote the conversation to keep it inside the model's context window. */
type ContextCompaction = {
  after_tokens?: number
  before_tokens?: number
  fallback?: boolean
  kept_turns?: number
  kind?: 'conversation' | 'tool_results'
  notice?: string
  ok?: boolean
  reason?: string
  tool_results?: number
}

type SessionInfo = {
  approval?: Approval
  cwd: string
  model: string
  model_configured?: boolean
  model_name?: string
  model_profile?: string
  model_vision?: boolean
  permission_mode: PermissionMode
  thinking_effort: ThinkingEffort
  thinking_options?: ThinkingEffort[]
  thinking_supported?: boolean
  session_id?: string
  running?: boolean
  tools: string[]
}

type ModelProfile = {
  api_key_configured: boolean
  base_url: string
  context_window: number
  enabled: boolean
  id: string
  max_output_tokens: number
  model: string
  name: string
  provider: string
  vision: boolean
}

type ModelProvider = {
  api_key_configured: boolean
  base_url: string
  builtin: boolean
  enabled: boolean
  id: string
  label: string
  models: Array<{ id: string; vision: boolean }>
}

type ModelCatalog = {
  active: string
  disabled?: string[]
  profiles: ModelProfile[]
  providers: ModelProvider[]
}

type WebSearchSettings = {
  anysearch_configured: boolean
  tavily_configured: boolean
}

type CompactionSettings = {
  automatic: boolean
  threshold_percent: number
  strategy: 'insert' | 'two-stage'
}

type UserProfileSettings = {
  habits: string
  preferred_language: string
  preferred_name: string
}

type MemoryFileInfo = {
  chars: number
  limit: number
  path: string
}

type MemoryFileDetail = MemoryFileInfo & {
  content: string
}

type MemoryFileScope = 'global' | 'user'

type AppSettings = {
  compaction: CompactionSettings
  memory_files: Record<MemoryFileScope, MemoryFileInfo>
  user_profile: UserProfileSettings
  web_search: WebSearchSettings
}

type ResumeChoice = {
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

type CheckpointChoice = {
  created: string
  id: string
  session_id: string
  state: string
  user: string
}

type SkillInfo = {
  description: string
  name: string
  path: string
  scope: string
}

type SkillDetail = {
  content: string
  skill: SkillInfo
}

type ImageAttachment = {
  dataUrl: string
  kind: 'image'
  name: string
}

type LocalAttachment = {
  kind: 'file' | 'folder'
  name: string
  path: string
  size?: number
}

type ComposerAttachment = ImageAttachment | LocalAttachment

type ArtifactInfo = {
  kind: 'image' | 'markdown' | 'pdf' | 'text'
  name: string
  path: string
  size: number
}

type ArtifactDetail = ArtifactInfo & {
  content?: string
  data_url?: string
}

type HistoryItem = {
  arguments?: unknown
  artifacts?: ArtifactInfo[]
  attachments?: LocalAttachment[]
  elapsed_ms?: number
  goal?: boolean
  images?: string[]
  kind: TimelineItem['kind']
  message_index?: number
  metrics?: Metrics
  name?: string
  status?: TimelineItem['status']
  text: string
  timestamp?: string
  tool_call_id?: string
}

type ThinkingState = {
  ended?: number
  error?: boolean
  started: number
  /** Real accumulated thinking time; merged blocks carry this instead of the
      started→ended span, which would count the tool time between rounds. */
  duration?: number
}

type TimelineItem = {
  arguments?: string
  artifacts?: ArtifactInfo[]
  attachments?: LocalAttachment[]
  checkpointId?: string
  createdAt?: string
  id: string
  forkIndex?: number
  goal?: boolean
  images?: string[]
  kind: 'assistant' | 'reasoning' | 'system' | 'tool' | 'user'
  metrics?: Metrics
  name?: string
  status?: 'approval' | 'done' | 'error' | 'running'
  /** True only while message.delta is still appending to this item. */
  streaming?: boolean
  /** Tool execution time reported by the backend on tool.complete. */
  elapsed_ms?: number
  text: string
  thinking?: ThinkingState
  toolCallId?: string
}

type ForkNode = {
  fork_source?: string
  id: string
  parent: string
  time: string
  title: string
}

type ForkTree = {
  nodes: ForkNode[]
  root: string
}

type ProjectView = {
  activeSession: string
  attachments: ComposerAttachment[]
  busy: boolean
  cancelling: boolean
  checkpoints: CheckpointChoice[]
  draft: string
  guidance: string
  goalMode: boolean
  forkTree: ForkTree
  info: SessionInfo
  items: TimelineItem[]
  models: ModelCatalog
  pendingApproval: Approval | null
  sessions: ResumeChoice[]
  skills: SkillInfo[]
  status: ProjectStatus
}

type GatewayMessage = {
  error?: { message?: string }
  id?: string
  method?: string
  params?: {
    payload?: Record<string, unknown>
    type?: string
  }
  result?: unknown
}

type PendingRequest = {
  reject: (error: Error) => void
  resolve: (value: unknown) => void
  workspace: string
}

// How long a project may sit untouched before its backend is stopped, and how
// often that is checked. Five minutes is long enough that switching away to read
// something does not cost a restart, short enough that a forgotten project is not
// holding a backend for a whole session.
const BACKEND_IDLE_MS = 5 * 60 * 1000
const BACKEND_SWEEP_MS = 60 * 1000
// Streaming deltas are coalesced before they touch React state: re-rendering on
// every token makes long answers grind, because each flush re-parses the
// growing message.
const STREAM_FLUSH_MS = 80
// Tool results (bash output, file reads) and old messages are the largest
// strings a conversation keeps; capping what the timeline retains bounds the
// window's heap no matter how long a session runs.
const MAX_TOOL_TEXT = 16_000
const MAX_MESSAGE_TEXT = 100_000
const PROJECTS_KEY = 'friday.desktop.projects'
const ACTIVE_PROJECT_KEY = 'friday.desktop.activeProject'
const SIDEBAR_WIDTH_KEY = 'friday.desktop.sidebarWidth'
const THEME_KEY = 'friday.desktop.theme'
const DEFAULT_SIDEBAR_WIDTH = 252
type SidebarSection = 'projects' | 'recent'
const MIN_SIDEBAR_WIDTH = 180
const MAX_SIDEBAR_WIDTH = 520
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_LOCAL_ATTACHMENTS = 8
const MAX_IMAGE_ATTACHMENTS = 4
const WELCOME_MESSAGE_KEYS = ['welcome.0', 'welcome.1', 'welcome.2', 'welcome.3', 'welcome.4', 'welcome.5']

// Picks the time-of-day greeting that prefixes the random welcome hint. The
// greeting is plain fixed copy, never model output, so it is chosen locally.
function welcomeGreetingKey(now = new Date()): string {
  const hour = now.getHours()
  if (hour >= 5 && hour < 12) return 'welcome.greeting.morning'
  if (hour >= 12 && hour < 18) return 'welcome.greeting.afternoon'
  if (hour >= 18 && hour < 23) return 'welcome.greeting.evening'
  return 'welcome.greeting.late'
}
const emptyModelCatalog: ModelCatalog = { active: '', profiles: [], providers: [] }
const CUSTOM_NEW = 'openai-compatible:new'

function nextId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function capText(text: string, limit: number) {
  return text.length > limit ? `${text.slice(0, limit)}\n\n… [truncated]` : text
}

// Attached images are base64 data URLs, so a session that scrolls past many
// attachments would otherwise pin every decoded copy for the life of the
// window. The timeline stores cache keys instead; the URLs live here under an
// LRU budget, with reads reinserting so eviction drops the least viewed first.
// The same trick the artifact thumbnails already use, applied to user images.
const IMAGE_CACHE_BYTES = 96 * 1024 * 1024
const imageCache = new Map<string, string>()
let imageCacheBytes = 0

function imageCacheKey(session: string, itemId: string, index: number) {
  return `${session}\u0000${itemId}\u0000${index}`
}

function readCachedImage(key: string) {
  const value = imageCache.get(key)
  if (value === undefined) return ''
  imageCache.delete(key)
  imageCache.set(key, value)
  return value
}

function writeImage(session: string, itemId: string, index: number, dataUrl: string) {
  const key = imageCacheKey(session, itemId, index)
  imageCacheBytes -= imageCache.get(key)?.length ?? 0
  imageCache.set(key, dataUrl)
  imageCacheBytes += dataUrl.length
  while (imageCache.size > 1 && imageCacheBytes > IMAGE_CACHE_BYTES) {
    const oldest = imageCache.keys().next()
    if (oldest.done) break
    imageCacheBytes -= imageCache.get(oldest.value)?.length ?? 0
    imageCache.delete(oldest.value)
  }
}

function writeMessageImages(session: string, itemId: string, images: string[]) {
  for (let index = 0; index < images.length; index += 1) {
    writeImage(session, itemId, index, images[index]!)
  }
}

/** A turn a guard ended reads as a normal answer, so name the reason. */
function stopReasonText(status: unknown) {
  if (status === 'no_progress') return t('stop.noProgress')
  if (status === 'context_window') return t('stop.contextWindow')
  return ''
}

function compactionText(payload: ContextCompaction) {
  if (payload.ok === false) {
    return t('context.compactFailed', { reason: payload.reason || '—' })
  }
  if (payload.kind === 'tool_results') {
    return t('context.toolsCompacted', {
      after: shortTokens(payload.after_tokens || 0),
      before: shortTokens(payload.before_tokens || 0),
      count: payload.tool_results || 0
    })
  }
  const measured = Boolean(payload.before_tokens && payload.after_tokens && payload.kept_turns)
  const main = measured
    ? t('context.compacted', {
        after: shortTokens(payload.after_tokens!),
        before: shortTokens(payload.before_tokens!),
        turns: payload.kept_turns!
      })
    : t('context.compactedPlain')
  return payload.fallback ? `${main} ${t('context.compactedLocal')}` : main
}

function shortTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  return value >= 1000 ? `${Math.round(value / 1000)}k` : String(value)
}

function emptyView(path = ''): ProjectView {
  return {
    activeSession: '',
    attachments: [],
    busy: false,
    cancelling: false,
    checkpoints: [],
    draft: '',
    guidance: '',
    goalMode: false,
    forkTree: { nodes: [], root: '' },
    info: { cwd: path, model: path ? 'loading' : '', permission_mode: 'manual', thinking_effort: 'high', tools: [] },
    items: [],
    models: emptyModelCatalog,
    pendingApproval: null,
    sessions: [],
    skills: [],
    status: path ? 'connecting' : 'idle'
  }
}

function readImage(file: File) {
  return new Promise<ImageAttachment>((resolve, reject) => {
    if (file.size > MAX_IMAGE_BYTES) {
      reject(new Error('Images must be 10 MB or smaller.'))
      return
    }
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
      reject(new Error('Paste a PNG, JPEG, WebP, or GIF image.'))
      return
    }
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Friday could not read the pasted image.'))
    reader.onload = () => resolve({ dataUrl: String(reader.result || ''), kind: 'image', name: file.name || 'Pasted image' })
    reader.readAsDataURL(file)
  })
}

function loadProjects() {
  try {
    const value = JSON.parse(localStorage.getItem(PROJECTS_KEY) || '[]')
    if (!Array.isArray(value)) return []
    const seen = new Set<string>()
    const projects: string[] = []
    for (const item of value) {
      if (typeof item !== 'string') continue
      // Stored before the gateway normalised what it returns, so rewrite rather
      // than only dedupe: the path is shown in the sidebar and sent to Friday.
      const path = plainPath(item)
      const key = pathKey(path)
      if (!key || seen.has(key)) continue
      seen.add(key)
      projects.push(path)
    }
    return projects
  } catch {
    return []
  }
}

/**
 * Windows' extended-length spelling of a directory reduced to the plain one.
 *
 * `canonicalize` produces `\\?\E:\work` for a directory the registry already
 * knows as `E:\work`. Both name the same folder, so treating them as different
 * projects listed one workspace twice and let a close land on the copy the
 * sidebar was not showing.
 */
function plainPath(path: string) {
  const trimmed = path.trim()
  if (trimmed.startsWith('\\\\?\\UNC\\')) return `\\\\${trimmed.slice('\\\\?\\UNC\\'.length)}`
  if (trimmed.startsWith('\\\\?\\')) return trimmed.slice('\\\\?\\'.length)
  return trimmed
}

function pathKey(path: string) {
  return plainPath(path).replace(/[\\/]+$/, '').replace(/\//g, '\\').toLocaleLowerCase()
}

function localAttachment(path: string, kind: LocalAttachment['kind']): LocalAttachment {
  const clean = plainPath(path)
  const parts = clean.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
  return { kind, name: parts.at(-1) || clean, path: clean }
}

function samePath(left: string, right: string) {
  return pathKey(left) === pathKey(right)
}

function sessionEventKey(workspace: string, sessionId: string) {
  return `${pathKey(workspace)}::${sessionId}`
}

/** Whether the folder is still there. Resolving is what opening it would do first. */
async function directoryExists(path: string) {
  if (!path.trim()) return false
  return invoke<string>('resolve_directory', { path }).then(() => true).catch(() => false)
}

/**
 * The tracked projects whose folders still exist.
 *
 * A project the user deleted on disk stays in this window's list forever
 * otherwise, because the list is only ever merged into from the registry and
 * never pruned by it -- so the entry keeps showing up and opening it fails with
 * an OS path error. The registry keeps its own record, so a workspace that is
 * merely unmounted is not forgotten: it returns to the sidebar on the launch
 * after its path resolves again.
 */
async function presentProjects(paths: string[]) {
  const checked = await Promise.all(paths.map(async path => (await directoryExists(path) ? path : '')))
  return checked.filter(Boolean)
}

function loadSidebarWidth() {
  return clampSidebarWidth(Number(localStorage.getItem(SIDEBAR_WIDTH_KEY)) || DEFAULT_SIDEBAR_WIDTH)
}

type Theme = 'dark' | 'light'

function storedTheme(): Theme | null {
  const value = localStorage.getItem(THEME_KEY)
  return value === 'dark' || value === 'light' ? value : null
}

function loadTheme(): Theme {
  return storedTheme() || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
}

function clampSidebarWidth(width: number) {
  const available = Math.max(MIN_SIDEBAR_WIDTH, window.innerWidth - 420)
  return Math.min(Math.max(width, MIN_SIDEBAR_WIDTH), MAX_SIDEBAR_WIDTH, available)
}

function App() {
  const initialProjects = useRef(loadProjects())
  const [projects, setProjects] = useState<string[]>(initialProjects.current)
  const [activeProject, setActiveProject] = useState(localStorage.getItem(ACTIVE_PROJECT_KEY) || '')
  const [defaultWorkspace, setDefaultWorkspace] = useState('')
  const [renaming, setRenaming] = useState<{ id: string; original: string; title: string; workspace: string } | null>(null)
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())
  const [collapsedSections, setCollapsedSections] = useState<Set<SidebarSection>>(new Set())
  const [resizingSidebar, setResizingSidebar] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth)
  const [theme, setTheme] = useState<Theme>(loadTheme)
  const [language, setLanguageState] = useState<Language>(loadLanguage)
  const [page, setPage] = useState<'chat' | 'settings' | 'skills'>('chat')
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general')
  const [projectDropActive, setProjectDropActive] = useState(false)
  const [skillDetail, setSkillDetail] = useState<SkillDetail | null>(null)
  const [skillError, setSkillError] = useState('')
  const [skillQuery, setSkillQuery] = useState('')
  const [artifactPreview, setArtifactPreview] = useState<ArtifactDetail | null>(null)
  const [previewImage, setPreviewImage] = useState('')
  const [views, setViews] = useState<Record<string, ProjectView>>({})
  const activeProjectRef = useRef(activeProject)
  const activeSessions = useRef(new Map<string, string>())
  const activeAssistants = useRef(new Map<string, string>())
  // The composer textarea grows with its content and caps at a fraction of
  // the window, so a long draft scrolls inside the box instead of owning it.
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const timeline = useRef<HTMLElement | null>(null)
  const followOutput = useRef(true)
  const pendingRequests = useRef(new Map<string, PendingRequest>())
  const requestId = useRef(0)
  // Streaming text lands here and is flushed to state in batches; see
  // STREAM_FLUSH_MS. Keyed per workspace/session/stream so several projects can
  // stream at once without their deltas interleaving.
  const streamBuffers = useRef(new Map<string, { apply: (text: string) => void; text: string; timer: number }>())
  const cancelledEventKeys = useRef(new Set<string>())

  const streamAppend = (key: string, text: string, apply: (text: string) => void) => {
    const existing = streamBuffers.current.get(key)
    if (existing) {
      existing.text += text
      return
    }
    const entry = { apply, text, timer: 0 }
    streamBuffers.current.set(key, entry)
    entry.timer = window.setTimeout(() => {
      if (streamBuffers.current.get(key) !== entry) return
      streamBuffers.current.delete(key)
      entry.apply(entry.text)
    }, STREAM_FLUSH_MS)
  }

  const flushStream = (key: string) => {
    const entry = streamBuffers.current.get(key)
    if (!entry) return
    streamBuffers.current.delete(key)
    window.clearTimeout(entry.timer)
    entry.apply(entry.text)
  }

  const dropStream = (key: string) => {
    const entry = streamBuffers.current.get(key)
    if (!entry) return
    streamBuffers.current.delete(key)
    window.clearTimeout(entry.timer)
  }
  const sidebarDrag = useRef<{ startWidth: number; startX: number } | null>(null)
  // Keyed by pathKey; the value is the path itself, which the idle sweep needs to
  // name a backend it wants stopped.
  const startedProjects = useRef(new Map<string, string>())
  const openProjects = useRef(new Set(initialProjects.current.map(pathKey)))
  // Dropping a project can land on another one that is also gone, and the nested
  // drop would read the list from a closure React has not re-rendered yet -- so
  // it would put the project the outer drop just removed back in the sidebar.
  const projectsRef = useRef(initialProjects.current)
  const selectProjectRef = useRef<(workspace: string) => Promise<string | undefined>>(async () => undefined)
  const lastUsed = useRef(new Map<string, number>())
  // Backends this window stopped on purpose are reported by the gateway as
  // `gateway-stopped` (never surfaced), so a session stopped while its process
  // was shutting down is not mistaken for a crash. The conversation each one
  // was on is remembered here, so reselecting it comes back to the same place
  // instead of a fresh session.
  const reapedSessions = useRef(new Map<string, string>())
  const viewsRef = useRef<Record<string, ProjectView>>({})
  // Messages typed while a turn runs, waiting to start after it finishes.
  const queuedTexts = useRef(new Map<string, string[]>())

  const view = views[activeProject] || emptyView(activeProject)
  const { activeSession, attachments, busy, cancelling, checkpoints, draft, forkTree, goalMode, guidance, info, items, models, pendingApproval, sessions, skills, status } = view
  const isDefaultWorkspace = Boolean(defaultWorkspace && samePath(defaultWorkspace, activeProject))
  const updateView = (workspace: string, update: (current: ProjectView) => ProjectView) => {
    setViews(current => {
      const next = update(current[workspace] || emptyView(workspace))
      activeSessions.current.set(pathKey(workspace), next.activeSession)
      return { ...current, [workspace]: next }
    })
  }

  const rememberProject = (workspace: string) => {
    openProjects.current.add(pathKey(workspace))
    setProjects(current => {
      const index = current.findIndex(path => samePath(path, workspace))
      if (index < 0) return [...current, workspace]
      if (current[index] === workspace) return current
      const next = [...current]
      next[index] = workspace
      return next
    })
  }

  const markStarted = (workspace: string) => {
    const key = pathKey(workspace)
    startedProjects.current.set(key, workspace)
    lastUsed.current.set(key, Date.now())
  }

  const sendGateway = <T,>(workspace: string, method: string, params: Record<string, unknown> = {}) => {
    const id = `desktop-${++requestId.current}`
    return new Promise<T>((resolve, reject) => {
      pendingRequests.current.set(id, { resolve: value => resolve(value as T), reject, workspace })
      const message = JSON.stringify({ id, jsonrpc: '2.0', method, params })
      const write = () => invoke('gateway_send', { workspace, message })
      void write().catch(async error => {
        if (!String(error).includes('gateway is not running')) throw error
        const resolved = await invoke<string>('gateway_start', { workspace })
        markStarted(resolved)
        await write()
      }).catch(error => {
          pendingRequests.current.delete(id)
          reject(error)
        })
    })
  }

  const applySessionInfo = (workspace: string, value: SessionInfo) => {
    updateView(workspace, current => ({
      ...current,
      activeSession: value.session_id || '',
      info: value,
      pendingApproval: value.approval?.pending ? value.approval : null,
      status: 'ready'
    }))
  }

  const refreshSessions = (workspace: string) =>
    sendGateway<{ choices: ResumeChoice[] }>(workspace, 'session.resume_choices').then(result => {
      updateView(workspace, current => ({ ...current, sessions: result.choices }))
    })

  const refreshCheckpoints = (workspace: string) =>
    sendGateway<{ checkpoints: CheckpointChoice[] }>(workspace, 'checkpoint.list').then(result => {
      updateView(workspace, current => ({ ...current, checkpoints: result.checkpoints }))
    })

  const refreshSkills = (workspace: string) =>
    sendGateway<{ skills: SkillInfo[] }>(workspace, 'skill.list').then(result => {
      updateView(workspace, current => ({ ...current, skills: result.skills }))
    })

  const refreshTree = (workspace: string, sessionId?: string) =>
    sendGateway<ForkTree>(workspace, 'session.tree', { id: sessionId || activeSessions.current.get(pathKey(workspace)) || '' })
      .then(result => updateView(workspace, current => ({ ...current, forkTree: result })))

  const refreshModels = (workspace: string) =>
    sendGateway<ModelCatalog>(workspace, 'model.list').then(result => {
      updateView(workspace, current => ({ ...current, models: result }))
    })

  // `resumeId` restores a specific conversation rather than whatever a freshly
  // started backend defaults to, which is a new empty one. The idle sweep needs
  // this: stopping a backend must be invisible apart from the wait to restart it.
  const hydrateProject = (workspace: string, resumeId?: string) =>
    Promise.all([
      resumeId
        ? sendGateway<{ history: HistoryItem[]; info: SessionInfo }>(workspace, 'session.resume', { id: resumeId })
        : sendGateway<{ history: HistoryItem[]; info: SessionInfo }>(workspace, 'session.current'),
      sendGateway<{ choices: ResumeChoice[] }>(workspace, 'session.resume_choices'),
      sendGateway<{ checkpoints: CheckpointChoice[] }>(workspace, 'checkpoint.list'),
      sendGateway<{ skills: SkillInfo[] }>(workspace, 'skill.list'),
      sendGateway<ModelCatalog>(workspace, 'model.list')
    ]).then(([current, saved, checkpointResult, skillResult, modelResult]) => {
      updateView(workspace, existing => ({
        ...existing,
        activeSession: current.info.session_id || '',
        busy: Boolean(current.info.running),
        checkpoints: checkpointResult.checkpoints,
        info: current.info,
        items: timelineFromHistory(current.history, current.info.session_id || ''),
        models: modelResult,
        pendingApproval: current.info.approval?.pending ? current.info.approval : null,
        sessions: saved.choices,
        skills: skillResult.skills,
        status: 'ready'
      }))
      return refreshTree(workspace, current.info.session_id)
    })

  useEffect(() => {
    viewsRef.current = views
  }, [views])

  // One gateway runs per open project, so a project the user walked away from
  // still consumes resources like the one they are working in. Its
  // state is on disk, so stopping it is recoverable; reselecting it restarts the
  // backend and resumes the same conversation. Only the idle timeout reclaims:
  // capping the number of live backends would restart them while the user is
  // switching between projects, which is when they are least willing to wait.
  useEffect(() => {
    const stopBackend = (key: string, workspace: string, view: ProjectView | undefined) => {
      const session = view?.activeSession || activeSessions.current.get(key) || ''
      if (session) reapedSessions.current.set(key, session)
      startedProjects.current.delete(key)
      void invoke('gateway_stop', { workspace })
        .then(() => {
          // The user may have reselected while the stop was in flight, and that
          // reselect rehydrates on its own. Reclaim only a view nobody is
          // using: dropping the timeline frees the largest strings the window
          // holds, which is what makes a day of use accumulate.
          if (startedProjects.current.has(key) || samePath(activeProjectRef.current, workspace)) return
          updateView(workspace, current => ({
            ...current,
            busy: false,
            items: [],
            pendingApproval: null,
            status: 'idle'
          }))
        })
        .catch(() => {
          startedProjects.current.set(key, workspace)
        })
    }
    const sweep = () => {
      const active = pathKey(activeProjectRef.current)
      const now = Date.now()
      const eligible: Array<{ idleFor: number; key: string; view: ProjectView | undefined; workspace: string }> = []
      for (const [key, workspace] of [...startedProjects.current]) {
        // Matched with pathKey rather than read by key: views are stored under the
        // path the caller used, and a miss here would read as "not busy" and stop a
        // backend in the middle of a turn.
        const entry = Object.entries(viewsRef.current).find(([path]) => pathKey(path) === key)
        const view = entry?.[1]
        const waiting = [...pendingRequests.current.values()].some(item => samePath(item.workspace, workspace))
        const idleFor = now - (lastUsed.current.get(key) ?? now)
        if (key === active || waiting || view?.busy || view?.pendingApproval) continue
        eligible.push({ idleFor, key, view, workspace })
      }
      eligible.sort((a, b) => a.idleFor - b.idleFor)
      // Only the idle timeout reclaims: capping the number of live backends
      // would restart them while the user is switching between projects, which
      // is when they are least willing to wait.
      for (const item of eligible) {
        if (item.idleFor < BACKEND_IDLE_MS) break
        stopBackend(item.key, item.workspace, item.view)
      }
    }
    const timer = window.setInterval(sweep, BACKEND_SWEEP_MS)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => () => {
    for (const entry of streamBuffers.current.values()) window.clearTimeout(entry.timer)
    streamBuffers.current.clear()
  }, [])

  useEffect(() => {
    projectsRef.current = projects
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects))
  }, [projects])

  useEffect(() => {
    const tracked = projects.some(path => samePath(path, activeProject))
    if (activeProject && tracked) localStorage.setItem(ACTIVE_PROJECT_KEY, activeProject)
    else localStorage.removeItem(ACTIVE_PROJECT_KEY)
    setRenaming(null)
    setArtifactPreview(null)
    setPage('chat')
    setPreviewImage('')
    setSkillDetail(null)
    setSkillError('')
  }, [activeProject, projects])

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth))
  }, [sidebarWidth])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#151719' : '#efefeb')
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  useEffect(() => {
    if (storedTheme()) return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const followSystem = () => setTheme(media.matches ? 'dark' : 'light')
    media.addEventListener('change', followSystem)
    return () => media.removeEventListener('change', followSystem)
  }, [])

  useEffect(() => {
    let timer = 0
    const onScroll = () => {
      document.documentElement.classList.add('scrolling')
      window.clearTimeout(timer)
      timer = window.setTimeout(() => document.documentElement.classList.remove('scrolling'), 700)
    }
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('scroll', onScroll, { capture: true })
    }
  }, [])

  useEffect(() => {
    let unlisten: UnlistenFn | undefined
    let unlistenExit: UnlistenFn | undefined
    let unlistenStopped: UnlistenFn | undefined
    let disposed = false

    const handleLine = (workspace: string, line: string) => {
      let message: GatewayMessage
      try {
        message = JSON.parse(line) as GatewayMessage
      } catch {
        return
      }
      // Anything a backend says counts as activity, which is what keeps a project
      // running a long turn in the background out of the idle sweep's way.
      lastUsed.current.set(pathKey(workspace), Date.now())

      if (message.id) {
        const pending = pendingRequests.current.get(message.id)
        if (pending) {
          pendingRequests.current.delete(message.id)
          message.error
            ? pending.reject(new Error(message.error.message || 'Friday gateway failed.'))
            : pending.resolve(message.result)
          return
        }
      }
      if (!openProjects.current.has(pathKey(workspace))) return

      if (message.error) {
        updateView(workspace, current => ({
          ...current,
          busy: false,
          items: [...current.items, { id: nextId('error'), kind: 'system', text: message.error?.message || 'Friday gateway failed.' }],
          status: 'error'
        }))
        return
      }

      if (message.method !== 'event' || !message.params) return
      const { payload = {}, type } = message.params
      const sessionId = String(payload.session_id || '')
      const activeSessionId = activeSessions.current.get(pathKey(workspace)) || ''
      const eventKey = sessionEventKey(workspace, sessionId || activeSessionId)
      if (sessionId && activeSessionId && sessionId !== activeSessionId) {
        if (type === 'message.complete' || type === 'message.cancelled' || type === 'session.updated' || type === 'session.titled') {
          activeAssistants.current.delete(eventKey)
          void refreshSessions(workspace).catch(() => undefined)
        }
        return
      }
      if (type === 'message.start') {
        cancelledEventKeys.current.delete(eventKey)
        // Turns the gateway starts on its own (steers delivered after the
        // last model step) need a user bubble here; locally-sent turns
        // already added one in submit, so an identical trailing text skips.
        const startText = String(payload.text || '')
        if (startText) {
          updateView(workspace, current => {
            const lastUser = [...current.items].reverse().find(item => item.kind === 'user')
            if (lastUser?.text === startText) return { ...current, busy: true, cancelling: false }
            return {
              ...current,
              busy: true,
              cancelling: false,
              items: [...current.items, { createdAt: new Date().toISOString(), id: nextId('user'), kind: 'user', text: startText }]
            }
          })
        }
      }
      if (cancelledEventKeys.current.has(eventKey) && (
        type === 'message.delta' ||
        type === 'reasoning.delta' ||
        type === 'tool.start' ||
        type === 'tool.update' ||
        type === 'tool.complete'
      )) return

      if (type === 'reasoning.delta') {
        // Thinking effort "off" is a promise to hide reasoning: some providers
        // still stream it, so honor the choice here instead of rendering it.
        if (viewsRef.current[pathKey(workspace)]?.info?.thinking_effort === 'off') return
        const reasoningId = String(payload.id || '')
        const text = String(payload.text || '')
        if (!reasoningId || !text) return
        const itemId = `thinking-${reasoningId}`
        const assistantId = activeAssistants.current.get(eventKey)
        const streamKey = `${eventKey}\u0000thinking`
        streamAppend(streamKey, text, chunk => {
          if (!openProjects.current.has(pathKey(workspace))) return
          updateView(workspace, current => {
            if (current.items.some(item => item.id === itemId)) {
              return {
                ...current,
                items: current.items.map(item => item.id === itemId ? { ...item, text: item.text + chunk } : item)
              }
            }
            const block: TimelineItem = { id: itemId, kind: 'reasoning', text: chunk, thinking: { started: Date.now() } }
            const index = assistantId ? current.items.findIndex(item => item.id === assistantId) : -1
            return {
              ...current,
              items: index < 0
                ? [...current.items, block]
                : [...current.items.slice(0, index), block, ...current.items.slice(index)]
            }
          })
        })
      } else if (type === 'reasoning.complete') {
        flushStream(`${eventKey}\u0000thinking`)
        const itemId = `thinking-${String(payload.id || '')}`
        const error = Boolean(payload.error)
        const duration = typeof payload.elapsed_ms === 'number' ? payload.elapsed_ms : undefined
        updateView(workspace, current => ({
          ...current,
          items: current.items.map(item =>
            item.id === itemId && item.thinking
              ? {
                  ...item,
                  thinking: {
                    ...item.thinking,
                    duration: duration ?? item.thinking.duration,
                    ended: item.thinking.ended ?? Date.now(),
                    error: error || item.thinking.error || undefined
                  }
                }
              : item)
        }))
      } else if (type === 'message.delta') {
        const text = String(payload.text || '')
        if (!text) return
        let id = activeAssistants.current.get(eventKey)
        if (!id) {
          id = nextId('assistant')
          activeAssistants.current.set(eventKey, id)
        }
        const assistantId = id
        const streamKey = `${eventKey}\u0000assistant`
        streamAppend(streamKey, text, chunk => {
          if (!openProjects.current.has(pathKey(workspace))) return
          updateView(workspace, current => {
            const now = Date.now()
            let found = false
            const items = current.items.map(item => {
              if (item.kind === 'reasoning' && item.thinking && item.thinking.ended == null) {
                return { ...item, thinking: { ...item.thinking, ended: now } }
              }
              if (item.id === assistantId) {
                found = true
                return { ...item, streaming: true, text: item.text + chunk }
              }
              return item
            })
            return {
              ...current,
              items: found ? items : [...items, { id: assistantId, kind: 'assistant', streaming: true, text: chunk }]
            }
          })
        })
      } else if (type === 'message.suspended') {
        cancelledEventKeys.current.delete(eventKey)
        updateView(workspace, current => ({
          ...current,
          busy: false,
          cancelling: false
        }))
      } else if (type === 'message.complete') {
        cancelledEventKeys.current.delete(eventKey)
        flushStream(`${eventKey}\u0000assistant`)
        const text = String(payload.text || '')
        const metrics = (payload.metrics || {}) as Metrics
        const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts as ArtifactInfo[] : []
        const forkPoints = Array.isArray(payload.fork_points)
          ? payload.fork_points as Array<{ kind: string; message_index: number }>
          : []
        const verification = payload.verification as VerificationStatus | undefined
        const cutShort = stopReasonText(payload.status)
        const id = activeAssistants.current.get(eventKey)
        activeAssistants.current.delete(eventKey)
        updateView(workspace, current => {
          let items: TimelineItem[] = id
            ? current.items.map(item => item.id === id ? { ...item, artifacts, metrics, streaming: false, text: text || item.text } : item)
            : text ? [...current.items, { artifacts, id: nextId('assistant'), kind: 'assistant', metrics, text }] : current.items
          items = verification
            ? items.map(item => item.id === 'verification-status' ? { ...item, text: verificationLabel(verification) } : item)
            : items.filter(item => item.id !== 'verification-status')
          if (cutShort) {
            items = [...items, { id: nextId('stop'), kind: 'system', text: cutShort }]
          }
          const pendingForks = items.filter(item => item.kind === 'assistant' && item.forkIndex == null).length
          const forkOffset = Math.max(0, forkPoints.length - pendingForks)
          let assignedForks = 0
          items = items.map(item => {
            if (item.kind !== 'assistant' || item.forkIndex != null) return item
            const point = forkPoints[forkOffset + assignedForks]
            assignedForks += 1
            return point ? { ...item, forkIndex: point.message_index } : item
          })
          return {
            ...current,
            activeSession: sessionId || current.activeSession,
            busy: false,
            cancelling: false,
            items
          }
        })
        void Promise.all([
          refreshSessions(workspace),
          refreshCheckpoints(workspace),
          refreshSkills(workspace),
          refreshTree(workspace, sessionId)
        ]).catch(() => undefined)
      } else if (type === 'message.cancelled') {
        cancelledEventKeys.current.delete(eventKey)
        flushStream(`${eventKey}\u0000assistant`)
        activeAssistants.current.delete(eventKey)
        updateView(workspace, current => ({
          ...current,
          busy: false,
          cancelling: false,
          items: [
            ...current.items.filter(item => item.id !== 'verification-status'),
            { id: nextId('cancelled'), kind: 'system', text: 'Request stopped.' }
          ]
        }))
      } else if (type === 'session.updated') {
        if (typeof payload.running === 'boolean') {
          const running = payload.running
          updateView(workspace, current => current.busy === running
            ? current
            : { ...current, busy: running, ...(running ? {} : { cancelling: false }) })
        }
        void refreshSessions(workspace).catch(() => undefined)
      } else if (type === 'session.titled') {
        void refreshSessions(workspace).catch(() => undefined)
        void refreshTree(workspace).catch(() => undefined)
      } else if (type === 'permission.updated') {
        // Gateway-wide hot swap; may have been made from another view.
        const mode = String(payload.permission_mode || '') as PermissionMode
        if (['manual', 'auto', 'bypass'].includes(mode)) {
          updateView(workspace, current => ({ ...current, info: { ...current.info, permission_mode: mode } }))
        }
      } else if (type === 'message.steered') {
        updateView(workspace, current => ({
          ...current,
          items: [...current.items, {
            createdAt: new Date().toISOString(),
            id: nextId('steer'),
            kind: 'user',
            text: `\u21b3 ${String(payload.text || '')}`
          }]
        }))
      } else if (type === 'tool.start') {
        flushStream(`${eventKey}\u0000assistant`)
        const assistantId = activeAssistants.current.get(eventKey)
        // A tool round interrupts the reply stream, and the text so far is
        // transient narration: keeping it would concatenate every round's
        // partial text into one unreadable stream that the final answer then
        // replaces. Drop the partial bubble at each tool boundary so only the
        // final round's text ever renders.
        if (assistantId) activeAssistants.current.delete(eventKey)
        const tool: TimelineItem = {
          arguments: JSON.stringify(payload.arguments || {}, null, 2),
          id: nextId('tool'),
          kind: 'tool',
          name: String(payload.name || 'Tool'),
          status: 'running',
          text: '',
          toolCallId: String(payload.tool_call_id || '')
        }
        updateView(workspace, current => {
          const index = assistantId ? current.items.findIndex(item => item.id === assistantId) : -1
          const items = assistantId ? current.items.filter(item => item.id !== assistantId) : current.items
          return {
            ...current,
            items: index < 0
              ? [...items, tool]
              : [...items.slice(0, index), tool, ...items.slice(index)]
          }
        })
      } else if (type === 'tool.update') {
        const toolCallId = String(payload.tool_call_id || '')
        updateView(workspace, current => ({
          ...current,
          items: current.items.map(item =>
            item.kind === 'tool' && item.toolCallId === toolCallId && (item.status === 'running' || item.status === 'approval')
              ? { ...item, text: capText(String(payload.content || ''), MAX_TOOL_TEXT) }
              : item
          )
        }))
      } else if (type === 'tool.complete') {
        const toolCallId = String(payload.tool_call_id || '')
        const approval = payload.approval as Approval | undefined
        updateView(workspace, current => {
          const index = current.items.findLastIndex(
            item => item.kind === 'tool' && item.toolCallId === toolCallId && item.status === 'running'
          )
          const nextItems = [...current.items]
          if (index >= 0) {
            nextItems[index] = {
              ...nextItems[index],
              elapsed_ms: typeof payload.elapsed_ms === 'number' ? payload.elapsed_ms : nextItems[index].elapsed_ms,
              status: approval?.approval_required ? 'approval' : payload.error ? 'error' : 'done',
              text: capText(String(payload.content || nextItems[index].text), MAX_TOOL_TEXT)
            }
          }
          return {
            ...current,
            items: nextItems,
            pendingApproval: approval?.approval_required ? approval : current.pendingApproval
          }
        })
      } else if (type === 'approval.pending') {
        updateView(workspace, current => ({ ...current, busy: false, pendingApproval: payload as Approval }))
      } else if (type === 'approval.resolved') {
        updateView(workspace, current => ({
          ...current,
          busy: Boolean(payload.continued),
          guidance: '',
          pendingApproval: null,
          items: current.items.map(item => item.kind === 'tool' && item.status === 'approval'
            ? { ...item, status: payload.decision === 'approve' ? 'done' : 'error' }
            : item)
        }))
      } else if (type === 'verification.start') {
        updateView(workspace, current => ({
          ...current,
          items: [
            ...current.items.filter(item => item.id !== 'verification-status'),
            { id: 'verification-status', kind: 'system', text: t('verification.pending') }
          ]
        }))
      } else if (type === 'verification.complete') {
        updateView(workspace, current => ({
          ...current,
          items: payload.approval_required
            ? current.items.filter(item => item.id !== 'verification-status')
            : current.items.map(item => item.id === 'verification-status'
                ? { ...item, text: payload.passed ? t('verification.pass') : t('verification.continuing') }
                : item)
        }))
      } else if (type === 'context.compacted') {
        // Compaction rewrites history the user can still scroll back to, so it
        // gets its own line rather than being left to be inferred.
        const text = compactionText(payload as ContextCompaction)
        updateView(workspace, current => ({
          ...current,
          items: [...current.items, { id: nextId('context'), kind: 'system', text }]
        }))
      }
    }

    void (async () => {
      unlisten = await listen<[string, string]>('gateway-line', event => handleLine(event.payload[0], event.payload[1]))
      // A process this window stopped on purpose: housekeeping, so it reads as
      // an idle project rather than a crash. The gateway only emits this when
      // the exiting pid is the one we killed, so a project restarted while the
      // old process was shutting down is never misreported -- that restart owns
      // the state now.
      unlistenStopped = await listen<[string, string]>('gateway-stopped', event => {
        const [workspace] = event.payload
        const key = pathKey(workspace)
        if (!openProjects.current.has(key)) return
        if (startedProjects.current.has(key)) return
        updateView(workspace, current => ({ ...current, busy: false, status: 'idle' }))
      })
      unlistenExit = await listen<[string, string]>('gateway-exit', event => {
        const [workspace, detail] = event.payload
        const key = pathKey(workspace)
        startedProjects.current.delete(key)
        if (!openProjects.current.has(key)) return
        const reason = detail.trim() ? `\n${detail.trim().slice(-2000)}` : ''
        for (const [id, pending] of pendingRequests.current) {
          if (samePath(pending.workspace, workspace)) {
            pending.reject(new Error(`Friday gateway stopped.${reason}`))
            pendingRequests.current.delete(id)
          }
        }
        updateView(workspace, current => ({
          ...current,
          busy: false,
          items: [
            ...current.items,
            {
              id: nextId('gateway-exit'),
              kind: 'system',
              text: reason
                ? `Friday gateway stopped.${reason}`
                : 'Friday stopped. Select the project to restart it.'
            }
          ],
          status: 'error'
        }))
      })
      if (disposed) return
      const present = await presentProjects(initialProjects.current)
      if (disposed) return
      if (present.length !== initialProjects.current.length) {
        initialProjects.current = present
        projectsRef.current = present
        openProjects.current = new Set(present.map(pathKey))
        setProjects(present)
      }
      const saved = localStorage.getItem(ACTIVE_PROJECT_KEY) || ''
      const requested = initialProjects.current.find(path => samePath(path, saved)) || initialProjects.current[0]
      let trackedStartup = Boolean(requested)
      let workspace: string
      try {
        workspace = await invoke<string>('gateway_start', { workspace: requested || null })
      } catch {
        if (requested) setProjects(current => current.filter(path => !samePath(path, requested)))
        trackedStartup = false
        workspace = await invoke<string>('gateway_start', { workspace: null })
      }
      markStarted(workspace)
      openProjects.current.add(pathKey(workspace))
      setExpandedProjects(current => new Set(current).add(pathKey(workspace)))
      activeProjectRef.current = workspace
      setActiveProject(workspace)
      if (trackedStartup) rememberProject(workspace)
      else setDefaultWorkspace(workspace)
      await hydrateProject(workspace)
      // The project list used to live only in this window's local storage, so
      // a fresh profile (first launch of an installed build, cleared site
      // data) hid every previously tracked project. The gateway keeps a
      // registry; merge it in so tracked projects always show up.
      void sendGateway<{ projects: Array<{ workspace: string; updated?: string }> }>(workspace, 'projects.list')
        .then(result => {
          for (const item of result.projects) {
            // An untracked default workspace already lives under Recent.
            if (!trackedStartup && samePath(item.workspace, workspace)) continue
            rememberProject(item.workspace)
          }
        })
        .catch(() => undefined)
    })().catch(error => {
      const workspace = activeProjectRef.current
      if (workspace) {
        updateView(workspace, current => ({
          ...current,
          items: [...current.items, { id: nextId('startup'), kind: 'system', text: String(error) }],
          status: 'error'
        }))
      }
    }).finally(() => window.dispatchEvent(new Event('friday:ready')))

    return () => {
      disposed = true
      unlisten?.()
      unlistenExit?.()
      unlistenStopped?.()
      for (const pending of pendingRequests.current.values()) {
        pending.reject(new Error('Friday window closed.'))
      }
      pendingRequests.current.clear()
      try {
        void invoke('gateway_stop', { workspace: null }).catch(() => undefined)
      } catch {
        // The Tauri bridge may already be gone during window teardown.
      }
    }
  }, [])

  useEffect(() => {
    followOutput.current = true
  }, [activeProject, activeSession])

  useEffect(() => {
    if (followOutput.current && timeline.current) {
      timeline.current.scrollTop = timeline.current.scrollHeight
    }
  }, [activeProject, items])

  const queueDraft = () => {
    const text = draft.trim()
    if (!text) return
    const key = pathKey(activeProject)
    const queue = queuedTexts.current.get(key) ?? []
    queue.push(text)
    queuedTexts.current.set(key, queue)
    updateView(activeProject, current => ({
      ...current,
      draft: '',
      items: [...current.items, { id: nextId('queued'), kind: 'system', text: t('composer.queuedNotice', { text: text.slice(0, 80) }) }]
    }))
  }

  useEffect(() => {
    const key = pathKey(activeProject)
    const queue = queuedTexts.current.get(key)
    if (!queue?.length) return
    const view = viewsRef.current[key]
    if (!view || view.busy || view.pendingApproval || view.status !== 'ready') return
    const text = queue.shift()!
    // Mark the mirror immediately so a double-fired effect cannot double-send.
    viewsRef.current[key] = { ...view, busy: true }
    const userItemId = nextId('user')
    updateView(activeProject, current => ({
      ...current,
      busy: true,
      cancelling: false,
      items: [...current.items, { createdAt: new Date().toISOString(), id: userItemId, kind: 'user', text }]
    }))
    void sendGateway(activeProject, 'chat.send', { text }).catch(error => {
      updateView(activeProject, current => ({
        ...current,
        busy: false,
        items: [...current.items, { id: nextId('send'), kind: 'system', text: String(error) }]
      }))
    })
  })

  const submit = async (event?: FormEvent) => {
    event?.preventDefault()
    if (busy) {
      // A message sent mid-turn steers the running work; it is delivered
      // before the next model step. Attachments cannot ride a steer, so a
      // draft with attachments waits in the queue instead.
      const text = draft.trim()
      if (!text || pendingApproval || status !== 'ready') return
      if (attachments.length) {
        queueDraft()
        return
      }
      updateView(activeProject, current => ({ ...current, draft: '' }))
      const key = pathKey(activeProject)
      void sendGateway(activeProject, 'chat.steer', { text }).catch(() => {
        const queue = queuedTexts.current.get(key) ?? []
        queue.push(text)
        queuedTexts.current.set(key, queue)
      })
      return
    }
    const text = draft.trim() || (attachments.length ? t('composer.inspectAttachments') : '')
    if (!text || pendingApproval || status !== 'ready') return
    const submittedSession = activeSession
    const submittedGoal = goalMode
    const imageAttachments = attachments.filter((item): item is ImageAttachment => item.kind === 'image')
    const localAttachments = attachments.filter((item): item is LocalAttachment => item.kind !== 'image')

    followOutput.current = true
    const userItemId = nextId('user')
    const imageUrls = imageAttachments.map(item => item.dataUrl)
    if (imageUrls.length) writeMessageImages(submittedSession, userItemId, imageUrls)
    updateView(activeProject, current => ({
      ...current,
      attachments: [],
      busy: true,
      cancelling: false,
      draft: '',
      goalMode: false,
      items: [
        ...current.items,
        {
          attachments: localAttachments,
          createdAt: new Date().toISOString(),
          goal: submittedGoal,
          id: userItemId,
          images: imageUrls.map((_, index) => imageCacheKey(submittedSession, userItemId, index)),
          kind: 'user',
          text
        }
      ]
    }))
    try {
      await sendGateway(activeProject, submittedGoal ? 'goal.run' : 'chat.send', {
        attachments: localAttachments.map(item => ({ path: item.path })),
        images: imageUrls,
        text
      })
    } catch (error) {
      updateView(activeProject, current => current.activeSession !== submittedSession ? current : ({
          ...current,
          busy: false,
          cancelling: false,
          items: [...current.items, { id: nextId('send'), kind: 'system', text: String(error) }]
        }))
    }
  }

  const cancelRequest = () => {
    if (!busy || cancelling || !activeSession) return
    const eventKey = sessionEventKey(activeProject, activeSession)
    const now = Date.now()
    cancelledEventKeys.current.add(eventKey)
    dropStream(`${eventKey}\u0000assistant`)
    dropStream(`${eventKey}\u0000thinking`)
    updateView(activeProject, current => ({
      ...current,
      cancelling: true,
      items: current.items.map(item => item.kind === 'reasoning' && item.thinking?.ended == null
        ? { ...item, thinking: { ...item.thinking, started: item.thinking!.started, ended: now, error: true } }
        : item.kind === 'assistant' && item.streaming
          ? { ...item, streaming: false }
          : item)
    }))
    // Stop means stop everything: locally queued drafts must not auto-send
    // after the stop, and steers the turn never delivered come back from the
    // gateway. Both return to the composer so nothing typed is lost.
    const queueKey = pathKey(activeProject)
    const held = queuedTexts.current.get(queueKey) ?? []
    queuedTexts.current.delete(queueKey)
    void sendGateway<{ cancelled: boolean; dropped_steers?: string[] }>(activeProject, 'chat.cancel', { session_id: activeSession })
      .then(result => {
        const returned = [...(result.dropped_steers ?? []), ...held]
        if (returned.length) {
          updateView(activeProject, current => ({ ...current, draft: current.draft || returned.join('\n') }))
        }
        if (result.cancelled) return
        cancelledEventKeys.current.delete(eventKey)
        updateView(activeProject, current => ({ ...current, busy: false, cancelling: false }))
      })
      .catch(error => {
        cancelledEventKeys.current.delete(eventKey)
        updateView(activeProject, current => ({
          ...current,
          cancelling: false,
          items: [...current.items, { id: nextId('cancel'), kind: 'system', text: String(error) }]
        }))
      })
  }

  const changePermission = (mode: PermissionMode) => {
    const previous = info.permission_mode
    updateView(activeProject, current => ({ ...current, info: { ...current.info, permission_mode: mode } }))
    void sendGateway(activeProject, 'permission.set', { mode }).catch(error => {
      updateView(activeProject, current => ({
        ...current,
        info: { ...current.info, permission_mode: previous },
        items: [...current.items, { id: nextId('permission'), kind: 'system', text: String(error) }]
      }))
    })
  }

  const changeThinking = (effort: ThinkingEffort) => {
    const previous = info.thinking_effort
    updateView(activeProject, current => ({ ...current, info: { ...current.info, thinking_effort: effort } }))
    void sendGateway<{ info: SessionInfo }>(activeProject, 'thinking.set', { effort })
      .then(result => updateView(activeProject, current => ({ ...current, info: result.info })))
      .catch(error => {
        updateView(activeProject, current => ({
          ...current,
          info: { ...current.info, thinking_effort: previous },
          items: [...current.items, { id: nextId('thinking'), kind: 'system', text: String(error) }]
        }))
      })
  }

  const selectModel = (profileId: string) => {
    if (busy || profileId === info.model_profile) return
    void sendGateway<{ catalog: ModelCatalog; info: SessionInfo }>(activeProject, 'model.select', { id: profileId })
      .then(result => {
        updateView(activeProject, current => ({ ...current, info: result.info, models: result.catalog }))
      })
      .catch(error => updateView(activeProject, current => ({
        ...current,
        items: [...current.items, { id: nextId('model'), kind: 'system', text: String(error) }]
      })))
  }

  const saveModel = (
    profile: ModelDraft,
    apiKey: string
  ) => sendGateway<{ catalog: ModelCatalog; info: SessionInfo }>(activeProject, 'model.save', {
    activate: false,
    api_key: apiKey,
    profile
  }).then(result => {
    updateView(activeProject, current => ({ ...current, info: result.info, models: result.catalog }))
    return result.catalog
  })

  const revealModelKey = (target: ModelTarget) => sendGateway<{ api_key: string }>(
    activeProject,
    'model.key.get',
    target
  ).then(result => result.api_key)

  const refreshProviderModels = (target: ModelTarget) => sendGateway<{
    catalog: ModelCatalog
    info: SessionInfo
    models: string[]
  }>(activeProject, 'model.refresh', target).then(result => {
    updateView(activeProject, current => ({ ...current, info: result.info, models: result.catalog }))
    return { catalog: result.catalog, models: result.models }
  })

  const clearModelKey = (target: ModelTarget) => sendGateway<{ catalog: ModelCatalog; info: SessionInfo }>(
    activeProject,
    'model.key.clear',
    target
  ).then(result => {
    updateView(activeProject, current => ({ ...current, info: result.info, models: result.catalog }))
    return result.catalog
  })

  const setProviderEnabled = (target: ModelTarget, enabled: boolean) => sendGateway<{
    catalog: ModelCatalog
    info: SessionInfo
  }>(activeProject, 'model.enabled.set', { ...target, enabled }).then(result => {
    updateView(activeProject, current => ({ ...current, info: result.info, models: result.catalog }))
    return result.catalog
  })

  const deleteModel = (profileId: string) => sendGateway<{ catalog: ModelCatalog; info: SessionInfo }>(
    activeProject,
    'model.delete',
    { id: profileId }
  ).then(result => {
    updateView(activeProject, current => ({ ...current, info: result.info, models: result.catalog }))
    return result.catalog
  })

  const settingsWorkspace = activeProject || defaultWorkspace

  const changeLanguage = (next: Language) => {
    setLanguage(next)
    setLanguageState(next)
  }
  const loadSettings = () => sendGateway<AppSettings>(settingsWorkspace, 'settings.get')
  const saveWebSettings = (value: Record<string, unknown>) =>
    sendGateway<WebSearchSettings>(settingsWorkspace, 'settings.web.save', value)
  const saveCompactionSettings = (value: CompactionSettings) =>
    sendGateway<CompactionSettings>(settingsWorkspace, 'settings.compaction.save', value)
  const compactConversation = () =>
    sendGateway<{ text: string }>(settingsWorkspace, 'session.compact')
  const revealWebKey = (provider: string) => sendGateway<{ api_key: string }>(
    settingsWorkspace,
    'settings.web.key.get',
    { provider }
  ).then(result => result.api_key)
  const saveUserProfile = (profile: Partial<UserProfileSettings>) =>
    sendGateway<UserProfileSettings>(settingsWorkspace, 'settings.user.save', { profile })
  const readMemoryFile = (file: MemoryFileScope) =>
    sendGateway<MemoryFileDetail>(settingsWorkspace, 'settings.memory.read', { file })
  const saveMemoryFileContent = (file: MemoryFileScope, content: string) =>
    sendGateway<MemoryFileInfo>(settingsWorkspace, 'settings.memory.save', { content, file })
  // Stable identity: the plugins pane fetches from an effect keyed on this.
  const listPlugins = useCallback(
    () => sendGateway<{ plugins: PluginInfo[] }>(settingsWorkspace, 'plugin.list'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settingsWorkspace]
  )
  const togglePlugin = (name: string, enabled: boolean) =>
    sendGateway<{ plugins: PluginInfo[] }>(settingsWorkspace, 'plugin.toggle', { enabled, name })

  const resolveApproval = (method: string, params: Record<string, unknown> = {}) => {
    const approval = pendingApproval
    updateView(activeProject, current => ({ ...current, busy: true, pendingApproval: null }))
    void sendGateway(activeProject, method, params).catch(error => {
      updateView(activeProject, current => ({
        ...current,
        busy: false,
        pendingApproval: approval,
        items: [...current.items, { id: nextId('approval'), kind: 'system', text: String(error) }]
      }))
    })
  }

  const startNewSessionAt = (workspace: string) => {
    if (!workspace) return Promise.resolve()
    setPage('chat')
    updateView(workspace, value => ({ ...value, busy: true, cancelling: false }))
    return sendGateway<{ history: HistoryItem[]; info: SessionInfo }>(workspace, 'session.new').then(result => {
      updateView(workspace, value => ({
        ...value,
        activeSession: result.info.session_id || '',
        attachments: [],
        busy: false,
        cancelling: false,
        checkpoints: [],
        forkTree: { nodes: [], root: '' },
        goalMode: false,
        info: result.info,
        items: timelineFromHistory(result.history, result.info.session_id || ''),
        pendingApproval: null
      }))
      return refreshSessions(workspace)
    }).catch(error => {
      updateView(workspace, value => ({
        ...value,
        busy: false,
        cancelling: false,
        items: [...value.items, { id: nextId('session'), kind: 'system', text: String(error) }]
      }))
    })
  }

  const addProjectSession = (event: MouseEvent, workspace: string) => {
    event.stopPropagation()
    void (async () => {
      if (!samePath(workspace, activeProject)) await selectProject(workspace)
      setExpandedProjects(current => new Set(current).add(pathKey(workspace)))
      await startNewSessionAt(workspace)
    })()
  }

  const addDefaultSession = (event: MouseEvent) => {
    event.stopPropagation()
    void (async () => {
      let workspace = defaultWorkspace
      if (!workspace || !samePath(workspace, activeProject)) {
        workspace = await selectWorkspace() || ''
      }
      if (workspace) {
        setExpandedProjects(current => new Set(current).add(pathKey(workspace)))
        await startNewSessionAt(workspace)
      }
    })()
  }

  const resumeSession = async (workspace: string, session: ResumeChoice) => {
    const projectView = views[workspace] || emptyView(workspace)
    setPage('chat')
    if (!samePath(workspace, activeProject)) {
      const resolved = await selectWorkspace(workspace, projects.some(path => samePath(path, workspace)))
      if (!resolved) return
    }
    if (session.id === projectView.activeSession) return
    updateView(workspace, current => ({ ...current, busy: true }))
    void sendGateway<{ history: HistoryItem[]; info: SessionInfo }>(workspace, 'session.resume', { id: session.id }).then(result => {
      updateView(workspace, current => ({
        ...current,
        activeSession: result.info.session_id || '',
        busy: Boolean(result.info.running),
        info: result.info,
        items: timelineFromHistory(result.history, result.info.session_id || ''),
        pendingApproval: result.info.approval?.pending ? result.info.approval : null
      }))
      void Promise.all([refreshCheckpoints(workspace), refreshTree(workspace, session.id)]).catch(() => undefined)
    }).catch(error => {
      updateView(workspace, current => ({
        ...current,
        busy: false,
        items: [...current.items, { id: nextId('resume'), kind: 'system', text: String(error) }]
      }))
    })
  }

  const selectWorkspace = async (workspace?: string, tracked = false, expand = true) => {
    const known = workspace
      ? projects.find(path => samePath(path, workspace)) || workspace
      : defaultWorkspace
    const wasStarted = Boolean(known && startedProjects.current.has(pathKey(known)))
    setPage('chat')
    if (known) {
      activeProjectRef.current = known
      setActiveProject(known)
      updateView(known, current => ({ ...current, status: wasStarted ? current.status : 'connecting' }))
    }
    try {
      const resolved = await invoke<string>('gateway_start', { workspace: workspace || null })
      const resumeId = reapedSessions.current.get(pathKey(resolved))
      reapedSessions.current.delete(pathKey(resolved))
      markStarted(resolved)
      openProjects.current.add(pathKey(resolved))
      if (tracked) rememberProject(resolved)
      else setDefaultWorkspace(resolved)
      if (expand) setExpandedProjects(current => new Set(current).add(pathKey(resolved)))
      activeProjectRef.current = resolved
      setActiveProject(resolved)
      if (!wasStarted || !views[resolved]) await hydrateProject(resolved, resumeId)
      return resolved
    } catch (error) {
      // A deleted folder fails here as a bare OS path error, which tells the user
      // nothing they can act on. Check the folder itself: if it is gone the
      // project cannot be opened again, so take it out rather than reporting it.
      if (known && !(await directoryExists(known))) {
        await dropMissingProject(known)
        return undefined
      }
      if (known) {
        updateView(known, current => ({
          ...current,
          items: [...current.items, { id: nextId('workspace'), kind: 'system', text: String(error) }],
          status: 'error'
        }))
      }
      return undefined
    }
  }

  const selectProject = (workspace: string) => selectWorkspace(workspace, true)
  selectProjectRef.current = selectProject

  useEffect(() => {
    let disposed = false
    let unlisten: UnlistenFn | undefined
    void getCurrentWindow().onDragDropEvent(event => {
      const { payload } = event
      if (payload.type === 'enter') {
        setProjectDropActive(true)
      } else if (payload.type === 'leave') {
        setProjectDropActive(false)
      } else if (payload.type === 'drop') {
        setProjectDropActive(false)
        const dropped = payload.paths[0]
        if (!dropped) return
        void invoke<string>('resolve_directory', { path: dropped })
          .then(path => selectProjectRef.current(path))
          .catch(() => undefined)
      }
    }).then(stop => {
      if (disposed) stop()
      else unlisten = stop
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  const toggleProject = (workspace: string) => {
    const key = pathKey(workspace)
    setExpandedProjects(current => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    if (!samePath(workspace, activeProject)) void selectWorkspace(workspace, true, false)
  }

  const addProject = async () => {
    const selected = await open({
      defaultPath: isDefaultWorkspace ? undefined : activeProject || undefined,
      directory: true,
      multiple: false,
      title: 'Add Friday project'
    })
    if (!selected || Array.isArray(selected)) return
    await selectProject(selected)
  }

  const addLocalAttachments = (paths: string[], kind: LocalAttachment['kind']) => {
    updateView(activeProject, current => {
      const existing = new Set(
        current.attachments
          .filter((item): item is LocalAttachment => item.kind !== 'image')
          .map(item => pathKey(item.path))
      )
      const added = paths
        .map(path => localAttachment(path, kind))
        .filter(item => {
          const key = pathKey(item.path)
          if (existing.has(key)) return false
          existing.add(key)
          return true
        })
      const slots = MAX_LOCAL_ATTACHMENTS - current.attachments.filter(item => item.kind !== 'image').length
      return {
        ...current,
        attachments: [...current.attachments, ...added.slice(0, Math.max(0, slots))],
        items: added.length > slots
          ? [...current.items, { id: nextId('attachment'), kind: 'system', text: t('composer.attachmentLimit') }]
          : current.items
      }
    })
  }

  const chooseFiles = async () => {
    const selected = await open({ directory: false, multiple: true, title: t('composer.addFiles') })
    if (!selected) return
    addLocalAttachments(Array.isArray(selected) ? selected : [selected], 'file')
  }

  const chooseFolder = async () => {
    const selected = await open({ directory: true, multiple: false, title: t('composer.addFolder') })
    if (!selected || Array.isArray(selected)) return
    addLocalAttachments([selected], 'folder')
  }

  /** Take a project out of this window, and say where the user ended up. */
  const dropProject = async (workspace: string, reason = 'Project closed.') => {
    const key = pathKey(workspace)
    openProjects.current.delete(key)
    startedProjects.current.delete(key)
    activeSessions.current.delete(key)
    // Keyed per session, not per project, so a plain delete of the project key
    // matched nothing and left an entry behind for every turn a close interrupted.
    for (const entry of [...activeAssistants.current.keys()]) {
      if (entry.startsWith(`${key}::`)) activeAssistants.current.delete(entry)
    }
    lastUsed.current.delete(key)
    reapedSessions.current.delete(key)
    setExpandedProjects(current => {
      const next = new Set(current)
      next.delete(key)
      return next
    })
    for (const [id, pending] of pendingRequests.current) {
      if (samePath(pending.workspace, workspace)) {
        pending.reject(new Error(reason))
        pendingRequests.current.delete(id)
      }
    }
    const remaining = projectsRef.current.filter(path => !samePath(path, workspace))
    projectsRef.current = remaining
    setProjects(remaining)
    setViews(current => {
      const next = { ...current }
      for (const path of Object.keys(next)) {
        if (samePath(path, workspace)) delete next[path]
      }
      return next
    })

    // The ref, not the state: a drop that lands on another missing project drops
    // that one too, and the closure's copy still names the project already gone.
    if (!samePath(activeProjectRef.current, workspace)) return activeProjectRef.current
    return remaining[0] ? await selectProject(remaining[0]) : await selectWorkspace()
  }

  /** A project whose folder is gone cannot be opened, so stop carrying it. */
  const dropMissingProject = async (workspace: string) => {
    const landed = (await dropProject(workspace, 'Project folder is gone.')) || activeProjectRef.current
    if (landed) {
      updateView(landed, current => ({
        ...current,
        items: [...current.items, { id: nextId('missing-project'), kind: 'system', text: t('project.missing', { name: projectLabel(workspace) }) }]
      }))
    }
  }

  const closeProject = async (event: MouseEvent, workspace: string) => {
    event.stopPropagation()
    try {
      // Record the close in the shared registry, or the next launch shows the
      // project again. Route it through a gateway that is already running:
      // sendGateway starts one on demand, and starting a gateway for the
      // project being closed would boot a whole backend to mark it closed --
      // and mark it open on the way in.
      const host = startedProjects.current.has(pathKey(workspace)) ? workspace : activeProject || workspace
      await sendGateway(host, 'projects.close', { workspace }).catch(() => undefined)
      await invoke('gateway_stop', { workspace })
    } catch (error) {
      updateView(workspace, current => ({
        ...current,
        items: [...current.items, { id: nextId('close-project'), kind: 'system', text: String(error) }]
      }))
      return
    }
    await dropProject(workspace)
  }

  const beginRenameConversation = (event: MouseEvent, workspace: string, session: ResumeChoice) => {
    event.stopPropagation()
    const title = sessionLabel(session)
    setRenaming({ id: session.id, original: title, title, workspace })
  }

  const commitRenameConversation = (workspace: string, session: ResumeChoice, value: string) => {
    if (renaming?.id !== session.id || !samePath(renaming.workspace, workspace)) return
    const title = value.trim()
    setRenaming(null)
    if (!title || title === renaming.original) return
    void sendGateway(workspace, 'session.rename', { id: session.id, title })
      .then(() => refreshSessions(workspace))
      .catch(error => updateView(workspace, current => ({
        ...current,
        items: [...current.items, { id: nextId('rename'), kind: 'system', text: String(error) }]
      })))
  }

  const deleteConversation = (event: MouseEvent, workspace: string, session: ResumeChoice) => {
    event.stopPropagation()
    if (!window.confirm(t('sidebar.deleteConfirm', { title: sessionLabel(session) }))) return
    void sendGateway<{ deleted: string[]; history: HistoryItem[]; info: SessionInfo }>(workspace, 'session.delete', { id: session.id })
      .then(result => {
        updateView(workspace, current => result.deleted.includes(current.activeSession)
          ? {
              ...current,
              activeSession: result.info.session_id || '',
              attachments: [],
              goalMode: false,
              checkpoints: [],
              info: result.info,
              items: timelineFromHistory(result.history, result.info.session_id || ''),
              pendingApproval: null
            }
          : current)
        return Promise.all([refreshSessions(workspace), refreshCheckpoints(workspace), refreshTree(workspace, result.info.session_id)])
      })
      .catch(error => updateView(workspace, current => ({
        ...current,
        items: [...current.items, { id: nextId('delete'), kind: 'system', text: String(error) }]
      })))
  }

  const restoreCheckpoint = useCallback((checkpointId: string) => {
    if (busy || !checkpointId) return
    updateView(activeProject, current => ({ ...current, busy: true }))
    void sendGateway<{
      history: HistoryItem[]
      info: SessionInfo
    }>(activeProject, 'checkpoint.undo', { id: checkpointId }).then(result => {
      updateView(activeProject, current => ({
        ...current,
        activeSession: result.info.session_id || '',
        busy: false,
        info: result.info,
        items: timelineFromHistory(result.history, result.info.session_id || ''),
        pendingApproval: result.info.approval?.pending ? result.info.approval : null
      }))
      return Promise.all([refreshSessions(activeProject), refreshCheckpoints(activeProject)])
    }).catch(error => {
      updateView(activeProject, current => ({
        ...current,
        busy: false,
        items: [...current.items, { id: nextId('checkpoint'), kind: 'system', text: String(error) }]
      }))
    })
  }, [busy])

  const forkConversation = useCallback((messageIndex: number) => {
    if (busy || messageIndex < 0 || !activeSession) return
    updateView(activeProject, current => ({ ...current, busy: true }))
    void sendGateway<{ history: HistoryItem[]; info: SessionInfo; tree: ForkTree }>(activeProject, 'session.fork', {
      id: activeSession,
      message_index: messageIndex
    }).then(result => {
      updateView(activeProject, current => ({
        ...current,
        activeSession: result.info.session_id || '',
        busy: false,
        checkpoints: [],
        forkTree: result.tree,
        info: result.info,
        items: timelineFromHistory(result.history, result.info.session_id || ''),
        pendingApproval: null
      }))
      return refreshSessions(activeProject)
    }).catch(error => {
      updateView(activeProject, current => ({
        ...current,
        busy: false,
        items: [...current.items, { id: nextId('fork'), kind: 'system', text: String(error) }]
      }))
    })
  }, [busy, activeSession])

  const openForkNode = (node: ForkNode) => {
    void resumeSession(activeProject, {
      assistant: '', id: node.id, objective: '', status: '', time: node.time, title: node.title, turns: '', user: ''
    })
  }

  const deleteForkNode = (node: ForkNode) => {
    if (!window.confirm(`Delete "${node.title}" and its branches?`)) return
    const fallback = treeContains(forkTree, node.id, activeSession)
      ? forkTree.nodes.find(item => item.id === node.parent)
      : undefined
    void sendGateway<{ deleted: string[]; history: HistoryItem[]; info: SessionInfo }>(activeProject, 'session.delete', { id: node.id })
      .then(result => {
        if (fallback) {
          openForkNode(fallback)
          return
        }
        updateView(activeProject, current => ({
          ...current,
          activeSession: result.info.session_id || '',
          busy: Boolean(result.info.running),
          forkTree: { nodes: [], root: '' },
          info: result.info,
          items: timelineFromHistory(result.history, result.info.session_id || ''),
          pendingApproval: null
        }))
        return Promise.all([refreshSessions(activeProject), refreshTree(activeProject, result.info.session_id)])
      })
      .catch(error => updateView(activeProject, current => ({
        ...current,
        items: [...current.items, { id: nextId('fork-delete'), kind: 'system', text: String(error) }]
      })))
  }

  const openSkill = (skill: SkillInfo) => {
    setSkillError('')
    void sendGateway<SkillDetail>(activeProject, 'skill.get', { path: skill.path })
      .then(setSkillDetail)
      .catch(error => setSkillError(String(error)))
  }

  const loadArtifact = useCallback(
    (artifact: ArtifactInfo) => sendGateway<ArtifactDetail>(activeProject, 'artifact.get', { path: artifact.path }),
    [activeProject]
  )

  const openArtifact = useCallback((artifact: ArtifactInfo) => {
    void loadArtifact(artifact)
      .then(setArtifactPreview)
      .catch(error => updateView(activeProject, current => ({
        ...current,
        items: [...current.items, { id: nextId('artifact'), kind: 'system', text: String(error) }]
      })))
  }, [loadArtifact])

  const openObservability = () => {
    if (!activeProject) return
    void sendGateway<{ url: string }>(activeProject, 'trace.serve')
      .then(result => {
        if (result.url) openLinkExternally(result.url)
      })
      .catch(error => {
        updateView(activeProject, current => ({
          ...current,
          items: [...current.items, { id: nextId('trace'), kind: 'system', text: String(error) }]
        }))
      })
  }

  const selectedSession = sessions.find(session => session.id === activeSession)
  const selectedFork = forkTree.nodes.find(node => node.id === activeSession)
  const conversationTitle = selectedSession ? sessionLabel(selectedSession) : selectedFork?.title || t('conversation.new')
  const project = isDefaultWorkspace ? t('project.personal') : projectLabel(activeProject)
  const permission = permissionOptions.find(option => option.value === info.permission_mode) || permissionOptions.find(option => option.value === 'manual')!
  const availableThinkingOptions = thinkingOptions.filter(option => info.thinking_options?.includes(option.value))
  const thinking = thinkingOptions.find(option => option.value === info.thinking_effort) || thinkingOptions[0]
  const selectedModel = models.profiles.find(profile => profile.id === info.model_profile)

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      if (busy && (event.metaKey || event.ctrlKey)) {
        queueDraft()
        return
      }
      void submit()
    }
  }

  const autosizeComposer = () => {
    const el = composerRef.current
    if (!el) return
    // Measure the real content height; the CSS max-height caps it and turns
    // the overflow into an internal scroll.
    el.style.height = '0px'
    el.style.height = `${el.scrollHeight}px`
  }

  useEffect(() => {
    autosizeComposer()
  }, [draft])

  const startSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    sidebarDrag.current = { startWidth: sidebarWidth, startX: event.clientX }
    event.currentTarget.setPointerCapture(event.pointerId)
    setResizingSidebar(true)
  }

  const moveSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!sidebarDrag.current) return
    setSidebarWidth(clampSidebarWidth(sidebarDrag.current.startWidth + event.clientX - sidebarDrag.current.startX))
  }

  const stopSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!sidebarDrag.current) return
    sidebarDrag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    setResizingSidebar(false)
  }

  const toggleSection = (section: SidebarSection) =>
    setCollapsedSections(current => {
      const next = new Set(current)
      if (!next.delete(section)) next.add(section)
      return next
    })

  const renderSectionHeading = (section: SidebarSection, label: string, icon: ReactNode) => (
    <button
      aria-expanded={!collapsedSections.has(section)}
      className="section-toggle"
      onClick={() => toggleSection(section)}
      type="button"
    >
      {icon}
      <h2>{label}</h2>
      <svg aria-hidden="true" className="section-chevron" fill="none" viewBox="0 0 24 24">
        <path d="M9 5.5 15.5 12 9 18.5" />
      </svg>
    </button>
  )

  const renderSessions = (workspace: string) => {
    const projectView = views[workspace] || emptyView(workspace)
    return renderSessionList(workspace, projectView.sessions)
  }

  const renderSessionList = (workspace: string, sessions: ResumeChoice[]) => {
    const isCurrent = samePath(workspace, activeProject)
    const isRenaming = (session: ResumeChoice) =>
      renaming?.id === session.id && samePath(renaming.workspace, workspace)
    return sessions.length ? sessions.map(session => (
    <div className={`session-entry ${isCurrent && session.id === activeSession ? 'active' : ''} ${isRenaming(session) ? 'renaming' : ''}`} key={session.id}>
      {isRenaming(session) ? (
        <div className="session-main">
          <input
            aria-label="Conversation name"
            autoFocus
            onBlur={event => commitRenameConversation(workspace, session, event.currentTarget.value)}
            onChange={event => setRenaming(current => current ? { ...current, title: event.target.value } : null)}
            onFocus={event => event.currentTarget.select()}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'Enter') event.currentTarget.blur()
              if (event.key === 'Escape') {
                event.currentTarget.value = renaming?.original || ''
                event.currentTarget.blur()
              }
            }}
            value={renaming?.title || ''}
          />
          <small>{session.running ? 'Working…' : `${formatSessionTime(session.time)} · ${session.turns} turns`}</small>
        </div>
      ) : (
        <button className="session-main" onClick={() => void resumeSession(workspace, session)} type="button">
          <span>{sessionLabel(session)}</span>
          <small>{session.running ? 'Working…' : `${formatSessionTime(session.time)} · ${session.turns} turns`}</small>
        </button>
      )}
      <div className="session-actions">
        <button aria-label={t('sidebar.rename')} onClick={event => beginRenameConversation(event, workspace, session)} title={t('sidebar.rename')} type="button">
          <PencilIcon />
        </button>
        <button aria-label="Delete conversation" onClick={event => deleteConversation(event, workspace, session)} title="Delete" type="button">
          <CloseIcon />
        </button>
      </div>
    </div>
    )) : <div className="empty-sessions">{t('sidebar.empty')}</div>
  }

  const timelineItems = useMemo(() => bindCheckpoints(items, checkpoints, activeSession), [items, checkpoints, activeSession])
  const sourcesByMessage = useMemo(() => collectMessageSources(timelineItems), [timelineItems])
  const groupedTimeline = useMemo(() => groupActivityItems(timelineItems), [timelineItems])
  // A brand-new session always carries a session id from the backend, so the
  // welcome hint keys off the conversation being empty rather than unnamed:
  // it shows on first launch, on a fresh session, and on resuming a session
  // that never received a message.
  const showWelcome = status === 'ready' && !timelineItems.length && !pendingApproval && !busy

  return (
    <div className="desktop-window">
      <WindowTitlebar />
      <div
        className={`app-shell ${resizingSidebar ? 'resizing' : ''}`}
        style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}
      >
        <aside className="sidebar">
          <nav className="sidebar-nav">
            <button
              className={page === 'skills' ? 'active' : ''}
              onClick={() => {
                setPage('skills')
                setSkillDetail(null)
                setSkillError('')
              }}
              type="button"
            >
              <svg aria-hidden="true" className="nav-icon" fill="none" viewBox="0 0 24 24">
                <path d="M12 22v-5M9 8V2M15 8V2M18 8v5a6 6 0 0 1-12 0V8Z" />
              </svg>
              <span>{t('nav.skills')}</span>
            </button>
            <button
              disabled={!activeProject}
              onClick={openObservability}
              title={t('nav.observability')}
              type="button"
            >
              <svg aria-hidden="true" className="nav-icon" fill="none" viewBox="0 0 24 24">
                <path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              <span>{t('nav.observability')}</span>
            </button>
          </nav>

          <div className="sidebar-tree">
            <section className={`sidebar-section projects ${collapsedSections.has('projects') ? 'collapsed' : ''}`}>
              <div className="section-heading">
                {renderSectionHeading('projects', t('sidebar.projects'), <ProjectsIcon />)}
                <button aria-label={t('sidebar.addProject')} onClick={() => void addProject()} title={t('sidebar.addProject')} type="button"><PlusIcon /></button>
              </div>
              <div aria-hidden={collapsedSections.has('projects')} className="section-body" inert={collapsedSections.has('projects')}>
                <div className="section-body-content">
                  {projects.map(path => {
                    const projectView = views[path]
                    const isActive = samePath(path, activeProject)
                    const isExpanded = expandedProjects.has(pathKey(path))
                    return (
                      <div className={`project-group ${isExpanded ? 'expanded' : ''}`} key={path}>
                        <div className={`project-entry ${isActive && !activeSession ? 'active' : ''}`}>
                          <button className="project-main" onClick={() => toggleProject(path)} title={path} type="button">
                            <FolderIcon className={projectView?.busy ? 'busy' : projectView?.status || ''} open={isExpanded} />
                            <span>{projectLabel(path)}</span>
                          </button>
                          <div className="project-actions">
                            <button
                              aria-label={`${t('sidebar.newConversation')} · ${projectLabel(path)}`}
                              disabled={isActive && status !== 'ready'}
                              onClick={event => addProjectSession(event, path)}
                              title={t('sidebar.newConversation')}
                              type="button"
                            >
                              <PlusIcon />
                            </button>
                            <button
                              aria-label={`${t('sidebar.closeProject')} · ${projectLabel(path)}`}
                              className="project-close"
                              onClick={event => void closeProject(event, path)}
                              title={t('sidebar.closeProject')}
                              type="button"
                            >
                              <CloseIcon />
                            </button>
                          </div>
                        </div>
                        <div aria-hidden={!isExpanded} className="nested-sessions" inert={!isExpanded}>
                          <div className="nested-sessions-content">{renderSessions(path)}</div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </section>

            <section className={`sidebar-section conversation-space ${collapsedSections.has('recent') ? 'collapsed' : ''}`}>
              <div className="section-heading">
                {renderSectionHeading('recent', t('sidebar.recent'), <ClockIcon />)}
                <button
                  aria-label={t('sidebar.newConversation')}
                  disabled={isDefaultWorkspace && status !== 'ready'}
                  onClick={addDefaultSession}
                  title={t('sidebar.newConversation')}
                  type="button"
                >
                  <PlusIcon />
                </button>
              </div>
              <div aria-hidden={collapsedSections.has('recent')} className="section-body" inert={collapsedSections.has('recent')}>
                <div className="section-body-content">{defaultWorkspace && renderSessions(defaultWorkspace)}</div>
              </div>
            </section>
          </div>

          <div className="sidebar-footer">
            <button
              className={`sidebar-status ${page === 'settings' ? 'active' : ''}`}
              disabled={!settingsWorkspace}
              onClick={() => {
                if (page === 'settings') setPage('chat')
                else {
                  setSettingsSection('general')
                  setPage('settings')
                }
              }}
              title={t('sidebar.settings')}
              type="button"
            >
              <span className={`status-dot ${status}`} />
              <span className="sidebar-status-copy">
                <strong>{t('sidebar.settings')}</strong>
              </span>
              <ChevronIcon className="footer-chevron" />
            </button>
            <button
              aria-label={theme === 'dark' ? t('theme.toLight') : t('theme.toDark')}
              aria-pressed={theme === 'dark'}
              className="theme-toggle"
              onClick={() => setTheme(current => current === 'dark' ? 'light' : 'dark')}
              title={theme === 'dark' ? t('theme.toLight') : t('theme.toDark')}
              type="button"
            >
              {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
            </button>
          </div>
        </aside>

        <div
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuenow={sidebarWidth}
          className="sidebar-resizer"
          onKeyDown={event => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            setSidebarWidth(current => clampSidebarWidth(current + (event.key === 'ArrowRight' ? 12 : -12)))
          }}
          onPointerCancel={stopSidebarResize}
          onPointerDown={startSidebarResize}
          onPointerMove={moveSidebarResize}
          onPointerUp={stopSidebarResize}
          role="separator"
          tabIndex={0}
        />

        <main className={`workspace ${forkTree.nodes.length > 1 ? 'has-forks' : ''}`}>
        {page === 'settings' ? (
          <SettingsPage
            catalog={models}
            initialSection={settingsSection}
            language={language}
            onCompact={compactConversation}
            onClose={() => setPage('chat')}
            onClearKey={clearModelKey}
            onEnable={setProviderEnabled}
            onLanguageChange={changeLanguage}
            onListPlugins={listPlugins}
            onLoad={loadSettings}
            onReadMemory={readMemoryFile}
            onRefreshModels={refreshProviderModels}
            onRevealKey={revealModelKey}
            onRevealWebKey={revealWebKey}
            onDelete={deleteModel}
            onSave={saveModel}
            onSaveCompaction={saveCompactionSettings}
            onSaveMemory={saveMemoryFileContent}
            onSaveProfile={saveUserProfile}
            onSaveWeb={saveWebSettings}
            onTogglePlugin={togglePlugin}
          />
        ) : page === 'skills' ? (
          <SkillBrowser
            detail={skillDetail}
            error={skillError}
            onClose={() => setSkillDetail(null)}
            onOpen={openSkill}
            onOpenLink={openLinkExternally}
            onQueryChange={setSkillQuery}
            query={skillQuery}
            skills={skills}
          />
        ) : (
        <>
        <header className="topbar">
          <div className="conversation-heading">
            <h1>{conversationTitle}</h1>
            <p>{project}</p>
          </div>
        </header>

        <section
          className={`timeline ${showWelcome ? 'empty' : ''}`}
          aria-live="polite"
          onWheel={event => {
            if (event.deltaY < 0) followOutput.current = false
          }}
          onScroll={event => {
            const viewport = event.currentTarget
            followOutput.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 12
          }}
          ref={timeline}
        >
          {showWelcome && <WelcomePrompt key={`${activeProject}::${activeSession}`} />}
          {!showWelcome && groupedTimeline.map(item => Array.isArray(item)
            ? item.length === 1
              ? <TimelineRow busy={busy} item={item[0]!} key={item[0]!.id} onFork={forkConversation} onLoadArtifact={loadArtifact} onOpenArtifact={openArtifact} onOpenLink={openLinkExternally} onPreview={setPreviewImage} onRestore={restoreCheckpoint} sources={sourcesByMessage.get(item[0]!.id)} />
              : <ActivityGroup items={item} key={`activity-${item[0]!.id}`} onOpenLink={openLinkExternally} />
            : <TimelineRow busy={busy} item={item} key={item.id} onFork={forkConversation} onLoadArtifact={loadArtifact} onOpenArtifact={openArtifact} onOpenLink={openLinkExternally} onPreview={setPreviewImage} onRestore={restoreCheckpoint} sources={sourcesByMessage.get(item.id)} />)}
          {pendingApproval && (
            <section className="approval-panel">
              <strong>{t('approval.title')}</strong>
              <code>{pendingApproval.command || t('approval.pendingCommand')}</code>
              {pendingApproval.reason && <p>{pendingApproval.reason}</p>}
              <div className="approval-actions">
                <button onClick={() => resolveApproval('approval.approve')} type="button">{t('approval.once')}</button>
                <button onClick={() => resolveApproval('approval.approve', { session: true })} type="button">{t('approval.session')}</button>
                <button className="reject" onClick={() => resolveApproval('approval.reject')} type="button">{t('approval.reject')}</button>
              </div>
              <div className="approval-guidance">
                <input
                  aria-label={t('approval.guidance')}
                  onChange={event => updateView(activeProject, current => ({ ...current, guidance: event.target.value }))}
                  placeholder={t('approval.guidance')}
                  value={guidance}
                />
                <button
                  disabled={!guidance.trim()}
                  onClick={() => resolveApproval('approval.instruct', { text: guidance.trim() })}
                  type="button"
                >
                  {t('approval.send')}
                </button>
              </div>
            </section>
          )}
          {busy && !activeAssistants.current.get(sessionEventKey(activeProject, activeSession)) && (
            <div className="thinking"><span /><span /><span /> {t('composer.working')}</div>
          )}
        </section>

        <form className="composer" onSubmit={submit}>
          {attachments.length > 0 && (
            <div className="composer-attachments">
              {attachments.map((item, index) => (
                <div className={`composer-attachment ${item.kind}`} key={`${item.kind}-${item.name}-${index}`}>
                  {item.kind === 'image' ? (
                    <img alt={item.name} src={item.dataUrl} />
                  ) : (
                    <>
                      <span className="attachment-icon">{item.kind === 'folder' ? <FileFolderIcon /> : <FileIcon />}</span>
                      <span className="attachment-copy">
                        <strong>{item.name}</strong>
                        <small>{t(`composer.${item.kind}`)}</small>
                      </span>
                    </>
                  )}
                  <button
                    aria-label={t('composer.removeAttachment')}
                    onClick={() => updateView(activeProject, current => ({
                      ...current,
                      attachments: current.attachments.filter((_, itemIndex) => itemIndex !== index)
                    }))}
                    title={t('composer.removeAttachment')}
                    type="button"
                  >
                    <CloseIcon />
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            aria-label="Message Friday"
            disabled={status !== 'ready' || Boolean(pendingApproval)}
            onChange={event => updateView(activeProject, current => ({ ...current, draft: event.target.value }))}
            onKeyDown={onKeyDown}
            onPaste={event => {
              const image = Array.from(event.clipboardData.files).find(file => file.type.startsWith('image/'))
              if (!image) return
              event.preventDefault()
              if (!(selectedModel?.vision ?? info.model_vision)) {
                updateView(activeProject, current => ({
                  ...current,
                  items: [...current.items, { id: nextId('image'), kind: 'system', text: t('composer.visionRequired') }]
                }))
                return
              }
              void readImage(image).then(value => {
                updateView(activeProject, current => {
                  const imageCount = current.attachments.filter(item => item.kind === 'image').length
                  if (imageCount >= MAX_IMAGE_ATTACHMENTS) {
                    return {
                      ...current,
                      items: [...current.items, { id: nextId('image'), kind: 'system', text: t('composer.imageLimit') }]
                    }
                  }
                  return { ...current, attachments: [...current.attachments, value] }
                })
              }).catch(error => {
                updateView(activeProject, current => ({
                  ...current,
                  items: [...current.items, { id: nextId('image'), kind: 'system', text: String(error) }]
                }))
              })
            }}
            placeholder={pendingApproval ? t('composer.approvalBlocked') : busy ? t('composer.steerHint') : status === 'ready' ? t('composer.placeholder') : t('composer.starting')}
            ref={composerRef}
            rows={1}
            value={draft}
          />
          <div className="composer-footer">
            <div className="composer-primary-actions">
              <MenuDetails className={`attachment-picker ${busy ? 'disabled' : ''}`} key={`${activeProject}-attachments`}>
                <summary
                  aria-disabled={busy}
                  aria-label={t('composer.add')}
                  onClick={event => busy && event.preventDefault()}
                  tabIndex={busy ? -1 : 0}
                  title={t('composer.add')}
                >
                  <PlusIcon />
                </summary>
                <div className="attachment-menu">
                  <button onClick={event => {
                    event.currentTarget.closest('details')?.removeAttribute('open')
                    void chooseFiles()
                  }} type="button">
                    <FileIcon />
                    <span>{t('composer.addFiles')}</span>
                  </button>
                  <button onClick={event => {
                    event.currentTarget.closest('details')?.removeAttribute('open')
                    void chooseFolder()
                  }} type="button">
                    <FileFolderIcon />
                    <span>{t('composer.addFolder')}</span>
                  </button>
                  <button
                    className={goalMode ? 'active' : ''}
                    onClick={event => {
                      event.currentTarget.closest('details')?.removeAttribute('open')
                      updateView(activeProject, current => ({ ...current, goalMode: !current.goalMode }))
                    }}
                    type="button"
                  >
                    <TargetIcon />
                    <span>{t('composer.setGoal')}</span>
                  </button>
                </div>
              </MenuDetails>
              {goalMode && (
                <button
                  className="goal-mode-chip"
                  onClick={() => updateView(activeProject, current => ({ ...current, goalMode: false }))}
                  title={t('composer.clearGoal')}
                  type="button"
                >
                  <TargetIcon />
                  <span>{t('composer.goal')}</span>
                  <CloseIcon />
                </button>
              )}
              <MenuDetails
                className="permission-picker"
                key={`${activeProject}-permissions`}
              >
                {/* Deliberately usable mid-run: permission is a hot swap that
                    governs the next tool call of the running turn. */}
                <summary
                  aria-label="Permission mode"
                  tabIndex={0}
                  title={t('permission.title')}
                >
                  <span aria-hidden="true" className={`permission-indicator mode-${info.permission_mode}`} />
                  <span>{t(permission.labelKey)}</span>
                  <i aria-hidden="true" />
                </summary>
                <div className="permission-menu">
                  {permissionOptions.map(option => (
                    <button
                      className={option.value === info.permission_mode ? 'active' : ''}
                      key={option.value}
                      onClick={event => {
                        event.currentTarget.closest('details')?.removeAttribute('open')
                        changePermission(option.value)
                      }}
                      type="button"
                    >
                      <span className={`permission-indicator mode-${option.value}`} />
                      <span>
                        <strong>{t(option.labelKey)}</strong>
                        <small>{t(option.descriptionKey)}</small>
                      </span>
                    </button>
                  ))}
                </div>
              </MenuDetails>
            </div>
            <div className="composer-actions">
              <MenuDetails
                className={`model-picker ${busy ? 'disabled' : ''}`}
                key={`${activeProject}-${info.model_profile}`}
              >
                <summary aria-disabled={busy} onClick={event => busy && event.preventDefault()}>
                  <ProviderIcon label={selectedModel?.name || info.model_name || info.model} provider={selectedModel?.provider || ''} />
                  <span>{selectedModel?.name || info.model_name || info.model}</span>
                  <i aria-hidden="true" />
                </summary>
                <div className="model-menu">
                  {models.profiles.filter(profile => profile.enabled).map(profile => (
                    <button
                      className={profile.id === info.model_profile ? 'active' : ''}
                      key={profile.id}
                      onClick={event => {
                        event.currentTarget.closest('details')?.removeAttribute('open')
                        selectModel(profile.id)
                      }}
                      type="button"
                    >
                      <span className="model-menu-main">
                        <ProviderIcon label={profile.name} provider={profile.provider} />
                        <span className="model-menu-copy">
                          <strong><span>{profile.name}</span></strong>
                          <small>{profile.provider} / {profile.model}</small>
                        </span>
                      </span>
                      <span className={`model-key ${profile.api_key_configured ? 'configured' : ''}`} title={profile.api_key_configured ? t('modelMenu.keyConfigured') : t('modelMenu.keyRequired')} />
                    </button>
                  ))}
                  <button
                    className="configure-models"
                    onClick={event => {
                      event.currentTarget.closest('details')?.removeAttribute('open')
                      setSettingsSection('models')
                      setPage('settings')
                    }}
                    type="button"
                  >
                    {t('composer.configureModels')}
                  </button>
                </div>
              </MenuDetails>
              {info.thinking_supported && (
                <MenuDetails
                  className={`permission-picker ${busy ? 'disabled' : ''}`}
                  key={`${activeProject}-thinking`}
                >
                  <summary
                    aria-disabled={busy}
                    aria-label="Thinking effort"
                    onClick={event => {
                      if (busy) event.preventDefault()
                    }}
                    tabIndex={busy ? -1 : 0}
                    title={t('composer.thinking')}
                  >
                    <span>{t('composer.thinking')}: {t(thinking.labelKey)}</span>
                    <i aria-hidden="true" />
                  </summary>
                  <div className="permission-menu">
                    {availableThinkingOptions.map(option => (
                      <button
                        className={option.value === info.thinking_effort ? 'active' : ''}
                        key={option.value}
                        onClick={event => {
                          event.currentTarget.closest('details')?.removeAttribute('open')
                          changeThinking(option.value)
                        }}
                        type="button"
                      >
                        <span className="permission-indicator" />
                        <span>
                          <strong>{t(option.labelKey)}</strong>
                          <small>{t(option.descriptionKey)}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                </MenuDetails>
              )}
              <button
                aria-label={busy ? t('composer.stop') : t('composer.send')}
                className={`send-button ${busy ? 'stop' : ''}`}
                disabled={cancelling || (!busy && ((!draft.trim() && !attachments.length) || Boolean(pendingApproval) || status !== 'ready'))}
                onClick={busy ? event => { event.preventDefault(); cancelRequest() } : undefined}
                title={busy ? t('composer.stop') : t('composer.send')}
                type={busy ? 'button' : 'submit'}
              >
                {busy ? <span className="stop-icon" /> : <ArrowUpIcon />}
              </button>
            </div>
          </div>
        </form>
        {forkTree.nodes.length > 1 && (
          <ForkMap
            active={activeSession}
            onDelete={deleteForkNode}
            onOpen={openForkNode}
            tree={forkTree}
          />
        )}
        </>
        )}
        </main>
        {artifactPreview && (
          <div aria-modal="true" className="artifact-preview-backdrop" onMouseDown={() => setArtifactPreview(null)} role="dialog">
            <section className="artifact-preview" onMouseDown={event => event.stopPropagation()}>
              <header>
                <div>
                  <strong>{artifactPreview.name}</strong>
                  <span>{artifactPreview.path}</span>
                </div>
                <button aria-label="Close artifact preview" onClick={() => setArtifactPreview(null)} type="button"><CloseIcon /></button>
              </header>
              <div className="artifact-preview-content message-text">
                {artifactPreview.kind === 'markdown' ? (
                  <ReactMarkdown
                    components={markdownComponents(openLinkExternally)}
                    rehypePlugins={markdownRehypePlugins}
                    remarkPlugins={markdownRemarkPlugins}
                  >
                    {normalizeMarkdown(artifactPreview.content || '')}
                  </ReactMarkdown>
                ) : artifactPreview.kind === 'text' ? (
                  <pre>{artifactPreview.content}</pre>
                ) : artifactPreview.kind === 'image' ? (
                  <img alt={artifactPreview.name} src={imageUrl(artifactPreview.data_url)} />
                ) : artifactPreview.kind === 'pdf' ? (
                  // The viewer needs scripts; withholding allow-same-origin keeps the
                  // frame on an opaque origin so it cannot reach the app or its IPC.
                  <iframe sandbox="allow-scripts" src={artifactPreview.data_url} title={artifactPreview.name} />
                ) : null}
              </div>
            </section>
          </div>
        )}
        {previewImage && (
          <div aria-modal="true" className="image-preview-backdrop" onMouseDown={() => setPreviewImage('')} role="dialog">
            <button aria-label="Close image preview" onClick={() => setPreviewImage('')} type="button"><CloseIcon /></button>
            <img alt="Attached image preview" onMouseDown={event => event.stopPropagation()} src={previewImage} />
          </div>
        )}
      </div>
      {projectDropActive && (
        <div className="project-drop-overlay">
          <FolderIcon open />
          <strong>{t('projectDrop.title')}</strong>
          <span>{t('projectDrop.hint')}</span>
        </div>
      )}
    </div>
  )
}

function WelcomePrompt() {
  const [message] = useState(() => {
    const greeting = t(welcomeGreetingKey())
    const hint = t(WELCOME_MESSAGE_KEYS[Math.floor(Math.random() * WELCOME_MESSAGE_KEYS.length)]!)
    return t('welcome.greeting.format', { greeting, hint })
  })
  const characters = Array.from(message)
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const [visible, setVisible] = useState(reduceMotion ? characters.length : 0)

  useEffect(() => {
    if (reduceMotion) return
    const timer = window.setInterval(() => {
      setVisible(current => {
        if (current >= characters.length - 1) {
          window.clearInterval(timer)
          return characters.length
        }
        return current + 1
      })
    }, 58)
    return () => window.clearInterval(timer)
  }, [characters.length, reduceMotion])

  return (
    <div aria-label={message} className="welcome-prompt">
      <span aria-hidden="true">{characters.slice(0, visible).join('')}</span>
      <i aria-hidden="true" />
    </div>
  )
}

const FORK_MAP_KEY = 'friday.desktop.forkMap'

function treeContains(tree: ForkTree, ancestorId: string, nodeId: string) {
  let cursor: string | undefined = nodeId
  while (cursor) {
    if (cursor === ancestorId) return true
    cursor = tree.nodes.find(node => node.id === cursor)?.parent
  }
  return false
}

function layoutForkTree(tree: ForkTree) {
  const children = new Map<string, ForkNode[]>()
  for (const node of tree.nodes) {
    const parent = node.parent || ''
    children.set(parent, [...(children.get(parent) || []), node])
  }
  const positions = new Map<string, { x: number; y: number }>()
  const edges: Array<{ d: string; key: string }> = []
  const colWidth = 30
  const rowHeight = 48
  const padX = 20
  const padY = 20
  let leaf = 0
  const place = (node: ForkNode, depth: number): number => {
    const kids = children.get(node.id) || []
    let column: number
    if (!kids.length) {
      column = leaf
      leaf += 1
    } else {
      const columns = kids.map(kid => place(kid, depth + 1))
      column = (columns[0]! + columns[columns.length - 1]!) / 2
    }
    positions.set(node.id, { x: padX + column * colWidth, y: padY + depth * rowHeight })
    return column
  }
  const root = tree.nodes.find(node => node.id === tree.root)
  if (root) place(root, 0)
  for (const node of tree.nodes) {
    if (!node.parent) continue
    const from = positions.get(node.parent)
    const to = positions.get(node.id)
    if (!from || !to) continue
    const midY = (from.y + to.y) / 2
    edges.push({ d: `M ${from.x} ${from.y} C ${from.x} ${midY}, ${to.x} ${midY}, ${to.x} ${to.y}`, key: node.id })
  }
  const maxY = Math.max(0, ...tree.nodes.map(node => positions.get(node.id)?.y ?? 0))
  return {
    edges,
    height: maxY + padY + 18,
    positions,
    width: Math.max(52, padX * 2 + Math.max(0, leaf - 1) * colWidth)
  }
}

function ForkMap({
  active,
  onDelete,
  onOpen,
  tree
}: {
  active: string
  onDelete: (node: ForkNode) => void
  onOpen: (node: ForkNode) => void
  tree: ForkTree
}) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(FORK_MAP_KEY) === 'collapsed')
  const [hovered, setHovered] = useState<string | null>(null)
  const dismissTimer = useRef<number | null>(null)
  const { edges, height, positions, width } = layoutForkTree(tree)
  const hoveredNode = hovered ? tree.nodes.find(node => node.id === hovered) : undefined
  const hoveredPos = hovered ? positions.get(hovered) : undefined
  const hoveredParent = hoveredNode?.parent ? tree.nodes.find(node => node.id === hoveredNode.parent) : undefined

  useEffect(() => () => {
    if (dismissTimer.current !== null) window.clearTimeout(dismissTimer.current)
  }, [])

  const showTip = (id: string) => {
    if (dismissTimer.current !== null) {
      window.clearTimeout(dismissTimer.current)
      dismissTimer.current = null
    }
    setHovered(id)
  }

  const dismissTip = () => {
    if (dismissTimer.current !== null) window.clearTimeout(dismissTimer.current)
    dismissTimer.current = window.setTimeout(() => setHovered(null), 300)
  }

  const setCollapsedPersisted = (value: boolean) => {
    setCollapsed(value)
    localStorage.setItem(FORK_MAP_KEY, value ? 'collapsed' : 'expanded')
  }

  if (collapsed) {
    return (
      <button
        aria-label={t('fork.show')}
        className="fork-chip"
        onClick={() => setCollapsedPersisted(false)}
        title={t('fork.show')}
        type="button"
      >
        <BranchIcon />
        <span>{tree.nodes.length}</span>
      </button>
    )
  }

  return (
    <aside aria-label="Conversation branches" className="fork-map">
      <header>
        <strong>Branches</strong>
        <span>{tree.nodes.length}</span>
        <button
          aria-label={t('fork.hide')}
          className="fork-map-collapse"
          onClick={() => setCollapsedPersisted(true)}
          title={t('fork.hide')}
          type="button"
        >
          <MinusIcon />
        </button>
      </header>
      <div className="fork-graph-scroll">
        <svg className="fork-graph" height={height} viewBox={`0 0 ${width} ${height}`} width={width}>
          {edges.map(edge => (
            <path className="fork-edge" d={edge.d} key={edge.key} />
          ))}
          {tree.nodes.map(node => {
            const pos = positions.get(node.id)
            if (!pos) return null
            const classes = [
              'fork-graph-node',
              node.id === active ? 'active' : '',
              node.id === tree.root ? 'root' : ''
            ].filter(Boolean).join(' ')
            return (
              <g
                className={classes}
                key={node.id}
                onClick={() => onOpen(node)}
                onMouseEnter={() => showTip(node.id)}
                onMouseLeave={dismissTip}
                transform={`translate(${pos.x}, ${pos.y})`}
              >
                <circle className="fork-node-hit" r="13" />
                <circle className="fork-node-dot" r="5.5" />
              </g>
            )
          })}
        </svg>
      </div>
      {hoveredNode && hoveredPos && (
        <div
          className="fork-tip"
          onMouseEnter={() => showTip(hoveredNode.id)}
          onMouseLeave={dismissTip}
          style={{ top: hoveredPos.y + 30 } as CSSProperties}
        >
          <p>{hoveredNode.id === tree.root ? t('fork.main') : t('fork.fork')}</p>
          <strong>{hoveredNode.title || 'Untitled conversation'}</strong>
          {hoveredNode.fork_source
            ? <span className="fork-tip-parent">{t('fork.fromMessage', { text: hoveredNode.fork_source })}</span>
            : hoveredParent && <span className="fork-tip-parent">{t('fork.from', { title: hoveredParent.title })}</span>}
          <span className="fork-tip-meta">{formatSessionTime(hoveredNode.time)}</span>
          <div className="fork-tip-actions">
            <button onClick={() => onOpen(hoveredNode)} type="button">{t('fork.open')}</button>
            {hoveredNode.id !== tree.root && (
              <button className="danger" onClick={() => onDelete(hoveredNode)} type="button">{t('fork.delete')}</button>
            )}
          </div>
        </div>
      )}
    </aside>
  )
}

function ProjectsIcon() {
  return (
    <svg aria-hidden="true" className="section-icon" fill="none" viewBox="0 0 24 24">
      <path d="M3.5 6.2a2 2 0 0 1 2-2h4.3l2.1 2.4h6.6a2 2 0 0 1 2 2v8.2a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />
    </svg>
  )
}

function ClockIcon() {
  return (
    <svg aria-hidden="true" className="section-icon" fill="none" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 7.2V12l3.2 2.1" />
    </svg>
  )
}

function BranchIcon() {
  return (
    <svg aria-hidden="true" className="branch-icon" fill="none" viewBox="0 0 24 24">
      <circle cx="6.5" cy="5.5" r="2.2" />
      <circle cx="6.5" cy="18.5" r="2.2" />
      <circle cx="17.5" cy="7.5" r="2.2" />
      <path d="M6.5 7.7v8.6M17.5 9.7c0 4.2-4 4.8-7.4 4.8" />
    </svg>
  )
}

function FolderIcon({ className = '', open }: { className?: string; open: boolean }) {
  return (
    <svg aria-hidden="true" className={`project-folder ${className}`} fill="none" viewBox="0 0 24 24">
      {open
        ? <path d="M3.5 8h17l-1.6 9.2a2 2 0 0 1-2 1.7H6a2 2 0 0 1-2-1.7L2.8 10A1.7 1.7 0 0 1 4.5 8Zm1-1.5V5.8a1.7 1.7 0 0 1 1.7-1.7h4l2 2.4H19a1.5 1.5 0 0 1 1.5 1.5" />
        : <path d="M3.5 6.2a2 2 0 0 1 2-2h4.3l2.1 2.4h6.6a2 2 0 0 1 2 2v8.2a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />}
    </svg>
  )
}

type ModelDraft = Omit<ModelProfile, 'api_key_configured' | 'enabled' | 'vision'>
type ModelTarget = { profile?: string; provider?: string }

const PROVIDER_ICON_URLS: Readonly<Record<string, string>> = {
  anthropic: 'https://www.anthropic.com/favicon.ico',
  anysearch: 'https://www.anysearch.com/favicon.ico',
  deepseek: 'https://www.deepseek.com/favicon.ico',
  mimo: 'https://mimo.mi.com/favicon.png',
  'opencode-go': 'https://opencode.ai/favicon.ico',
  openai: 'https://openai.com/favicon.ico',
  tavily: 'https://tavily.com/favicon.ico'
}

function ProviderIcon({ label, provider }: { label: string; provider: string }) {
  return <RemoteIcon className="provider-icon" label={label} src={PROVIDER_ICON_URLS[provider.toLowerCase()] || ''} />
}

function SiteIcon({ icon, url }: { icon?: string; url: string }) {
  let fallback = ''
  try {
    fallback = new URL('/favicon.ico', url).toString()
  } catch {
    // Invalid source URLs keep the quiet text fallback.
  }
  return <RemoteIcon className="source-icon" label={hostOf(url)} src={safeIconUrl(icon) || safeIconUrl(fallback)} />
}

function RemoteIcon({ className, label, src }: { className: string; label: string; src: string }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [src])
  return (
    <span aria-hidden="true" className={`${className} ${failed || !src ? 'fallback' : ''}`}>
      {src && !failed
        ? <img alt="" draggable={false} onError={() => setFailed(true)} referrerPolicy="no-referrer" src={src} />
        : <span>{label.trim().charAt(0).toUpperCase() || '·'}</span>}
    </span>
  )
}

function openLinkExternally(url: string) {
  void openUrl(url).catch(() => window.open(url, '_blank'))
}

function SunIcon() {
  return (
    <svg aria-hidden="true" className="theme-icon" fill="none" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg aria-hidden="true" className="theme-icon" fill="none" viewBox="0 0 24 24">
      <path d="M20.2 14.5A8.3 8.3 0 0 1 9.5 3.8a8.3 8.3 0 1 0 10.7 10.7Z" />
    </svg>
  )
}

type SettingsSection = 'general' | 'models' | 'web' | 'memory' | 'compaction' | 'plugins'

const SETTINGS_SECTIONS: ReadonlyArray<{ hintKey: string; id: SettingsSection; labelKey: string }> = [
  { hintKey: 'settings.general.hint', id: 'general', labelKey: 'settings.general' },
  { hintKey: 'settings.models.hint', id: 'models', labelKey: 'settings.models' },
  { hintKey: 'settings.web.hint', id: 'web', labelKey: 'settings.web' },
  { hintKey: 'settings.memory.hint', id: 'memory', labelKey: 'settings.memory' },
  { hintKey: 'settings.compaction.hint', id: 'compaction', labelKey: 'settings.compaction' },
  { hintKey: 'settings.plugins.hint', id: 'plugins', labelKey: 'settings.plugins' }
]

type PluginInfo = {
  capabilities?: string[]
  description: string
  disabled: boolean
  errors: string[]
  name: string
  required: boolean
  scope: string
  source: string
  tools: string[]
  version: string
}

function pluginContribution(plugin: PluginInfo): string {
  const values = plugin.tools.length ? [t('plugins.tools', { tools: plugin.tools.join(', ') })] : []
  if (plugin.capabilities?.includes('prompt')) values.push(t('plugins.prompt'))
  if (plugin.capabilities?.includes('tool-wrapper')) values.push(t('plugins.wrapper'))
  if (plugin.capabilities?.includes('memory')) values.push(t('plugins.memory'))
  if (plugin.capabilities?.includes('compaction')) values.push(t('plugins.compaction'))
  return values.join(' · ') || t('plugins.noTools')
}

/**
 * The plugin registry with one switch per row - the same on/off the TUI's
 * /plugins picker offers, persisted through the same gateway call.
 */
function PluginsSettings({
  onList,
  onToggle
}: {
  onList: () => Promise<{ plugins: PluginInfo[] }>
  onToggle: (name: string, enabled: boolean) => Promise<{ plugins: PluginInfo[] }>
}) {
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null)
  const [error, setError] = useState('')
  const form = useSettingsSave()

  useEffect(() => {
    let cancelled = false
    onList().then(result => {
      if (!cancelled) setPlugins(result.plugins)
    }).catch(problem => {
      if (!cancelled) setError(String(problem))
    })
    return () => {
      cancelled = true
    }
  }, [onList])

  if (!plugins) return <SettingsLoading error={error} />

  const toggle = (plugin: PluginInfo, enabled: boolean) => {
    form.submit(
      onToggle(plugin.name, enabled).then(result => setPlugins(result.plugins)),
      () => t(enabled ? 'plugins.enabled' : 'plugins.disabled', { name: plugin.name }),
      plugin.name
    )
  }

  return (
    <div className="plugin-list">
      {plugins.map(plugin => (
        <div className={`model-provider ${plugin.disabled ? '' : 'enabled'}`} key={plugin.name}>
          <div className="model-provider-identity">
            <span className="model-provider-name">
              <strong>{plugin.name}</strong>
              <small>{plugin.description || plugin.source}</small>
            </span>
          </div>
          <div className="model-provider-meta">
            <span>
              {plugin.required ? `${t('plugins.required')} · ` : ''}
              {plugin.scope} · {pluginContribution(plugin)}
            </span>
            {plugin.errors.length ? <span className="plugin-error">{t('plugins.error', { error: plugin.errors[0]! })}</span> : null}
          </div>
          <label className="settings-switch" title={plugin.disabled ? t('plugins.off') : t('plugins.on')}>
            <input
              checked={!plugin.disabled}
              disabled={plugin.required || form.pending === plugin.name}
              onChange={event => toggle(plugin, event.target.checked)}
              type="checkbox"
            />
            <span aria-hidden="true" />
          </label>
        </div>
      ))}
      <p className="settings-note">{t('plugins.external')}</p>
      <SettingsMessage failed={form.failed} message={form.message} />
    </div>
  )
}

function ModelCredentialRow({
  configured,
  draft,
  enabled,
  label,
  modelCount,
  onClear,
  onEdit,
  onEnable,
  onRefresh,
  onReveal,
  onSave,
  provider,
  subtitle,
  target
}: {
  configured: boolean
  draft: ModelDraft
  enabled: boolean
  label: string
  modelCount: number
  onClear: (target: ModelTarget) => Promise<ModelCatalog>
  onEdit?: () => void
  onEnable: (target: ModelTarget, enabled: boolean) => Promise<ModelCatalog>
  onRefresh: (target: ModelTarget) => Promise<{ catalog: ModelCatalog; models: string[] }>
  onReveal: (target: ModelTarget) => Promise<string>
  onSave: (profile: ModelDraft, apiKey: string) => Promise<ModelCatalog>
  provider: string
  subtitle: string
  target: ModelTarget
}) {
  const [apiKey, setApiKey] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [available, setAvailable] = useState(modelCount)
  const input = useRef<HTMLInputElement>(null)
  const form = useSettingsSave()

  useEffect(() => setAvailable(modelCount), [modelCount])

  const save = (event: FormEvent) => {
    event.preventDefault()
    const value = apiKey.trim()
    if (!value) {
      input.current?.focus()
      return
    }
    form.submit(onSave(draft, value), () => {
      setApiKey('')
      setRevealed(false)
      return t('models.saved')
    })
  }

  const reveal = () => {
    if (revealed) {
      setRevealed(false)
      return
    }
    if (apiKey) {
      setRevealed(true)
      return
    }
    if (!configured) return
    form.submit(onReveal(target), value => {
      setApiKey(value)
      setRevealed(true)
      return ''
    }, 'reveal')
  }

  const refresh = () => form.submit(onRefresh(target), result => {
    setAvailable(result.models.length)
    return t('models.refreshed').replace('{n}', String(result.models.length))
  }, 'refresh')

  const clear = () => form.submit(onClear(target), () => {
    setApiKey('')
    setRevealed(false)
    return t('models.keyRemoved')
  }, 'clear')

  const toggle = (next: boolean) => {
    if (next && !configured) {
      input.current?.focus()
      form.report({ failed: true, message: t('models.enableNeedsKey') })
      return
    }
    form.submit(onEnable(target, next), () => next ? t('models.enabled') : t('models.disabled'), 'toggle')
  }

  const busy = Boolean(form.pending)
  return (
    <div className={`model-provider ${enabled ? 'enabled' : ''}`}>
      <div className="model-provider-identity">
        <ProviderIcon label={label} provider={provider} />
        {onEdit ? (
          <button className="model-provider-name model-provider-edit" onClick={onEdit} type="button">
            <strong>{label}</strong>
            <small>{subtitle}</small>
          </button>
        ) : (
          <span className="model-provider-name">
            <strong>{label}</strong>
            <small>{subtitle}</small>
          </span>
        )}
      </div>
      <form className="credential-input" onSubmit={save}>
        <input
          aria-label={`${label} ${t('models.apiKey')}`}
          autoComplete="off"
          disabled={busy}
          onChange={event => setApiKey(event.target.value)}
          placeholder={configured ? '••••••••••••' : t('models.keyEmptyShort')}
          ref={input}
          spellCheck={false}
          type={revealed ? 'text' : 'password'}
          value={apiKey}
        />
        <div className="credential-actions">
          <button
            aria-label={revealed ? t('secret.hide') : t('secret.show')}
            className="credential-icon"
            disabled={busy || (!configured && !apiKey)}
            onClick={reveal}
            title={revealed ? t('secret.hide') : t('secret.show')}
            type="button"
          ><EyeIcon open={!revealed} /></button>
          <button
            aria-label={t('models.refresh')}
            className={`credential-icon ${form.pending === 'refresh' ? 'spinning' : ''}`}
            disabled={busy || !configured}
            onClick={refresh}
            title={t('models.refresh')}
            type="button"
          ><RefreshIcon /></button>
          <button
            aria-label={t('models.removeKey')}
            className="credential-icon danger"
            disabled={busy || !configured}
            onClick={clear}
            title={t('models.removeKey')}
            type="button"
          ><TrashIcon /></button>
          <label className="settings-switch" title={enabled ? t('models.disable') : t('models.enable')}>
            <input
              checked={enabled}
              disabled={busy}
              onChange={event => toggle(event.target.checked)}
              type="checkbox"
            />
            <span aria-hidden="true" />
          </label>
        </div>
      </form>
      <div className="model-provider-meta">
        <span>{configured ? t('models.modelCount').replace('{n}', String(available)) : t('badge.unconfigured')}</span>
        <SettingsMessage failed={form.failed} message={form.message} />
      </div>
    </div>
  )
}

function SettingsPage({
  catalog,
  initialSection,
  language,
  onClearKey,
  onClose,
  onCompact,
  onDelete,
  onEnable,
  onLanguageChange,
  onListPlugins,
  onLoad,
  onReadMemory,
  onRefreshModels,
  onRevealKey,
  onRevealWebKey,
  onSave,
  onSaveCompaction,
  onSaveMemory,
  onSaveProfile,
  onSaveWeb,
  onTogglePlugin
}: {
  catalog: ModelCatalog
  initialSection: SettingsSection
  language: Language
  onClearKey: (target: ModelTarget) => Promise<ModelCatalog>
  onClose: () => void
  onCompact: () => Promise<{ text: string }>
  onDelete: (profileId: string) => Promise<ModelCatalog>
  onEnable: (target: ModelTarget, enabled: boolean) => Promise<ModelCatalog>
  onLanguageChange: (language: Language) => void
  onListPlugins: () => Promise<{ plugins: PluginInfo[] }>
  onLoad: () => Promise<AppSettings>
  onReadMemory: (file: MemoryFileScope) => Promise<MemoryFileDetail>
  onRefreshModels: (target: ModelTarget) => Promise<{ catalog: ModelCatalog; models: string[] }>
  onRevealKey: (target: ModelTarget) => Promise<string>
  onRevealWebKey: (provider: string) => Promise<string>
  onSave: (profile: ModelDraft, apiKey: string) => Promise<ModelCatalog>
  onSaveCompaction: (value: CompactionSettings) => Promise<CompactionSettings>
  onSaveMemory: (file: MemoryFileScope, content: string) => Promise<MemoryFileInfo>
  onSaveProfile: (profile: Partial<UserProfileSettings>) => Promise<UserProfileSettings>
  onSaveWeb: (value: Record<string, unknown>) => Promise<WebSearchSettings>
  onTogglePlugin: (name: string, enabled: boolean) => Promise<{ plugins: PluginInfo[] }>
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [settingsError, setSettingsError] = useState('')
  const [draft, setDraft] = useState<ModelDraft | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [expandedProvider, setExpandedProvider] = useState('')
  const [editingFile, setEditingFile] = useState<MemoryFileScope | null>(null)
  const modelForm = useSettingsSave()

  useEffect(() => {
    let active = true
    void onLoad()
      .then(value => {
        if (active) setSettings(value)
      })
      .catch(value => {
        if (active) setSettingsError(String(value))
      })
    return () => { active = false }
  }, [])

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !editingFile) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, editingFile])

  const openCustom = (profile: ModelProfile | null) => {
    modelForm.clear()
    const key = profile?.id || CUSTOM_NEW
    if (expandedProvider === key) {
      setExpandedProvider('')
      return
    }
    const custom = catalog.providers.find(entry => entry.id === 'openai-compatible')
    setExpandedProvider(key)
    setDraft(profile
      ? { ...modelDraft(profile, custom), name: profile.name }
      : { ...modelDraft(undefined, custom), name: '' })
    setApiKey('')
  }

  const removeCustom = (profileId: string) => {
    modelForm.submit(onDelete(profileId), () => {
      setExpandedProvider('')
      return t('models.deleted')
    })
  }

  const save = (event: FormEvent) => {
    event.preventDefault()
    if (!draft) return
    modelForm.submit(onSave(draft, apiKey), () => {
      setApiKey('')
      setExpandedProvider('')
      return t('models.saved')
    })
  }

  const persistWeb = (value: Record<string, unknown>) => onSaveWeb(value).then(webSearch => {
    setSettings(current => current ? { ...current, web_search: webSearch } : current)
    return webSearch
  })

  const persistProfile = (profile: Partial<UserProfileSettings>) => onSaveProfile(profile).then(userProfile => {
    setSettings(current => current ? { ...current, user_profile: userProfile } : current)
    return userProfile
  })

  const persistCompaction = (value: CompactionSettings) => onSaveCompaction(value).then(compaction => {
    setSettings(current => current ? { ...current, compaction } : current)
    return compaction
  })

  return (
    <div className="settings-page">
      <aside className="settings-nav">
        <button className="settings-back" onClick={onClose} title="Back (Esc)" type="button">
          <ChevronIcon className="back-chevron" />
          <span>{t('settings.back')}</span>
        </button>
        <div className="settings-nav-group">
          {SETTINGS_SECTIONS.map(item => (
            <button
              className={`settings-section ${section === item.id ? 'active' : ''}`}
              key={item.id}
              onClick={() => setSection(item.id)}
              type="button"
            >
              <strong>{t(item.labelKey)}</strong>
              <small>{t(item.hintKey)}</small>
            </button>
          ))}
        </div>
      </aside>
      <section className="settings-content">
          {section === 'general' && (
            <div className="settings-section-wrap">
              <header className="settings-head">
                <h2>{t('general.title')}</h2>
                <p>{t('general.desc')}</p>
              </header>
              <div className="general-preferences">
                <div className="language-field">
                  <span className="language-label">{t('general.uiLanguage')}</span>
                  <div className="language-options" role="radiogroup">
                    {(['zh', 'en'] as const).map(option => (
                      <button
                        aria-checked={language === option}
                        className={`language-option ${language === option ? 'active' : ''}`}
                        key={option}
                        onClick={() => onLanguageChange(option)}
                        role="radio"
                        type="button"
                      >
                        {option === 'zh' ? '中文' : 'English'}
                      </button>
                    ))}
                  </div>
                  <p className="language-note">{t('general.uiLanguageNote')}</p>
                </div>
                <div className="profile-settings">
                  <p>{t('general.profileNote')}</p>
                  {settings
                    ? <UserProfileSettingsForm initial={settings.user_profile} onSave={persistProfile} />
                    : <SettingsLoading error={settingsError} />}
                </div>
              </div>
            </div>
          )}
          {section === 'models' && <div className="settings-section-wrap">
            <header className="settings-head">
              <h2>{t('models.title')}</h2>
            </header>
            <div className="model-provider-list">
              {catalog.providers.filter(item => item.builtin).map(item => {
                const providerProfiles = catalog.profiles.filter(entry => entry.provider === item.id)
                return (
                  <ModelCredentialRow
                    configured={item.api_key_configured}
                    draft={{ ...modelDraft(providerProfiles[0], item), id: providerProfiles[0]?.id || item.id, model: '', name: item.label }}
                    enabled={item.enabled}
                    key={item.id}
                    label={item.label}
                    modelCount={providerProfiles.length}
                    onClear={onClearKey}
                    onEnable={onEnable}
                    onRefresh={onRefreshModels}
                    onReveal={onRevealKey}
                    onSave={onSave}
                    provider={item.id}
                    subtitle={hostOf(item.base_url) || item.base_url}
                    target={{ provider: item.id }}
                  />
                )
              })}
            </div>
            <section className="custom-models">
              <header>
                <div>
                  <h3>{t('models.customTitle')}</h3>
                  <p>{t('models.customBrief')}</p>
                </div>
                <button aria-label={t('models.addCustom')} className="custom-add" onClick={() => openCustom(null)} title={t('models.addCustom')} type="button">
                  <PlusIcon />
                  <span>{t('models.add')}</span>
                </button>
              </header>
              {catalog.profiles.filter(profile => profile.provider === 'openai-compatible').map(profile => (
                <div key={profile.id}>
                  <ModelCredentialRow
                    configured={profile.api_key_configured}
                    draft={modelDraft(profile, catalog.providers.find(item => item.id === 'openai-compatible'))}
                    enabled={profile.enabled}
                    label={profile.name}
                    modelCount={1}
                    onClear={onClearKey}
                    onEdit={() => openCustom(profile)}
                    onEnable={onEnable}
                    onRefresh={onRefreshModels}
                    onReveal={onRevealKey}
                    onSave={onSave}
                    provider="openai-compatible"
                    subtitle={`${hostOf(profile.base_url) || profile.base_url} · ${profile.model}`}
                    target={{ profile: profile.id }}
                  />
                </div>
              ))}
              {expandedProvider && draft && (
                <form className="custom-model-editor settings-form" onSubmit={save}>
                  <label className="line-field">
                    <span>{t('models.name')}</span>
                    <span className="field-line">
                      <input required value={draft.name} onChange={event => setDraft(current => current && { ...current, name: event.target.value })} />
                    </span>
                  </label>
                  <label className="line-field">
                    <span>{t('models.baseUrl')}</span>
                    <span className="field-line">
                      <input required type="url" value={draft.base_url} onChange={event => setDraft(current => current && { ...current, base_url: event.target.value })} />
                    </span>
                  </label>
                  <label className="line-field">
                    <span>{t('models.model')}</span>
                    <span className="field-line">
                      <input required value={draft.model} onChange={event => setDraft(current => current && { ...current, model: event.target.value })} />
                    </span>
                  </label>
                  <label className="line-field">
                    <span>{t('models.apiKey')}</span>
                    <span className="field-line">
                      <input
                        autoComplete="off"
                        onChange={event => setApiKey(event.target.value)}
                        placeholder={expandedProvider === CUSTOM_NEW ? t('models.keyEmptyShort') : t('models.keyOptional')}
                        required={expandedProvider === CUSTOM_NEW}
                        type="password"
                        value={apiKey}
                      />
                    </span>
                  </label>
                  <SettingsMessage failed={modelForm.failed} message={modelForm.message} />
                  <div className="settings-actions">
                    <SaveFooter label={t('settings.save')} saving={modelForm.pending === 'save'} />
                    {expandedProvider !== CUSTOM_NEW && (
                      <button className="line-action remove-entry" onClick={() => removeCustom(expandedProvider)} type="button">
                        {t('models.removeEntry')}
                      </button>
                    )}
                  </div>
                </form>
              )}
            </section>
          </div>}
          {section === 'web' && (
            <div className="settings-section-wrap">
              <header className="settings-head">
                <h2>{t('web.title')}</h2>
                <p>{t('web.desc')}</p>
              </header>
              {settings
                ? <WebSearchSettings initial={settings.web_search} onReveal={onRevealWebKey} onSave={persistWeb} />
                : <SettingsLoading error={settingsError} />}
            </div>
          )}
          {section === 'memory' && (
            <div className="settings-section-wrap">
              <header className="settings-head">
                <h2>{t('memory.title')}</h2>
                <p>{t('memory.desc')}</p>
              </header>
              {settings
                ? (
                  <div className="memory-files">
                      {(['user', 'global'] as const).map(file => {
                        const info = settings.memory_files[file]
                        return (
                          <button className="memory-file" key={file} onClick={() => setEditingFile(file)} type="button">
                            <span aria-hidden="true" className="artifact-icon markdown">MD</span>
                            <span className="memory-file-meta">
                              <strong>{file === 'user' ? 'USER.md' : 'MEMORY.md'}</strong>
                              <small>{file === 'user' ? t('memory.userFile') : t('memory.globalFile')} · {t('memory.chars', { chars: info.chars, limit: info.limit })}</small>
                            </span>
                            <ChevronIcon className="memory-file-chevron" />
                          </button>
                        )
                      })}
                    </div>
                )
                : <SettingsLoading error={settingsError} />}
              {editingFile && settings && (
                <MemoryEditor
                  file={editingFile}
                  info={settings.memory_files[editingFile]}
                  onClose={() => setEditingFile(null)}
                  onRead={onReadMemory}
                  onSave={(file, content) => onSaveMemory(file, content).then(info => {
                    setSettings(current => current
                      ? { ...current, memory_files: { ...current.memory_files, [file]: info } }
                      : current)
                    return info
                  })}
                />
              )}
            </div>
          )}
          {section === 'compaction' && (
            <div className="settings-section-wrap">
              <header className="settings-head">
                <h2>{t('compaction.title')}</h2>
                <p>{t('compaction.desc')}</p>
              </header>
              {settings
                ? <CompactionSettingsForm initial={settings.compaction} onCompact={onCompact} onSave={persistCompaction} />
                : <SettingsLoading error={settingsError} />}
            </div>
          )}
          {section === 'plugins' && (
            <div className="settings-section-wrap">
              <header className="settings-head">
                <h2>{t('plugins.title')}</h2>
                <p>{t('plugins.desc')}</p>
              </header>
              <PluginsSettings onList={onListPlugins} onToggle={onTogglePlugin} />
            </div>
          )}
      </section>
    </div>
  )
}

function CompactionSettingsForm({
  initial,
  onCompact,
  onSave
}: {
  initial: CompactionSettings
  onCompact: () => Promise<{ text: string }>
  onSave: (value: CompactionSettings) => Promise<CompactionSettings>
}) {
  const [draft, setDraft] = useState(initial)
  const form = useSettingsSave()
  useEffect(() => setDraft(initial), [initial])
  const save = (event: FormEvent) => {
    event.preventDefault()
    if (form.pending) return
    form.submit(onSave(draft).then(value => setDraft(value)), () => t('settings.saved'))
  }
  const compact = () => form.submit(
    onSave(draft).then(value => {
      setDraft(value)
      return onCompact()
    }),
    result => result.text,
    'compact'
  )

  return (
    <form className="compaction-settings settings-form" onSubmit={save}>
      <div className="compaction-toggle">
        <span>
          <strong>{t('compaction.automatic')}</strong>
          <small>{t('compaction.automaticNote')}</small>
        </span>
        <label className="settings-switch" title={draft.automatic ? t('plugins.on') : t('plugins.off')}>
          <input
            checked={draft.automatic}
            onChange={event => setDraft(current => ({ ...current, automatic: event.target.checked }))}
            type="checkbox"
          />
          <span aria-hidden="true" />
        </label>
      </div>
      <label className="line-field">
        <span>{t('compaction.threshold')}</span>
        <span className="field-line">
          <input
            max={95}
            min={50}
            onChange={event => setDraft(current => ({ ...current, threshold_percent: Number(event.target.value) }))}
            required
            type="number"
            value={draft.threshold_percent}
          />
          <small>%</small>
        </span>
      </label>
      <label className="line-field">
        <span>{t('compaction.strategy')}</span>
        <span className="field-line">
          <select
            onChange={event => setDraft(current => ({
              ...current,
              strategy: event.target.value as CompactionSettings['strategy']
            }))}
            value={draft.strategy}
          >
            <option value="insert">{t('compaction.insert')}</option>
            <option value="two-stage">{t('compaction.twoStage')}</option>
          </select>
        </span>
      </label>
      <p className="settings-note">{t('compaction.manualNote')}</p>
      <SettingsMessage failed={form.failed} message={form.message} />
      <footer>
        <button className="line-action" disabled={Boolean(form.pending)} onClick={compact} type="button">
          {form.pending === 'compact' ? t('compaction.compacting') : t('compaction.compactNow')}
        </button>
        <button className="save-model" disabled={Boolean(form.pending)} type="submit">
          {form.pending === 'save' ? t('settings.saving') : t('settings.save')}
        </button>
      </footer>
    </form>
  )
}

function MemoryEditor({
  file,
  info,
  onClose,
  onRead,
  onSave
}: {
  file: MemoryFileScope
  info: MemoryFileInfo
  onClose: () => void
  onRead: (file: MemoryFileScope) => Promise<MemoryFileDetail>
  onSave: (file: MemoryFileScope, content: string) => Promise<MemoryFileInfo>
}) {
  const [text, setText] = useState<string | null>(null)
  const [original, setOriginal] = useState('')
  const [loadError, setLoadError] = useState('')
  const form = useSettingsSave()

  useEffect(() => {
    let active = true
    void onRead(file)
      .then(detail => {
        if (!active) return
        setOriginal(detail.content)
        setText(detail.content)
      })
      .catch(value => {
        if (active) setLoadError(String(value))
      })
    return () => { active = false }
  }, [file])

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const save = () => {
    if (text === null) return
    form.submit(onSave(file, text), () => {
      setOriginal(text)
      return t('settings.saved')
    })
  }

  return (
    <div className="memory-editor-backdrop" onMouseDown={onClose}>
      <section aria-modal="true" className="memory-editor" onMouseDown={event => event.stopPropagation()} role="dialog">
        <header>
          <div>
            <h3>{file === 'user' ? 'USER.md' : 'MEMORY.md'}</h3>
            <p>{info.path}</p>
          </div>
          <button aria-label="Close editor" onClick={onClose} title="Close" type="button"><CloseIcon /></button>
        </header>
        {text !== null
          ? (
            <textarea
              autoFocus
              onChange={event => {
                setText(event.target.value)
                form.clear()
              }}
              spellCheck={false}
              value={text}
            />
          )
          : <div className={`settings-loading ${loadError ? 'error' : ''}`}>{loadError || t('settings.loading')}</div>}
        <footer>
          <span className="memory-editor-count">{(text ?? '').length} / {info.limit}</span>
          {form.message && (
            <span className={form.failed ? 'settings-error' : 'settings-saved'}>{form.message}</span>
          )}
          <button
            className="save-model"
            disabled={form.pending === 'save' || text === null || text === original}
            onClick={save}
            type="button"
          >
            {form.pending === 'save' ? t('settings.saving') : t('settings.save')}
          </button>
        </footer>
      </section>
    </div>
  )
}

function SettingsLoading({ error }: { error: string }) {
  return <div className={`settings-loading ${error ? 'error' : ''}`}>{error || t('settings.loading')}</div>
}

const WEB_PROVIDERS: ReadonlyArray<{
  flag: 'clear_anysearch' | 'clear_tavily'
  host: string
  id: 'anysearch' | 'tavily'
  keyField: 'anysearch_api_key' | 'tavily_api_key'
  label: string
}> = [
  { flag: 'clear_tavily', host: 'api.tavily.com', id: 'tavily', keyField: 'tavily_api_key', label: 'Tavily' },
  { flag: 'clear_anysearch', host: 'api.anysearch.com', id: 'anysearch', keyField: 'anysearch_api_key', label: 'AnySearch' }
]

function WebSearchSettings({
  initial,
  onReveal,
  onSave
}: {
  initial: WebSearchSettings
  onReveal: (provider: string) => Promise<string>
  onSave: (value: Record<string, unknown>) => Promise<WebSearchSettings>
}) {
  const [configured, setConfigured] = useState(initial)

  return (
    <div className="model-provider-list">
      {WEB_PROVIDERS.map(provider => (
        <WebCredentialRow
          configured={configured[`${provider.id}_configured`]}
          key={provider.id}
          onReveal={onReveal}
          onSave={value => onSave(value).then(result => {
            setConfigured(result)
            return result
          })}
          provider={provider}
        />
      ))}
    </div>
  )
}

function WebCredentialRow({
  configured,
  onReveal,
  onSave,
  provider
}: {
  configured: boolean
  onReveal: (provider: string) => Promise<string>
  onSave: (value: Record<string, unknown>) => Promise<WebSearchSettings>
  provider: (typeof WEB_PROVIDERS)[number]
}) {
  const [apiKey, setApiKey] = useState('')
  const [revealed, setRevealed] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const form = useSettingsSave()
  const busy = Boolean(form.pending)

  const save = (event: FormEvent) => {
    event.preventDefault()
    if (!apiKey.trim()) {
      input.current?.focus()
      return
    }
    form.submit(onSave({ [provider.keyField]: apiKey.trim() }), () => {
      setApiKey('')
      setRevealed(false)
      return t('web.saved')
    })
  }

  const reveal = () => {
    if (revealed) {
      setRevealed(false)
      return
    }
    if (apiKey) {
      setRevealed(true)
      return
    }
    if (!configured) return
    form.submit(onReveal(provider.id), value => {
      setApiKey(value)
      setRevealed(true)
      return ''
    }, 'reveal')
  }

  const clear = () => form.submit(onSave({ [provider.flag]: true }), () => {
    setApiKey('')
    setRevealed(false)
    return t('models.keyRemoved')
  }, 'clear')

  return (
    <div className="model-provider web-provider">
      <div className="model-provider-identity">
        <ProviderIcon label={provider.label} provider={provider.id} />
        <span className="model-provider-name">
          <strong>{provider.label}</strong>
          <small>{provider.host}</small>
        </span>
      </div>
      <form className="credential-input" onSubmit={save}>
        <input
          aria-label={`${provider.label} ${t('models.apiKey')}`}
          autoComplete="off"
          disabled={busy}
          onChange={event => setApiKey(event.target.value)}
          placeholder={configured ? '••••••••••••' : t('models.keyEmptyShort')}
          ref={input}
          spellCheck={false}
          type={revealed ? 'text' : 'password'}
          value={apiKey}
        />
        <div className="credential-actions">
          <button aria-label={revealed ? t('secret.hide') : t('secret.show')} className="credential-icon" disabled={busy || (!configured && !apiKey)} onClick={reveal} title={revealed ? t('secret.hide') : t('secret.show')} type="button">
            <EyeIcon open={!revealed} />
          </button>
          <button aria-label={t('models.removeKey')} className="credential-icon danger" disabled={busy || !configured} onClick={clear} title={t('models.removeKey')} type="button">
            <TrashIcon />
          </button>
        </div>
      </form>
      <div className="model-provider-meta">
        <span>{configured ? t('badge.configured') : t('badge.unconfigured')}</span>
        <SettingsMessage failed={form.failed} message={form.message} />
      </div>
    </div>
  )
}

function UserProfileSettingsForm({
  initial,
  onSave
}: {
  initial: UserProfileSettings
  onSave: (profile: Partial<UserProfileSettings>) => Promise<UserProfileSettings>
}) {
  const [name, setName] = useState(initial.preferred_name)
  const [preferredLanguage, setPreferredLanguage] = useState(initial.preferred_language)
  const form = useSettingsSave()

  const save = (event: FormEvent) => {
    event.preventDefault()
    form.submit(
      onSave({ preferred_language: preferredLanguage, preferred_name: name }),
      () => t('memory.saved')
    )
  }

  return (
    <form className="settings-form" onSubmit={save}>
      <label className="line-field">
        <span>{t('general.name')}</span>
        <span className="field-line"><input maxLength={100} onChange={event => setName(event.target.value)} placeholder={t('general.namePlaceholder')} value={name} /></span>
      </label>
      <label className="line-field">
        <span>{t('general.responseLanguage')}</span>
        <span className="field-line"><input maxLength={100} onChange={event => setPreferredLanguage(event.target.value)} placeholder={t('general.responseLanguagePlaceholder')} value={preferredLanguage} /></span>
      </label>
      <SettingsMessage failed={form.failed} message={form.message} />
      <SaveFooter saving={form.pending === 'save'} />
    </form>
  )
}

function modelDraft(profile?: ModelProfile, provider?: ModelProvider): ModelDraft {
  return {
    base_url: profile?.base_url || provider?.base_url || '',
    context_window: profile?.context_window || 1000000,
    id: profile?.id || '',
    max_output_tokens: profile?.max_output_tokens || 65536,
    model: profile?.model || provider?.models[0]?.id || '',
    name: profile?.name || '',
    provider: profile?.provider || provider?.id || ''
  }
}

function SkillBrowser({
  detail,
  error,
  onClose,
  onOpen,
  onOpenLink,
  onQueryChange,
  query,
  skills
}: {
  detail: SkillDetail | null
  error: string
  onClose: () => void
  onOpen: (skill: SkillInfo) => void
  onOpenLink: (url: string) => void
  onQueryChange: (query: string) => void
  query: string
  skills: SkillInfo[]
}) {
  const needle = query.trim().toLocaleLowerCase()
  const filtered = needle
    ? skills.filter(skill => `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(needle))
    : skills

  return (
    <section className="skills-page">
      <header className="skills-heading">
        <h1>{t('nav.skills')}</h1>
        <p>{t('skills.tagline')}</p>
      </header>
      <label className="skill-search">
        <SearchIcon />
        <input
          aria-label={t('skills.search')}
          onChange={event => onQueryChange(event.target.value)}
          placeholder={t('skills.search')}
          value={query}
        />
      </label>
      <div className="skills-section-heading">
        <h2>{t('skills.installed')}</h2>
        <span>{filtered.length}</span>
      </div>
      {error && <div className="skill-error">{error}</div>}
      <div className="skills-grid">
        {filtered.map(skill => (
          <button className="skill-card" key={`${skill.scope}-${skill.path}`} onClick={() => onOpen(skill)} type="button">
            <span aria-hidden="true" className="skill-card-icon"><DiamondIcon /></span>
            <span className="skill-card-copy">
              <strong>{skill.name}</strong>
              <small>{skill.description}</small>
            </span>
            <CheckIcon className="skill-card-check" />
          </button>
        ))}
      </div>
      {!filtered.length && <div className="skills-empty">{t('skills.empty')}</div>}
      {detail && (
        <div className="skill-modal-backdrop" onMouseDown={onClose}>
          <article
            aria-modal="true"
            className="skill-modal"
            onMouseDown={event => event.stopPropagation()}
            role="dialog"
          >
            <header>
              <span aria-hidden="true" className="skill-card-icon"><DiamondIcon /></span>
              <button aria-label="Close skill details" onClick={onClose} title="Close" type="button">
                <CloseIcon />
              </button>
            </header>
            <h2>{detail.skill.name} <span>Skill</span></h2>
            <p>{detail.skill.description}</p>
            <small>{detail.skill.scope} · {detail.skill.path}</small>
            <div className="skill-content">
              <ReactMarkdown
                components={markdownComponents(onOpenLink)}
                rehypePlugins={markdownRehypePlugins}
                remarkPlugins={markdownRemarkPlugins}
              >
                {normalizeMarkdown(detail.content)}
              </ReactMarkdown>
            </div>
          </article>
        </div>
      )}
    </section>
  )
}

function WindowTitlebar() {
  const appWindow = getCurrentWindow()
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    const sync = () => void appWindow.isMaximized().then(setMaximized)

    sync()
    void appWindow.onResized(sync).then(listener => {
      if (disposed) listener()
      else unlisten = listener
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  return (
    <header
      className="titlebar-overlay"
      data-tauri-drag-region
      onDoubleClick={event => {
        if (!(event.target as HTMLElement).closest('.window-controls')) void appWindow.toggleMaximize()
      }}
    >
      <div className="titlebar-brand" data-tauri-drag-region>
        <img src={fridayAvatar} alt="" />
        <span data-tauri-drag-region>Friday</span>
      </div>
      <div className="window-controls">
        <button aria-label="Minimize" className="win-dot win-minimize" onClick={() => void appWindow.minimize()} title="Minimize" type="button">
          <svg aria-hidden="true" viewBox="0 0 12 12"><path d="M2.5 6h7" /></svg>
        </button>
        <button
          aria-label={maximized ? 'Restore window' : 'Maximize window'}
          className="win-dot win-maximize"
          onClick={() => void appWindow.toggleMaximize()}
          title={maximized ? 'Restore' : 'Maximize'}
          type="button"
        >
          {maximized
            ? <svg aria-hidden="true" viewBox="0 0 12 12"><rect height="6" rx="0.8" width="6" x="1.8" y="4.2" /><path d="M4.2 4.2V1.8h6v6H7.8" /></svg>
            : <svg aria-hidden="true" viewBox="0 0 12 12"><path d="M6 2.5v7M2.5 6h7" /></svg>}
        </button>
        <button aria-label="Close" className="win-dot win-close" onClick={() => void appWindow.close()} title="Close" type="button">
          <svg aria-hidden="true" viewBox="0 0 12 12"><path d="M3 3l6 6M9 3 3 9" /></svg>
        </button>
      </div>
    </header>
  )
}

function verificationLabel(verification: VerificationStatus) {
  const label = verification.passed || verification.verdict === 'pass'
    ? t('verification.pass')
    : verification.error
      ? t('verification.error')
      : verification.verdict === 'blocked'
        ? t('verification.blocked')
        : verification.verdict === 'inconclusive'
          ? t('verification.inconclusive')
          : t('verification.failed')
  const feedback = verification.feedback?.trim()
  if (!feedback) return label
  const separator = getLanguage() === 'zh' ? '：' : ': '
  return `${label}${separator}${feedback.slice(0, 200)}`
}

function groupActivityItems(items: TimelineItem[]) {
  const rows: Array<TimelineItem | TimelineItem[]> = []
  for (const item of items) {
    if (item.kind !== 'tool' && item.kind !== 'reasoning') {
      rows.push(item)
      continue
    }
    const previous = rows.at(-1)
    if (Array.isArray(previous)) previous.push(item)
    else rows.push([item])
  }
  return rows
}

function bindCheckpoints(items: TimelineItem[], checkpoints: CheckpointChoice[], sessionId: string) {
  const userIndexes = items.flatMap((item, index) => item.kind === 'user' ? [index] : [])
  const ordered = checkpoints
    .filter(checkpoint => checkpoint.session_id === sessionId)
    .reverse()
    .slice(-userIndexes.length)
  if (!ordered.length) return items

  // Copy only the entries that change, so untouched rows keep their identity
  // and the memoized TimelineRow does not re-render (and re-parse markdown)
  // on every streamed chunk.
  const next = [...items]
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!
    if (item.checkpointId !== undefined) next[index] = { ...item, checkpointId: undefined }
  }
  const offset = userIndexes.length - ordered.length
  for (let position = offset; position < userIndexes.length; position += 1) {
    const checkpoint = ordered[position - offset]
    const index = userIndexes[position]!
    next[index] = { ...next[index]!, checkpointId: checkpoint!.id }
  }
  return next
}

function timelineFromHistory(history: HistoryItem[], sessionId: string) {
  return history.map((item, index): TimelineItem => {
    const id = `history-${index}-${item.tool_call_id || item.kind}`
    // Image data URLs are the largest strings a session carries. They go into
    // the LRU budget instead of the timeline itself, so a conversation with
    // many attachments does not pin every decoded copy for the life of the
    // window.
    const images = sessionId ? (item.images || []) : []
    if (images.length) writeMessageImages(sessionId, id, images)
    return {
      arguments: item.arguments == null ? undefined : capText(JSON.stringify(item.arguments, null, 2), MAX_TOOL_TEXT),
      artifacts: item.artifacts,
      attachments: item.attachments,
      id,
      forkIndex: item.kind === 'assistant' ? item.message_index : undefined,
      goal: item.goal,
      images: images.map((_, imageIndex) => imageCacheKey(sessionId, id, imageIndex)),
      kind: item.kind,
      // Saved with the reply, so reopening a conversation keeps the figures that
      // were shown when it was answered.
      metrics: item.metrics,
      name: item.name,
      status: item.status,
      text: capText(item.text, item.kind === 'tool' ? MAX_TOOL_TEXT : MAX_MESSAGE_TEXT),
      thinking: item.kind === 'reasoning'
        ? {
            duration: item.elapsed_ms ?? 0,
            ended: item.elapsed_ms ?? 0,
            error: item.status === 'error' || undefined,
            started: 0
          }
        : undefined,
      createdAt: item.timestamp,
      elapsed_ms: item.elapsed_ms,
      toolCallId: item.tool_call_id
    }
  })
}

// Thumbnails are base64 data URLs, so a session that scrolls past many image
// artifacts would otherwise pin every decoded copy for the life of the window.
// Insertion order doubles as recency: reads reinsert, eviction drops from the front.
const THUMB_LIMIT = 48
const THUMB_BYTES = 24 * 1024 * 1024
const artifactThumbCache = new Map<string, string>()
const artifactThumbPending = new Set<string>()
let artifactThumbBytes = 0

function readThumb(path: string) {
  const value = artifactThumbCache.get(path)
  if (value === undefined) return undefined
  artifactThumbCache.delete(path)
  artifactThumbCache.set(path, value)
  return value
}

function writeThumb(path: string, value: string) {
  artifactThumbBytes -= artifactThumbCache.get(path)?.length ?? 0
  artifactThumbCache.set(path, value)
  artifactThumbBytes += value.length
  while (artifactThumbCache.size > 1 && (artifactThumbCache.size > THUMB_LIMIT || artifactThumbBytes > THUMB_BYTES)) {
    const oldest = artifactThumbCache.keys().next()
    if (oldest.done) break
    artifactThumbBytes -= artifactThumbCache.get(oldest.value)?.length ?? 0
    artifactThumbCache.delete(oldest.value)
  }
}

function artifactExtension(artifact: ArtifactInfo) {
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(artifact.name)
  if (match) return match[1]!.toUpperCase()
  return ({ image: 'IMG', markdown: 'MD', pdf: 'PDF', text: 'TXT' } as const)[artifact.kind]
}

function artifactKindLabel(kind: ArtifactInfo['kind']) {
  return t(`artifact.${kind}`)
}

function ArtifactIcon({
  artifact,
  onLoad
}: {
  artifact: ArtifactInfo
  onLoad: (artifact: ArtifactInfo) => Promise<ArtifactDetail>
}) {
  const [, force] = useState(0)
  const isImage = artifact.kind === 'image'
  const cached = isImage ? readThumb(artifact.path) : undefined

  useEffect(() => {
    if (!isImage || cached !== undefined || artifactThumbPending.has(artifact.path)) return
    let live = true
    artifactThumbPending.add(artifact.path)
    onLoad(artifact)
      .then(detail => writeThumb(artifact.path, detail.data_url || ''))
      .catch(() => writeThumb(artifact.path, ''))
      .finally(() => {
        artifactThumbPending.delete(artifact.path)
        if (live) force(value => value + 1)
      })
    return () => {
      live = false
    }
  }, [isImage, cached, artifact.path])

  if (cached) {
    return (
      <span aria-hidden="true" className="artifact-icon thumb">
        <img alt="" src={cached} />
      </span>
    )
  }
  return <span aria-hidden="true" className={`artifact-icon ${artifact.kind}`}>{artifactExtension(artifact)}</span>
}

const TimelineRow = memo(function TimelineRow({
  busy,
  item,
  onFork,
  onLoadArtifact,
  onOpenArtifact,
  onOpenLink,
  onPreview,
  onRestore,
  sources
}: {
  busy: boolean
  item: TimelineItem
  onFork: (messageIndex: number) => void
  onLoadArtifact: (artifact: ArtifactInfo) => Promise<ArtifactDetail>
  onOpenArtifact: (artifact: ArtifactInfo) => void
  onOpenLink: (url: string) => void
  onPreview: (image: string) => void
  onRestore: (checkpointId: string) => void
  sources?: WebSource[]
}) {
  const [copied, setCopied] = useState(false)

  if (item.kind === 'system') {
    return <div className="system-row">{item.text}</div>
  }

  if (item.kind === 'reasoning') {
    return <ThinkingRow item={item} onOpenLink={onOpenLink} />
  }

  if (item.kind === 'tool') {
    return (
      <details className={`tool-row ${item.status}`}>
        <summary>
          <span aria-hidden="true" className="tool-status" />
          <strong>{toolActivityLabel(item)}</strong>
          {item.elapsed_ms != null && <small className="tool-time">{formatThinkingDuration(item.elapsed_ms)}</small>}
        </summary>
        <ToolDetails item={item} />
      </details>
    )
  }

  return (
    <article className={`message ${item.kind}`}>
      <div className="message-body">
        {item.kind === 'user' && item.goal && (
          <span className="message-goal"><TargetIcon /> {t('composer.goal')}</span>
        )}
        <div className="message-text">
          {item.streaming ? (
            // While the answer is in flight the text renders as-is: markdown
            // (and KaTeX) would re-parse on every flush, which is what makes
            // long generations grind.
            <div className="streaming-text">{item.text}</div>
          ) : (
            <ReactMarkdown
              components={markdownComponents(onOpenLink)}
              rehypePlugins={markdownRehypePlugins}
              remarkPlugins={markdownRemarkPlugins}
            >
              {normalizeMarkdown(item.text)}
            </ReactMarkdown>
          )}
        </div>
        {item.images?.length ? (
          <div className="message-images">
            {item.images.map((image, index) => {
              const src = readCachedImage(image)
              if (!src) return null
              return (
                <button key={`${item.id}-image-${index}`} onClick={() => onPreview(src)} type="button">
                  <img alt={`Attachment ${index + 1}`} src={src} />
                </button>
              )
            })}
          </div>
        ) : null}
        {item.attachments?.length ? (
          <div className="message-attachments">
            {item.attachments.map(attachment => (
              <span key={`${item.id}-${attachment.path}`} title={attachment.path}>
                {attachment.kind === 'folder' ? <FileFolderIcon /> : <FileIcon />}
                <span>
                  <strong>{attachment.name}</strong>
                  <small>
                    {t(`composer.${attachment.kind}`)}
                    {attachment.size != null ? ` · ${formatBytes(attachment.size)}` : ''}
                  </small>
                </span>
              </span>
            ))}
          </div>
        ) : null}
        {item.artifacts?.length ? (
          <div className="message-artifacts">
            {item.artifacts.map(artifact => (
              <button key={`${item.id}-${artifact.path}`} onClick={() => onOpenArtifact(artifact)} title={artifact.name} type="button">
                <ArtifactIcon artifact={artifact} onLoad={onLoadArtifact} />
                <span className="artifact-label">
                  <strong>{artifact.name}</strong>
                  <small>{artifactKindLabel(artifact.kind)} · {formatBytes(artifact.size)}</small>
                </span>
              </button>
            ))}
          </div>
        ) : null}
        {item.metrics && <MetricsLine metrics={item.metrics} />}
        {(item.kind === 'user' || item.checkpointId || item.forkIndex != null || sources?.length) && (
          <div className="message-meta">
            {sources && sources.length > 0 && (
              <span className="message-sources">
                <button aria-label={t('sources.aria', { count: sources.length })} className="sources-chip" type="button">
                  <span className="sources-preview">
                    {sources.slice(0, 3).map(source => (
                      <SiteIcon icon={source.icon} key={source.url} url={source.url} />
                    ))}
                  </span>
                  <span>{t('sources.trigger')}</span>
                  <span className="sources-count">{sources.length}</span>
                </button>
                <span className="sources-popover" role="tooltip">
                  <p>{t('sources.label', { count: sources.length })}</p>
                  <span className="sources-list">
                    {sources.map(source => (
                      <button
                        className="source-item"
                        key={source.url}
                        onClick={() => onOpenLink(source.url)}
                        title={source.url}
                        type="button"
                      >
                        <SiteIcon icon={source.icon} url={source.url} />
                        <span className="source-title">{source.title}</span>
                        <span className="source-host">{hostOf(source.url)}</span>
                      </button>
                    ))}
                  </span>
                </span>
              </span>
            )}
            {item.kind === 'user' && item.createdAt && (
              <time dateTime={item.createdAt}>
                {formatMessageTime(item.createdAt)}
              </time>
            )}
            {item.kind === 'user' && (
              <button
                aria-label={copied ? 'Copied' : 'Copy message'}
                className={copied ? 'copied' : ''}
                onClick={() => {
                  void navigator.clipboard.writeText(item.text).then(() => {
                    setCopied(true)
                    window.setTimeout(() => setCopied(false), 1200)
                  }).catch(() => setCopied(false))
                }}
                title={copied ? 'Copied' : 'Copy message'}
                type="button"
              >
                <span className="copy-icon" />
              </button>
            )}
            {item.kind === 'user' && item.checkpointId && (
              <button
                aria-label="Restore to before this turn"
                disabled={busy}
                onClick={() => onRestore(item.checkpointId!)}
                title="Restore to before this turn"
                type="button"
              >
                <UndoIcon className="restore-icon" />
              </button>
            )}
            {item.kind === 'assistant' && item.forkIndex != null && (
              <button
                aria-label="Fork conversation here"
                disabled={busy}
                onClick={() => onFork(item.forkIndex!)}
                title="Fork conversation here"
                type="button"
              >
                <BranchIcon />
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  )
})

const ThinkingRow = memo(function ThinkingRow({ item, onOpenLink }: { item: TimelineItem; onOpenLink: (url: string) => void }) {
  const thinking = item.thinking || { started: Date.now() }
  const done = thinking.ended != null
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (done) return
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [done])

  const elapsed = thinking.duration ?? Math.max(0, (thinking.ended ?? now) - thinking.started)
  const duration = formatThinkingDuration(elapsed)
  const label = done
    ? thinking.error
      ? t('thinking.interrupted', { duration })
      : t('thinking.done', { duration })
    : t('thinking.running')

  return (
    <details className={`thinking-row ${done ? 'done' : 'running'}`}>
      <summary>
        <span aria-hidden="true" className="thinking-orb" />
        <strong>{label}</strong>
        {!done && <span className="thinking-time">{formatThinkingDuration(elapsed)}</span>}
      </summary>
      <div className="thinking-content">
        {done ? (
          <ReactMarkdown
            components={markdownComponents(onOpenLink)}
            rehypePlugins={markdownRehypePlugins}
            remarkPlugins={markdownRemarkPlugins}
          >
            {normalizeMarkdown(item.text || '…')}
          </ReactMarkdown>
        ) : (
          // Same deal as assistant messages: no markdown parsing while the
          // chain of thought is still growing.
          <div className="streaming-text">{item.text || '…'}</div>
        )}
      </div>
    </details>
  )
})

function formatThinkingDuration(ms: number) {
  const seconds = Math.max(0, ms / 1000)
  const zh = getLanguage() === 'zh'
  if (seconds < 60) {
    const value = seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds))
    return zh ? `${value} 秒` : `${value}s`
  }
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  if (zh) return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function ActivityGroup({ items, onOpenLink }: { items: TimelineItem[]; onOpenLink: (url: string) => void }) {
  const thinking = items.filter(item => item.kind === 'reasoning')
  const tools = items.filter(item => item.kind === 'tool')
  const thinkingActive = thinking.some(item => item.thinking && item.thinking.ended == null)
  const status: NonNullable<TimelineItem['status']> = items.some(item => item.status === 'approval')
    ? 'approval'
    : items.some(item => item.status === 'running') || thinkingActive
      ? 'running'
      : items.some(item => item.status === 'error')
        ? 'error'
        : 'done'
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!thinkingActive) return
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [thinkingActive])

  // All reasoning of a turn reads as one block; tool runs aggregate by name,
  // so a long turn stays a few rows until a group is asked to open.
  const mergedThinking: TimelineItem | null = thinking.length
    ? (() => {
        const started = Math.min(...thinking.map(item => item.thinking?.started ?? Date.now()))
        const nowMs = Date.now()
        const ended = thinkingActive
          ? undefined
          : Math.max(...thinking.map(item => item.thinking?.ended ?? nowMs))
        return {
          id: `${thinking[0]!.id}-merged`,
          kind: 'reasoning',
          text: thinking.map(item => item.text).filter(Boolean).join('\n\n'),
          thinking: {
            error: thinking.some(item => item.thinking?.error),
            started,
            ended,
            // The span between the first start and the last end includes the
            // tool rounds in between; the real figure is the sum of the
            // individual blocks' own times.
            duration: thinking.reduce(
              (sum, item) => sum + Math.max(0, (item.thinking?.ended ?? nowMs) - (item.thinking?.started ?? nowMs)),
              0
            )
          }
        }
      })()
    : null
  const groups: Array<{ name: string; runs: TimelineItem[] }> = []
  for (const tool of tools) {
    const name = tool.name || 'Tool'
    const last = groups.at(-1)
    if (last && last.name === name) last.runs.push(tool)
    else groups.push({ name, runs: [tool] })
  }

  return (
    <details className={`tool-row tool-group ${status}`}>
      <summary>
        <span aria-hidden="true" className="tool-status" />
        <strong>{activityGroupLabel(items, status, now)}</strong>
      </summary>
      <div className="tool-group-list">
        {mergedThinking && <ThinkingRow item={mergedThinking} key={mergedThinking.id} onOpenLink={onOpenLink} />}
        {groups.map((group, groupIndex) => {
          const total = group.runs.reduce((sum, run) => sum + (run.elapsed_ms ?? 0), 0)
          return (
            <details className="tool-subrow tool-group-sub" key={`${group.name}-${groupIndex}`}>
              <summary>
                <span aria-hidden="true" className="tool-status" />
                <strong>{group.name}</strong>
                <span className="tool-group-count">{group.runs.length}</span>
                {total > 0 && <small className="tool-time">{formatThinkingDuration(total)}</small>}
              </summary>
              <div className="tool-group-sub-list">
                {group.runs.map((run, index) => (
                  <details className={`tool-subrow ${run.status}`} key={run.id}>
                    <summary>
                      <span aria-hidden="true" className="tool-status" />
                      <strong>{toolActivityLabel(run)}</strong>
                      <small>#{index + 1}</small>
                      {run.elapsed_ms != null && <small className="tool-time">{formatThinkingDuration(run.elapsed_ms)}</small>}
                    </summary>
                    <ToolDetails item={run} />
                  </details>
                ))}
              </div>
            </details>
          )
        })}
      </div>
    </details>
  )
}

function activityGroupLabel(items: TimelineItem[], status: NonNullable<TimelineItem['status']>, now: number) {
  const reasoning = items.filter(item => item.kind === 'reasoning')
  const tools = items.filter(item => item.kind === 'tool')
  const active = reasoning.find(item => item.thinking && item.thinking.ended == null)
  if (active) {
    const started = active.thinking?.started ?? now
    return t('thinking.runningWith', { duration: formatThinkingDuration(Math.max(0, now - started)) })
  }
  const parts: string[] = []
  if (reasoning.length) {
    const errored = reasoning.some(item => item.thinking?.error)
    const total = reasoning.reduce((sum, item) => {
      const thinking = item.thinking
      return thinking ? sum + Math.max(0, (thinking.ended ?? now) - thinking.started) : sum
    }, 0)
    const duration = formatThinkingDuration(total)
    parts.push(errored ? t('thinking.interrupted', { duration }) : t('thinking.done', { duration }))
  }
  if (tools.length) parts.push(tools.length === 1 ? toolActivityLabel(tools[0]!) : toolGroupLabel(tools, status))
  return parts.join(' · ')
}

function ToolDetails({ item }: { item: TimelineItem }) {
  return (
    <div className="tool-details">
      <strong>Arguments</strong>
      <pre>{item.arguments}</pre>
      {item.text && (
        <>
          <strong>Result</strong>
          <pre>{item.text}</pre>
        </>
      )}
    </div>
  )
}

type ToolKey = 'bash' | 'find' | 'generic' | 'plan' | 'read' | 'webfetch' | 'websearch' | 'write'

function toolKey(name = ''): ToolKey {
  const value = name.toLocaleLowerCase()
  if (value === 'websearch') return 'websearch'
  if (value === 'webfetch') return 'webfetch'
  if (value === 'bash') return 'bash'
  if (value === 'read') return 'read'
  if (value === 'write' || value === 'edit') return 'write'
  if (value === 'glob' || value === 'grep') return 'find'
  if (value === 'updateplan') return 'plan'
  return 'generic'
}

function lcFirst(text: string) {
  return text ? text[0]!.toLocaleLowerCase() + text.slice(1) : text
}

function ucFirst(text: string) {
  return text ? text[0]!.toLocaleUpperCase() + text.slice(1) : text
}

function joinActivity(parts: string[]) {
  return getLanguage() === 'zh' ? parts.join('\u3001') : parts.join(', ')
}

function toolActivityLabel(item: TimelineItem) {
  const key = toolKey(item.name)
  if (item.status === 'running') return t(`tool.${key}.doing`)
  if (item.status === 'approval') return t('activity.approval', { verb: t(`tool.${key}.verb`) })
  if (item.status === 'error') return t('activity.error', { verb: t(`tool.${key}.verb`), doing: lcFirst(t(`tool.${key}.doing`)) })
  return t(`tool.${key}.did`)
}

function toolGroupLabel(items: TimelineItem[], status: NonNullable<TimelineItem['status']>) {
  const keys = [...new Set(items.map(item => toolKey(item.name)))]
  if (keys.length === 1 && items.length > 1) {
    const key = keys[0]!
    if (status === 'running') return t(`tool.${key}.doingMulti`)
    if (status === 'approval') return t('activity.approvalMulti')
    if (status === 'error') return t('activity.errorMulti')
    return t(`tool.${key}.didMulti`)
  }
  if (status === 'running') return ucFirst(joinActivity(keys.map(key => lcFirst(t(`tool.${key}.doing`)))))
  if (status === 'approval') return t('activity.approvalMulti')
  if (status === 'error') return t('activity.errorMulti')
  return joinActivity(keys.map(key => t(`tool.${key}.did`)))
}

/**
 * One level and several running totals, which is why the line needs care.
 *
 * The window figure is how full the conversation is right now. The token counts
 * are sums over every request the turn made, and a turn that used ten tools made
 * ten requests, each re-sending the whole conversation -- so the input total runs
 * far ahead of the window and reads like a contradiction unless the request count
 * is there to explain it. Cache is quoted inside the input it is part of, for the
 * same reason: beside it, it looked like a second, larger context.
 */
function MetricsLine({ metrics }: { metrics: Metrics }) {
  const mark = metrics.estimated_tokens ? '~' : ''
  const parts: string[] = []
  if (metrics.window_tokens != null && metrics.window) {
    parts.push(
      t('metrics.window', {
        percent: `${Math.round((metrics.window_tokens / metrics.window) * 100)}%`,
        total: shortTokens(metrics.window),
        // Occupancy is always Friday's own estimate, never a provider count.
        used: `~${shortTokens(metrics.window_tokens)}`
      })
    )
  }
  if (metrics.requests) {
    parts.push(t(metrics.requests === 1 ? 'metrics.request' : 'metrics.requests', { count: String(metrics.requests) }))
  }
  parts.push(
    t('metrics.cost', {
      // Zero included: an absent figure reads the same as a cache that never hit.
      cached: metrics.cached_tokens == null ? 'n/a' : shortTokens(metrics.cached_tokens),
      input: metrics.input_tokens == null ? 'n/a' : `${mark}${shortTokens(metrics.input_tokens)}`,
      output: metrics.output_tokens == null ? 'n/a' : `${mark}${shortTokens(metrics.output_tokens)}`
    })
  )
  parts.push(metrics.elapsed_ms == null ? 'n/a' : `${(metrics.elapsed_ms / 1000).toFixed(1)}s`)
  return (
    <div className="metrics">
      <span className="metrics-summary">{parts.join(' · ')}</span>
      <button aria-label={t('metrics.info')} className="metrics-info" title={t('metrics.info')} type="button">
        <InfoIcon />
      </button>
      <span className="metrics-popover" role="tooltip">
        <p>{t('metrics.explain')}</p>
      </span>
    </div>
  )
}

function sessionLabel(session: ResumeChoice) {
  return session.title || session.objective || session.user || session.assistant || 'Conversation'
}

function projectLabel(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) || 'No project'
}

function formatSessionTime(value: string) {
  return value ? value.replace('T', ' ').slice(0, 16) : 'Saved'
}

function formatMessageTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value))
}

export default App
