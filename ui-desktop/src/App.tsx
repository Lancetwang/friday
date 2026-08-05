import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open } from '@tauri-apps/plugin-dialog'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { CSSProperties, FormEvent, KeyboardEvent, MouseEvent, PointerEvent as ReactPointerEvent, ReactNode, useEffect, useRef, useState } from 'react'
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
  MinusIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  UndoIcon
} from './Icons'
import { normalizeMarkdownMath } from './markdown'
import { MenuDetails } from './MenuDetails'
import { PhoneBridgeSettings, type BridgeStatus, type FeishuSettings } from './PhoneBridgeSettings'
import { SaveFooter, SecretField, SettingsMessage, useSettingsSave } from './SettingsForm'
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
  elapsed_ms?: number
  estimated_tokens?: boolean
  input_tokens?: number | null
  output_tokens?: number | null
}

type PermissionMode = 'auto' | 'bypass' | 'manual'
type ProjectStatus = 'connecting' | 'error' | 'idle' | 'ready'
type ThinkingEffort = 'high' | 'low' | 'max' | 'off'

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
  { descriptionKey: 'effort.low.desc', labelKey: 'effort.low', value: 'low' },
  { descriptionKey: 'effort.high.desc', labelKey: 'effort.high', value: 'high' },
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
  thinking_supported?: boolean
  session_id?: string
  running?: boolean
  tools: string[]
}

type ModelProfile = {
  api_key_configured: boolean
  base_url: string
  context_window: number
  id: string
  max_output_tokens: number
  model: string
  name: string
  provider: string
  run_token_budget: number
  vision: boolean
}

type ModelProvider = {
  base_url: string
  id: string
  label: string
  models: Array<{ id: string; vision: boolean }>
}

type ModelCatalog = {
  active: string
  profiles: ModelProfile[]
  providers: ModelProvider[]
}

type WebSearchSettings = {
  anysearch_configured: boolean
  tavily_configured: boolean
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
  bridge: BridgeStatus
  feishu: FeishuSettings
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
  name: string
}

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
  images?: string[]
  kind: TimelineItem['kind']
  message_index?: number
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
}

type TimelineItem = {
  arguments?: string
  artifacts?: ArtifactInfo[]
  checkpointId?: string
  createdAt?: string
  id: string
  forkIndex?: number
  images?: string[]
  kind: 'assistant' | 'reasoning' | 'system' | 'tool' | 'user'
  metrics?: Metrics
  name?: string
  status?: 'approval' | 'done' | 'error' | 'running'
  text: string
  thinking?: ThinkingState
  toolCallId?: string
}

type ForkNode = {
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
  attachment: ImageAttachment | null
  busy: boolean
  cancelling: boolean
  checkpoints: CheckpointChoice[]
  draft: string
  guidance: string
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

const PROJECTS_KEY = 'friday.desktop.projects'
const ACTIVE_PROJECT_KEY = 'friday.desktop.activeProject'
const SIDEBAR_WIDTH_KEY = 'friday.desktop.sidebarWidth'
const THEME_KEY = 'friday.desktop.theme'
const DEFAULT_SIDEBAR_WIDTH = 252
const PHONE_POLL_MS = 8000

type SidebarSection = 'phone' | 'projects' | 'recent'
const MIN_SIDEBAR_WIDTH = 180
const MAX_SIDEBAR_WIDTH = 520
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const WELCOME_MESSAGE_KEYS = ['welcome.0', 'welcome.1', 'welcome.2']
const emptyModelCatalog: ModelCatalog = { active: '', profiles: [], providers: [] }

function nextId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function emptyView(path = ''): ProjectView {
  return {
    activeSession: '',
    attachment: null,
    busy: false,
    cancelling: false,
    checkpoints: [],
    draft: '',
    guidance: '',
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
    reader.onload = () => resolve({ dataUrl: String(reader.result || ''), name: file.name || 'Pasted image' })
    reader.readAsDataURL(file)
  })
}

function loadProjects() {
  try {
    const value = JSON.parse(localStorage.getItem(PROJECTS_KEY) || '[]')
    if (!Array.isArray(value)) return []
    const seen = new Set<string>()
    return value.filter(item => {
      if (typeof item !== 'string') return false
      const key = pathKey(item)
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
  } catch {
    return []
  }
}

function pathKey(path: string) {
  return path.trim().replace(/[\\/]+$/, '').replace(/\//g, '\\').toLocaleLowerCase()
}

function samePath(left: string, right: string) {
  return pathKey(left) === pathKey(right)
}

function sessionEventKey(workspace: string, sessionId: string) {
  return `${pathKey(workspace)}::${sessionId}`
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
  const [phoneSessions, setPhoneSessions] = useState<ResumeChoice[]>([])
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
  const timeline = useRef<HTMLElement | null>(null)
  const followOutput = useRef(true)
  const pendingRequests = useRef(new Map<string, PendingRequest>())
  const requestId = useRef(0)
  const sidebarDrag = useRef<{ startWidth: number; startX: number } | null>(null)
  const startedProjects = useRef(new Set<string>())
  const openProjects = useRef(new Set(initialProjects.current.map(pathKey)))
  const selectProjectRef = useRef<(workspace: string) => Promise<string | undefined>>(async () => undefined)

  const view = views[activeProject] || emptyView(activeProject)
  const { activeSession, attachment, busy, cancelling, checkpoints, draft, forkTree, guidance, info, items, models, pendingApproval, sessions, skills, status } = view
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

  const sendGateway = <T,>(workspace: string, method: string, params: Record<string, unknown> = {}) => {
    const id = `desktop-${++requestId.current}`
    return new Promise<T>((resolve, reject) => {
      pendingRequests.current.set(id, { resolve: value => resolve(value as T), reject, workspace })
      const message = JSON.stringify({ id, jsonrpc: '2.0', method, params })
      const write = () => invoke('gateway_send', { workspace, message })
      void write().catch(async error => {
        if (!String(error).includes('gateway is not running')) throw error
        const resolved = await invoke<string>('gateway_start', { workspace })
        startedProjects.current.add(pathKey(resolved))
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

  const hydrateProject = (workspace: string) =>
    Promise.all([
      sendGateway<{ history: HistoryItem[]; info: SessionInfo }>(workspace, 'session.current'),
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
        items: timelineFromHistory(current.history),
        models: modelResult,
        pendingApproval: current.info.approval?.pending ? current.info.approval : null,
        sessions: saved.choices,
        skills: skillResult.skills,
        status: 'ready'
      }))
      return refreshTree(workspace, current.info.session_id)
    })

  useEffect(() => {
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
    let disposed = false

    const handleLine = (workspace: string, line: string) => {
      let message: GatewayMessage
      try {
        message = JSON.parse(line) as GatewayMessage
      } catch {
        return
      }

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
        if (type === 'message.complete' || type === 'message.cancelled' || type === 'session.updated') {
          activeAssistants.current.delete(eventKey)
          void refreshSessions(workspace).catch(() => undefined)
        }
        return
      }

      if (type === 'reasoning.delta') {
        const reasoningId = String(payload.id || '')
        const text = String(payload.text || '')
        if (!reasoningId || !text) return
        const itemId = `thinking-${reasoningId}`
        const assistantId = activeAssistants.current.get(eventKey)
        updateView(workspace, current => {
          if (current.items.some(item => item.id === itemId)) {
            return {
              ...current,
              items: current.items.map(item => item.id === itemId ? { ...item, text: item.text + text } : item)
            }
          }
          const block: TimelineItem = { id: itemId, kind: 'reasoning', text, thinking: { started: Date.now() } }
          const index = assistantId ? current.items.findIndex(item => item.id === assistantId) : -1
          return {
            ...current,
            items: index < 0
              ? [...current.items, block]
              : [...current.items.slice(0, index), block, ...current.items.slice(index)]
          }
        })
      } else if (type === 'reasoning.complete') {
        const itemId = `thinking-${String(payload.id || '')}`
        const error = Boolean(payload.error)
        updateView(workspace, current => ({
          ...current,
          items: current.items.map(item =>
            item.id === itemId && item.thinking && item.thinking.ended == null
              ? { ...item, thinking: { ...item.thinking, ended: Date.now(), error: error || undefined } }
              : item)
        }))
      } else if (type === 'message.delta') {
        const text = String(payload.text || '')
        let id = activeAssistants.current.get(eventKey)
        if (!id) {
          id = nextId('assistant')
          activeAssistants.current.set(eventKey, id)
        }
        updateView(workspace, current => {
          const now = Date.now()
          let found = false
          const items = current.items.map(item => {
            if (item.kind === 'reasoning' && item.thinking && item.thinking.ended == null) {
              return { ...item, thinking: { ...item.thinking, ended: now } }
            }
            if (item.id === id) {
              found = true
              return { ...item, text: item.text + text }
            }
            return item
          })
          return {
            ...current,
            items: found ? items : [...items, { id, kind: 'assistant', text }]
          }
        })
      } else if (type === 'message.suspended') {
        updateView(workspace, current => ({
          ...current,
          busy: false,
          cancelling: false
        }))
      } else if (type === 'message.complete') {
        const text = String(payload.text || '')
        const metrics = (payload.metrics || {}) as Metrics
        const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts as ArtifactInfo[] : []
        const forkPoints = Array.isArray(payload.fork_points)
          ? payload.fork_points as Array<{ kind: string; message_index: number }>
          : []
        const verification = payload.verification as VerificationStatus | undefined
        const id = activeAssistants.current.get(eventKey)
        activeAssistants.current.delete(eventKey)
        updateView(workspace, current => {
          let items: TimelineItem[] = id
            ? current.items.map(item => item.id === id ? { ...item, artifacts, metrics, text: text || item.text } : item)
            : text ? [...current.items, { artifacts, id: nextId('assistant'), kind: 'assistant', metrics, text }] : current.items
          items = verification
            ? items.map(item => item.id === 'verification-status' ? { ...item, text: verificationLabel(verification) } : item)
            : items.filter(item => item.id !== 'verification-status')
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
        void refreshSessions(workspace).catch(() => undefined)
      } else if (type === 'tool.start') {
        const assistantId = activeAssistants.current.get(eventKey)
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
          return {
            ...current,
            items: index < 0
              ? [...current.items, tool]
              : [...current.items.slice(0, index), tool, ...current.items.slice(index)]
          }
        })
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
              status: approval?.approval_required ? 'approval' : payload.error ? 'error' : 'done',
              text: String(payload.content || nextItems[index].text)
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
          pendingApproval: null
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
      }
    }

    void (async () => {
      unlisten = await listen<[string, string]>('gateway-line', event => handleLine(event.payload[0], event.payload[1]))
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
      startedProjects.current.add(pathKey(workspace))
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

  const submit = async (event?: FormEvent) => {
    event?.preventDefault()
    const text = draft.trim() || (attachment ? 'Please analyze the attached image.' : '')
    if (!text || busy || pendingApproval || status !== 'ready') return
    const submittedSession = activeSession

    followOutput.current = true
    updateView(activeProject, current => ({
      ...current,
      attachment: null,
      busy: true,
      cancelling: false,
      draft: '',
      items: [
        ...current.items,
        {
          createdAt: new Date().toISOString(),
          id: nextId('user'),
          images: attachment ? [attachment.dataUrl] : [],
          kind: 'user',
          text
        }
      ]
    }))
    try {
      await sendGateway(activeProject, 'chat.send', { images: attachment ? [attachment.dataUrl] : [], text })
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
    updateView(activeProject, current => ({ ...current, cancelling: true }))
    void sendGateway<{ cancelled: boolean }>(activeProject, 'chat.cancel', { session_id: activeSession })
      .then(result => {
        if (result.cancelled) return
        updateView(activeProject, current => ({ ...current, busy: false, cancelling: false }))
      })
      .catch(error => {
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
    profile: Omit<ModelProfile, 'api_key_configured' | 'vision'>,
    apiKey: string,
    clearApiKey: boolean
  ) => sendGateway<{ catalog: ModelCatalog; info: SessionInfo }>(activeProject, 'model.save', {
    activate: true,
    api_key: apiKey || undefined,
    clear_api_key: clearApiKey,
    profile
  }).then(result => {
    updateView(activeProject, current => ({ ...current, info: result.info, models: result.catalog }))
    return result.catalog
  })

  const settingsWorkspace = activeProject || defaultWorkspace

  // A phone turn is answered by the bridge's own gateway, so none of its events
  // reach this window. The conversations land in the same files either way, so the
  // sidebar polls for them instead of waiting for an event that never arrives.
  useEffect(() => {
    if (!settingsWorkspace) return
    let live = true
    const read = () => {
      void sendGateway<{ choices: ResumeChoice[] }>(settingsWorkspace, 'bridge.sessions')
        .then(result => { if (live) setPhoneSessions(result.choices) })
        .catch(() => undefined)
    }
    read()
    const timer = setInterval(read, PHONE_POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [settingsWorkspace])

  const changeLanguage = (next: Language) => {
    setLanguage(next)
    setLanguageState(next)
  }
  const loadSettings = () => sendGateway<AppSettings>(settingsWorkspace, 'settings.get')
  const saveWebSettings = (value: Record<string, unknown>) =>
    sendGateway<WebSearchSettings>(settingsWorkspace, 'settings.web.save', value)
  const saveUserProfile = (profile: Partial<UserProfileSettings>) =>
    sendGateway<UserProfileSettings>(settingsWorkspace, 'settings.user.save', { profile })
  const saveFeishuSettings = (value: Record<string, unknown>) =>
    sendGateway<{ bridge: BridgeStatus; feishu: FeishuSettings }>(
      settingsWorkspace,
      'settings.feishu.save',
      value
    )
  const setBridgeRunning = (running: boolean) =>
    sendGateway<BridgeStatus>(settingsWorkspace, running ? 'bridge.start' : 'bridge.stop')
  const readBridgeStatus = () => sendGateway<BridgeStatus>(settingsWorkspace, 'bridge.status')
  const readMemoryFile = (file: MemoryFileScope) =>
    sendGateway<MemoryFileDetail>(settingsWorkspace, 'settings.memory.read', { file })
  const saveMemoryFileContent = (file: MemoryFileScope, content: string) =>
    sendGateway<MemoryFileInfo>(settingsWorkspace, 'settings.memory.save', { content, file })

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
        busy: false,
        cancelling: false,
        checkpoints: [],
        forkTree: { nodes: [], root: '' },
        info: result.info,
        items: timelineFromHistory(result.history),
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
        items: timelineFromHistory(result.history),
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
      startedProjects.current.add(pathKey(resolved))
      openProjects.current.add(pathKey(resolved))
      if (tracked) rememberProject(resolved)
      else setDefaultWorkspace(resolved)
      if (expand) setExpandedProjects(current => new Set(current).add(pathKey(resolved)))
      activeProjectRef.current = resolved
      setActiveProject(resolved)
      if (!wasStarted || !views[resolved]) await hydrateProject(resolved)
      return resolved
    } catch (error) {
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

  const closeProject = async (event: MouseEvent, workspace: string) => {
    event.stopPropagation()
    try {
      // Untrack it in the gateway registry too, or the next launch re-adds it.
      await sendGateway(workspace, 'projects.forget', { workspace }).catch(() => undefined)
      await invoke('gateway_stop', { workspace })
    } catch (error) {
      updateView(workspace, current => ({
        ...current,
        items: [...current.items, { id: nextId('close-project'), kind: 'system', text: String(error) }]
      }))
      return
    }

    const key = pathKey(workspace)
    openProjects.current.delete(key)
    startedProjects.current.delete(key)
    activeSessions.current.delete(key)
    activeAssistants.current.delete(key)
    setExpandedProjects(current => {
      const next = new Set(current)
      next.delete(key)
      return next
    })
    for (const [id, pending] of pendingRequests.current) {
      if (samePath(pending.workspace, workspace)) {
        pending.reject(new Error('Project closed.'))
        pendingRequests.current.delete(id)
      }
    }
    const remaining = projects.filter(path => !samePath(path, workspace))
    setProjects(remaining)
    setViews(current => {
      const next = { ...current }
      for (const path of Object.keys(next)) {
        if (samePath(path, workspace)) delete next[path]
      }
      return next
    })

    if (samePath(activeProject, workspace)) {
      const next = remaining[0]
      if (next) await selectProject(next)
      else await selectWorkspace()
    }
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
              attachment: null,
              checkpoints: [],
              info: result.info,
              items: timelineFromHistory(result.history),
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

  const restoreCheckpoint = (checkpointId: string) => {
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
        items: timelineFromHistory(result.history),
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
  }

  const forkConversation = (messageIndex: number) => {
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
        items: timelineFromHistory(result.history),
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
  }

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
          items: timelineFromHistory(result.history),
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

  const loadArtifact = (artifact: ArtifactInfo) =>
    sendGateway<ArtifactDetail>(activeProject, 'artifact.get', { path: artifact.path })

  const openArtifact = (artifact: ArtifactInfo) => {
    void loadArtifact(artifact)
      .then(setArtifactPreview)
      .catch(error => updateView(activeProject, current => ({
        ...current,
        items: [...current.items, { id: nextId('artifact'), kind: 'system', text: String(error) }]
      })))
  }

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
  const thinking = thinkingOptions.find(option => option.value === info.thinking_effort) || thinkingOptions[2]
  const selectedModel = models.profiles.find(profile => profile.id === info.model_profile)

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submit()
    }
  }

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
    const onPhone = new Set(phoneSessions.map(session => session.id))
    // A phone conversation has its own section, so listing it here as well would
    // show the same conversation twice under two names.
    return renderSessionList(workspace, projectView.sessions.filter(session => !onPhone.has(session.id)))
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

  const timelineItems = bindCheckpoints(items, checkpoints, activeSession)
  const sourcesByMessage = collectMessageSources(timelineItems)
  const showWelcome = status === 'ready' && !activeSession && !timelineItems.length && !pendingApproval && !busy

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

            <section className={`sidebar-section phone-space ${collapsedSections.has('phone') ? 'collapsed' : ''}`}>
              <div className="section-heading">
                {renderSectionHeading('phone', t('sidebar.phone'), <PhoneIcon />)}
              </div>
              <div aria-hidden={collapsedSections.has('phone')} className="section-body" inert={collapsedSections.has('phone')}>
                <div className="section-body-content">
                  {phoneSessions.length > 0
                    ? renderSessionList(settingsWorkspace, phoneSessions)
                    : <div className="empty-sessions">{t('sidebar.phoneEmpty')}</div>}
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
            onClose={() => setPage('chat')}
            onLanguageChange={changeLanguage}
            onLoad={loadSettings}
            onReadMemory={readMemoryFile}
            onBridgeStatus={readBridgeStatus}
            onBridgeToggle={setBridgeRunning}
            onSave={saveModel}
            onSaveFeishu={saveFeishuSettings}
            onSaveMemory={saveMemoryFileContent}
            onSaveProfile={saveUserProfile}
            onSaveWeb={saveWebSettings}
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
          {showWelcome && <WelcomePrompt key={activeProject} />}
          {!showWelcome && groupActivityItems(timelineItems).map(item => Array.isArray(item)
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
          {attachment && (
            <div className="composer-attachment">
              <img alt={attachment.name} src={attachment.dataUrl} />
              <button
                aria-label={t('composer.removeAttachment')}
                onClick={() => updateView(activeProject, current => ({ ...current, attachment: null }))}
                title={t('composer.removeAttachment')}
                type="button"
              >
                <CloseIcon />
              </button>
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
                updateView(activeProject, current => ({ ...current, attachment: value }))
              }).catch(error => {
                updateView(activeProject, current => ({
                  ...current,
                  items: [...current.items, { id: nextId('image'), kind: 'system', text: String(error) }]
                }))
              })
            }}
            placeholder={pendingApproval ? t('composer.approvalBlocked') : status === 'ready' ? t('composer.placeholder') : t('composer.starting')}
            rows={2}
            value={draft}
          />
          <div className="composer-footer">
            <MenuDetails
              className={`permission-picker ${busy ? 'disabled' : ''}`}
              key={`${activeProject}-permissions`}
            >
              <summary
                aria-disabled={busy}
                aria-label="Permission mode"
                onClick={event => {
                  if (busy) event.preventDefault()
                }}
                tabIndex={busy ? -1 : 0}
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
            <div className="composer-actions">
              <MenuDetails
                className={`model-picker ${busy ? 'disabled' : ''}`}
                key={`${activeProject}-${info.model_profile}`}
              >
                <summary aria-disabled={busy} onClick={event => busy && event.preventDefault()}>
                  <ProviderIcon label={selectedModel?.name || info.model_name || info.model} provider={selectedModel?.provider || ''} />
                  {selectedModel?.vision && <VisionIcon />}
                  <span>{selectedModel?.name || info.model_name || info.model}</span>
                  <i aria-hidden="true" />
                </summary>
                <div className="model-menu">
                  {models.profiles.map(profile => (
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
                          <strong><span>{profile.name}</span>{profile.vision && <VisionIcon />}</strong>
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
                    {thinkingOptions.map(option => (
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
                disabled={cancelling || (!busy && ((!draft.trim() && !attachment) || Boolean(pendingApproval) || status !== 'ready'))}
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
                    {normalizeMarkdownMath(artifactPreview.content || '')}
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
  const [message] = useState(() => t(WELCOME_MESSAGE_KEYS[Math.floor(Math.random() * WELCOME_MESSAGE_KEYS.length)]!))
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
          {hoveredParent && <span className="fork-tip-parent">{t('fork.from', { title: hoveredParent.title })}</span>}
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

function PhoneIcon() {
  return (
    <svg aria-hidden="true" className="section-icon" fill="none" viewBox="0 0 24 24">
      <rect height="18.4" rx="2.6" width="12.4" x="5.8" y="2.8" />
      <path d="M10.4 18.2h3.2" />
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

type ModelDraft = Omit<ModelProfile, 'api_key_configured' | 'vision'>

function VisionIcon() {
  return (
    <svg aria-label="Supports vision" className="vision-icon" fill="none" viewBox="0 0 24 24">
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  )
}

const PROVIDER_ICON_URLS: Readonly<Record<string, string>> = {
  anthropic: 'https://www.anthropic.com/favicon.ico',
  anysearch: 'https://www.anysearch.com/favicon.ico',
  deepseek: 'https://www.deepseek.com/favicon.ico',
  mimo: 'https://mimo.mi.com/favicon.png',
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

type SettingsSection = 'docs' | 'general' | 'models' | 'web' | 'memory' | 'phone'

const SETTINGS_SECTIONS: ReadonlyArray<{ hintKey: string; id: SettingsSection; labelKey: string }> = [
  { hintKey: 'settings.general.hint', id: 'general', labelKey: 'settings.general' },
  { hintKey: 'settings.models.hint', id: 'models', labelKey: 'settings.models' },
  { hintKey: 'settings.web.hint', id: 'web', labelKey: 'settings.web' },
  { hintKey: 'settings.phone.hint', id: 'phone', labelKey: 'settings.phone' },
  { hintKey: 'settings.memory.hint', id: 'memory', labelKey: 'settings.memory' },
  { hintKey: 'settings.docs.hint', id: 'docs', labelKey: 'settings.docs' }
]

function ConfigBadge({ configured }: { configured: boolean }) {
  return (
    <span className={`config-badge ${configured ? 'on' : 'off'}`}>
      <svg aria-hidden="true" fill="none" viewBox="0 0 10 10">
        {configured ? <path d="M1.6 5.4 4 7.8 8.4 2.6" /> : <circle cx="5" cy="5" r="3.4" />}
      </svg>
      {configured ? t('badge.configured') : t('badge.unconfigured')}
    </span>
  )
}

function SettingsPage({
  catalog,
  initialSection,
  language,
  onBridgeStatus,
  onBridgeToggle,
  onClose,
  onLanguageChange,
  onLoad,
  onReadMemory,
  onSave,
  onSaveFeishu,
  onSaveMemory,
  onSaveProfile,
  onSaveWeb
}: {
  catalog: ModelCatalog
  initialSection: SettingsSection
  language: Language
  onBridgeStatus: () => Promise<BridgeStatus>
  onBridgeToggle: (running: boolean) => Promise<BridgeStatus>
  onClose: () => void
  onLanguageChange: (language: Language) => void
  onLoad: () => Promise<AppSettings>
  onReadMemory: (file: MemoryFileScope) => Promise<MemoryFileDetail>
  onSave: (profile: ModelDraft, apiKey: string, clearApiKey: boolean) => Promise<ModelCatalog>
  onSaveFeishu: (value: Record<string, unknown>) => Promise<{ bridge: BridgeStatus; feishu: FeishuSettings }>
  onSaveMemory: (file: MemoryFileScope, content: string) => Promise<MemoryFileInfo>
  onSaveProfile: (profile: Partial<UserProfileSettings>) => Promise<UserProfileSettings>
  onSaveWeb: (value: Record<string, unknown>) => Promise<WebSearchSettings>
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [settingsError, setSettingsError] = useState('')
  const [draft, setDraft] = useState<ModelDraft | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [clearApiKey, setClearApiKey] = useState(false)
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

  const openProvider = (item: ModelProvider) => {
    modelForm.clear()
    if (expandedProvider === item.id) {
      setExpandedProvider('')
      return
    }
    const profile = catalog.profiles.find(entry => entry.provider === item.id)
    setExpandedProvider(item.id)
    setDraft({ ...modelDraft(profile, item), name: item.label })
    setApiKey('')
    setClearApiKey(false)
  }

  const save = (event: FormEvent) => {
    event.preventDefault()
    if (!draft) return
    modelForm.submit(onSave(draft, apiKey, clearApiKey), () => {
      setApiKey('')
      setClearApiKey(false)
      return t('models.savedActive')
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

  const persistFeishu = (value: Record<string, unknown>) => onSaveFeishu(value).then(result => {
    setSettings(current => current ? { ...current, bridge: result.bridge, feishu: result.feishu } : current)
    return result.feishu
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
              <p>{t('models.desc')}</p>
            </header>
            <div className="provider-list">
              {catalog.providers.map(item => {
                const profile = catalog.profiles.find(entry => entry.provider === item.id)
                const expanded = expandedProvider === item.id
                const configured = Boolean(profile?.api_key_configured)
                const inUse = Boolean(profile && profile.id === catalog.active)
                const vision = expanded && draft
                  ? item.models.find(entry => entry.id === draft.model)?.vision || false
                  : false
                return (
                  <div className={`provider-item ${expanded ? 'expanded' : ''}`} key={item.id}>
                    <button
                      aria-expanded={expanded}
                      className="provider-row"
                      onClick={() => openProvider(item)}
                      type="button"
                    >
                      <span className="provider-id">
                        <ProviderIcon label={item.label} provider={item.id} />
                        <span className="provider-copy">
                          <strong>{item.label}</strong>
                          <small>{hostOf(item.base_url) || item.base_url}</small>
                        </span>
                      </span>
                      <span className="provider-state">
                        {inUse && <span className="provider-in-use">{t('models.inUse')}</span>}
                        <ConfigBadge configured={configured} />
                      </span>
                    </button>
                    <div className="provider-config" inert={!expanded}>
                      <div className="provider-config-inner">
                        {expanded && draft && (
                          <form className="settings-form" onSubmit={save}>
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
                            <SecretField
                              cleared={clearApiKey}
                              configured={configured}
                              label={t('models.apiKey')}
                              onChange={setApiKey}
                              onToggleClear={() => setClearApiKey(value => !value)}
                              placeholderEmpty={t('models.keyEmpty')}
                              placeholderSaved={t('models.keySaved')}
                              removeArmedLabel={t('models.removeKeyArmed')}
                              removeLabel={t('models.removeKey')}
                              revealable
                              value={apiKey}
                            />
                            {vision && <small className="vision-note">{t('models.vision')}</small>}
                            {modelForm.failed && <div className="settings-error">{modelForm.message}</div>}
                            <SaveFooter
                              label={t('models.saveUse')}
                              note={modelForm.failed ? '' : modelForm.message}
                              saving={modelForm.pending === 'save'}
                            />
                          </form>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>}
          {section === 'web' && (
            <div className="settings-section-wrap">
              <header className="settings-head">
                <h2>{t('web.title')}</h2>
                <p>{t('web.desc')}</p>
              </header>
              {settings
                ? <WebSearchSettings initial={settings.web_search} onSave={persistWeb} />
                : <SettingsLoading error={settingsError} />}
            </div>
          )}
          {section === 'phone' && (
            <div className="settings-section-wrap">
              <header className="settings-head">
                <h2>{t('phone.title')}</h2>
                <p>{t('phone.desc')}</p>
              </header>
              {settings
                ? <PhoneBridgeSettings
                    initial={settings.feishu}
                    initialStatus={settings.bridge}
                    onRefresh={onBridgeStatus}
                    onSave={persistFeishu}
                    onToggle={onBridgeToggle}
                  />
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
          {section === 'docs' && (
            <div className="settings-section-wrap">
              <header className="settings-head">
                <h2>{t('docs.title')}</h2>
                <p>{t('docs.desc')}</p>
              </header>
              <ol className="docs-steps">
                <li>
                  <strong>{t('docs.step1.title')}</strong>
                  <p>{t('docs.step1.body')}</p>
                  <button className="docs-link" onClick={() => setSection('models')} type="button">{t('docs.go', { target: t('settings.models') })}</button>
                </li>
                <li>
                  <strong>{t('docs.step2.title')}</strong>
                  <p>{t('docs.step2.body')}</p>
                  <button className="docs-link" onClick={() => setSection('web')} type="button">{t('docs.go', { target: t('settings.web') })}</button>
                </li>
                <li>
                  <strong>{t('docs.step3.title')}</strong>
                  <p>{t('docs.step3.body')}</p>
                  <button className="docs-link" onClick={() => setSection('general')} type="button">{t('docs.go', { target: t('settings.general') })}</button>
                </li>
              </ol>
            </div>
          )}
      </section>
    </div>
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
  onSave
}: {
  initial: WebSearchSettings
  onSave: (value: Record<string, unknown>) => Promise<WebSearchSettings>
}) {
  const [configured, setConfigured] = useState(initial)
  const [expanded, setExpanded] = useState('')
  const [key, setKey] = useState('')
  const [clear, setClear] = useState(false)
  const form = useSettingsSave()

  const open = (id: string) => {
    setExpanded(current => (current === id ? '' : id))
    setKey('')
    setClear(false)
    form.clear()
  }

  const save = (event: FormEvent, provider: (typeof WEB_PROVIDERS)[number]) => {
    event.preventDefault()
    form.submit(onSave({ [provider.keyField]: key || undefined, [provider.flag]: clear }), value => {
      setConfigured(value)
      setKey('')
      setClear(false)
      return t('web.saved')
    })
  }

  return (
    <div className="provider-list">
      {WEB_PROVIDERS.map(provider => {
        const isConfigured = configured[`${provider.id}_configured`]
        const isExpanded = expanded === provider.id
        return (
          <div className={`provider-item ${isExpanded ? 'expanded' : ''}`} key={provider.id}>
            <button aria-expanded={isExpanded} className="provider-row" onClick={() => open(provider.id)} type="button">
              <span className="provider-id">
                <ProviderIcon label={provider.label} provider={provider.id} />
                <span className="provider-copy">
                  <strong>{provider.label}</strong>
                  <small>{provider.host}</small>
                </span>
              </span>
              <span className="provider-state">
                <ConfigBadge configured={isConfigured} />
              </span>
            </button>
            <div className="provider-config" inert={!isExpanded}>
              <div className="provider-config-inner">
                {isExpanded && (
                  <form className="settings-form" onSubmit={event => save(event, provider)}>
                    <SecretField
                      cleared={clear}
                      configured={isConfigured}
                      label={t('models.apiKey')}
                      onChange={setKey}
                      onToggleClear={() => setClear(value => !value)}
                      placeholderEmpty={t('web.keyEmpty')}
                      placeholderSaved={t('web.keySaved')}
                      removeArmedLabel={t('web.removeKeyArmed', { name: provider.label })}
                      removeLabel={t('web.removeKey', { name: provider.label })}
                      value={key}
                    />
                    <SettingsMessage failed={form.failed} message={form.message} />
                    <SaveFooter saving={form.pending === 'save'} />
                  </form>
                )}
              </div>
            </div>
          </div>
        )
      })}
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
    context_window: profile?.context_window || 353000,
    id: profile?.id || '',
    max_output_tokens: profile?.max_output_tokens || 65536,
    model: profile?.model || provider?.models[0]?.id || '',
    name: profile?.name || '',
    provider: profile?.provider || provider?.id || '',
    run_token_budget: profile?.run_token_budget || 2824000
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
                {normalizeMarkdownMath(detail.content)}
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

  const next: TimelineItem[] = items.map(item => ({ ...item, checkpointId: undefined }))
  const offset = userIndexes.length - ordered.length
  for (let position = offset; position < userIndexes.length; position += 1) {
    const checkpoint = ordered[position - offset]
    next[userIndexes[position]!]!.checkpointId = checkpoint!.id
  }
  return next
}

function timelineFromHistory(history: HistoryItem[]) {
  return history.map((item, index): TimelineItem => ({
    arguments: item.arguments == null ? undefined : JSON.stringify(item.arguments, null, 2),
    artifacts: item.artifacts,
    id: `history-${index}-${item.tool_call_id || item.kind}`,
    forkIndex: item.kind === 'assistant' ? item.message_index : undefined,
    images: item.images,
    kind: item.kind,
    name: item.name,
    status: item.status,
    text: item.text,
    createdAt: item.timestamp,
    toolCallId: item.tool_call_id
  }))
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

function TimelineRow({
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
        </summary>
        <ToolDetails item={item} />
      </details>
    )
  }

  return (
    <article className={`message ${item.kind}`}>
      <div className="message-body">
        <div className="message-text">
          <ReactMarkdown
            components={markdownComponents(onOpenLink)}
            rehypePlugins={markdownRehypePlugins}
            remarkPlugins={markdownRemarkPlugins}
          >
            {normalizeMarkdownMath(item.text)}
          </ReactMarkdown>
        </div>
        {item.images?.length ? (
          <div className="message-images">
            {item.images.map((image, index) => (
              <button key={`${item.id}-image-${index}`} onClick={() => onPreview(image)} type="button">
                <img alt={`Attachment ${index + 1}`} src={image} />
              </button>
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
}

function ThinkingRow({ item, onOpenLink }: { item: TimelineItem; onOpenLink: (url: string) => void }) {
  const thinking = item.thinking || { started: Date.now() }
  const done = thinking.ended != null
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (done) return
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [done])

  const elapsed = Math.max(0, (thinking.ended ?? now) - thinking.started)
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
        <ReactMarkdown
          components={markdownComponents(onOpenLink)}
          rehypePlugins={markdownRehypePlugins}
          remarkPlugins={markdownRemarkPlugins}
        >
          {normalizeMarkdownMath(item.text || '…')}
        </ReactMarkdown>
      </div>
    </details>
  )
}

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
  const thinkingActive = items.some(item => item.kind === 'reasoning' && item.thinking && item.thinking.ended == null)
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

  return (
    <details className={`tool-row tool-group ${status}`}>
      <summary>
        <span aria-hidden="true" className="tool-status" />
        <strong>{activityGroupLabel(items, status, now)}</strong>
      </summary>
      <div className="tool-group-list">
        {items.map(item => item.kind === 'reasoning'
          ? <ThinkingRow item={item} key={item.id} onOpenLink={onOpenLink} />
          : (
            <details className={`tool-subrow ${item.status}`} key={item.id}>
              <summary>
                <span aria-hidden="true" className="tool-status" />
                <strong>{toolActivityLabel(item)}</strong>
                <small>{item.name}</small>
              </summary>
              <ToolDetails item={item} />
            </details>
          ))}
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

function MetricsLine({ metrics }: { metrics: Metrics }) {
  const mark = metrics.estimated_tokens ? '~' : ''
  const input = metrics.input_tokens == null ? 'n/a' : `${mark}${metrics.input_tokens}`
  const output = metrics.output_tokens == null ? 'n/a' : `${mark}${metrics.output_tokens}`
  const seconds = metrics.elapsed_ms == null ? 'n/a' : `${(metrics.elapsed_ms / 1000).toFixed(1)}s`
  return <div className="metrics">in {input} · out {output} · {seconds}</div>
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
