import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open } from '@tauri-apps/plugin-dialog'
import { CSSProperties, FormEvent, KeyboardEvent, MouseEvent, PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import fridayAvatar from './assets/friday-avatar.svg'

type Metrics = {
  elapsed_ms?: number
  estimated_tokens?: boolean
  input_tokens?: number | null
  output_tokens?: number | null
}

type PermissionMode = 'accept-edits' | 'bypass' | 'dont-ask' | 'manual'
type ProjectStatus = 'connecting' | 'error' | 'idle' | 'ready'

const permissionOptions: ReadonlyArray<{
  description: string
  label: string
  value: PermissionMode
}> = [
  { description: 'Ask before risky actions', label: 'Request approval', value: 'manual' },
  { description: 'Allow workspace changes', label: 'Allow edits', value: 'accept-edits' },
  { description: 'Reject risky actions', label: 'Deny risky commands', value: 'dont-ask' },
  { description: 'Run without approval', label: 'Full access', value: 'bypass' }
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
  session_id?: string
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

type ResumeChoice = {
  assistant: string
  id: string
  objective: string
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

type HistoryItem = {
  arguments?: unknown
  kind: TimelineItem['kind']
  name?: string
  status?: TimelineItem['status']
  text: string
  timestamp?: string
  tool_call_id?: string
}

type TimelineItem = {
  arguments?: string
  checkpointId?: string
  createdAt?: string
  id: string
  kind: 'assistant' | 'system' | 'tool' | 'user'
  metrics?: Metrics
  name?: string
  status?: 'approval' | 'done' | 'error' | 'running'
  text: string
  toolCallId?: string
}

type ProjectView = {
  activeSession: string
  busy: boolean
  checkpoints: CheckpointChoice[]
  draft: string
  guidance: string
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
const DEFAULT_SIDEBAR_WIDTH = 252
const MIN_SIDEBAR_WIDTH = 180
const MAX_SIDEBAR_WIDTH = 520
const WELCOME_MESSAGES = [
  '今天我们从哪里开始？',
  '今天我能帮你做什么？',
  '从一个想法开始吧。',
  'What are we building today?',
  'Where should we begin?',
  'Ready when you are.'
]
const emptyModelCatalog: ModelCatalog = { active: '', profiles: [], providers: [] }

function nextId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function emptyView(path = ''): ProjectView {
  return {
    activeSession: '',
    busy: false,
    checkpoints: [],
    draft: '',
    guidance: '',
    info: { cwd: path, model: path ? 'loading' : '', permission_mode: 'manual', tools: [] },
    items: [],
    models: emptyModelCatalog,
    pendingApproval: null,
    sessions: [],
    skills: [],
    status: path ? 'connecting' : 'idle'
  }
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

function loadSidebarWidth() {
  return clampSidebarWidth(Number(localStorage.getItem(SIDEBAR_WIDTH_KEY)) || DEFAULT_SIDEBAR_WIDTH)
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
  const [resizingSidebar, setResizingSidebar] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth)
  const [page, setPage] = useState<'chat' | 'skills'>('chat')
  const [skillDetail, setSkillDetail] = useState<SkillDetail | null>(null)
  const [skillError, setSkillError] = useState('')
  const [skillQuery, setSkillQuery] = useState('')
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false)
  const [views, setViews] = useState<Record<string, ProjectView>>({})
  const activeProjectRef = useRef(activeProject)
  const activeAssistants = useRef(new Map<string, string>())
  const bottom = useRef<HTMLDivElement | null>(null)
  const followOutput = useRef(true)
  const pendingRequests = useRef(new Map<string, PendingRequest>())
  const requestId = useRef(0)
  const sidebarDrag = useRef<{ startWidth: number; startX: number } | null>(null)
  const startedProjects = useRef(new Set<string>())
  const openProjects = useRef(new Set(initialProjects.current.map(pathKey)))

  const view = views[activeProject] || emptyView(activeProject)
  const { activeSession, busy, checkpoints, draft, guidance, info, items, models, pendingApproval, sessions, skills, status } = view
  const isDefaultWorkspace = Boolean(defaultWorkspace && samePath(defaultWorkspace, activeProject))

  const updateView = (workspace: string, update: (current: ProjectView) => ProjectView) => {
    setViews(current => ({
      ...current,
      [workspace]: update(current[workspace] || emptyView(workspace))
    }))
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
        busy: false,
        checkpoints: checkpointResult.checkpoints,
        info: current.info,
        items: timelineFromHistory(current.history),
        models: modelResult,
        pendingApproval: current.info.approval?.pending ? current.info.approval : null,
        sessions: saved.choices,
        skills: skillResult.skills,
        status: 'ready'
      }))
    })

  useEffect(() => {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects))
  }, [projects])

  useEffect(() => {
    const tracked = projects.some(path => samePath(path, activeProject))
    if (activeProject && tracked) localStorage.setItem(ACTIVE_PROJECT_KEY, activeProject)
    else localStorage.removeItem(ACTIVE_PROJECT_KEY)
    setRenaming(null)
    setModelSettingsOpen(false)
    setSkillDetail(null)
    setSkillError('')
  }, [activeProject, projects])

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth))
  }, [sidebarWidth])

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

      if (type === 'message.delta') {
        const text = String(payload.text || '')
        let id = activeAssistants.current.get(workspace)
        if (!id) {
          id = nextId('assistant')
          activeAssistants.current.set(workspace, id)
        }
        updateView(workspace, current => {
          const found = current.items.some(item => item.id === id)
          return {
            ...current,
            items: found
              ? current.items.map(item => item.id === id ? { ...item, text: item.text + text } : item)
              : [...current.items, { id, kind: 'assistant', text }]
          }
        })
      } else if (type === 'message.complete') {
        const text = String(payload.text || '')
        const metrics = (payload.metrics || {}) as Metrics
        const sessionId = String(payload.session_id || '')
        const verification = payload.verification as VerificationStatus | undefined
        const id = activeAssistants.current.get(workspace)
        activeAssistants.current.delete(workspace)
        updateView(workspace, current => {
          let items: TimelineItem[] = id
            ? current.items.map(item => item.id === id ? { ...item, metrics, text: text || item.text } : item)
            : text ? [...current.items, { id: nextId('assistant'), kind: 'assistant', metrics, text }] : current.items
          items = verification
            ? items.map(item => item.id === 'verification-status' ? { ...item, text: verificationLabel(verification) } : item)
            : items.filter(item => item.id !== 'verification-status')
          return {
            ...current,
            activeSession: sessionId || current.activeSession,
            busy: false,
            items
          }
        })
        void Promise.all([
          refreshSessions(workspace),
          refreshCheckpoints(workspace),
          refreshSkills(workspace)
        ]).catch(() => undefined)
      } else if (type === 'tool.start') {
        const assistantId = activeAssistants.current.get(workspace)
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
        updateView(workspace, current => ({ ...current, busy: false, guidance: '', pendingApproval: null }))
      } else if (type === 'verification.start') {
        updateView(workspace, current => ({
          ...current,
          items: [
            ...current.items.filter(item => item.id !== 'verification-status'),
            { id: 'verification-status', kind: 'system', text: '正在验证交付结果...' }
          ]
        }))
      } else if (type === 'verification.complete') {
        updateView(workspace, current => ({
          ...current,
          items: payload.approval_required
            ? current.items.filter(item => item.id !== 'verification-status')
            : current.items.map(item => item.id === 'verification-status'
                ? { ...item, text: payload.passed ? '验证通过' : '正在根据验证反馈继续处理...' }
                : item)
        }))
      }
    }

    void (async () => {
      unlisten = await listen<[string, string]>('gateway-line', event => handleLine(event.payload[0], event.payload[1]))
      unlistenExit = await listen<string>('gateway-exit', event => {
        const workspace = event.payload
        const key = pathKey(workspace)
        startedProjects.current.delete(key)
        if (!openProjects.current.has(key)) return
        for (const [id, pending] of pendingRequests.current) {
          if (samePath(pending.workspace, workspace)) {
            pending.reject(new Error('Friday gateway stopped.'))
            pendingRequests.current.delete(id)
          }
        }
        updateView(workspace, current => ({
          ...current,
          busy: false,
          items: [
            ...current.items,
            { id: nextId('gateway-exit'), kind: 'system', text: 'Friday stopped. Select the project to restart it.' }
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
    })().catch(error => {
      const workspace = activeProjectRef.current
      if (workspace) {
        updateView(workspace, current => ({
          ...current,
          items: [...current.items, { id: nextId('startup'), kind: 'system', text: String(error) }],
          status: 'error'
        }))
      }
    })

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
    if (followOutput.current) bottom.current?.scrollIntoView()
  }, [activeProject, items])

  const submit = async (event?: FormEvent) => {
    event?.preventDefault()
    const text = draft.trim()
    if (!text || busy || pendingApproval || status !== 'ready') return

    followOutput.current = true
    updateView(activeProject, current => ({
      ...current,
      busy: true,
      draft: '',
      items: [...current.items, { createdAt: new Date().toISOString(), id: nextId('user'), kind: 'user', text }]
    }))
    try {
      await sendGateway(activeProject, 'chat.send', { text })
    } catch (error) {
      updateView(activeProject, current => ({
        ...current,
        busy: false,
        items: [...current.items, { id: nextId('send'), kind: 'system', text: String(error) }]
      }))
    }
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

  const deleteModel = (profileId: string) =>
    sendGateway<{ catalog: ModelCatalog; info: SessionInfo }>(activeProject, 'model.delete', { id: profileId })
      .then(result => {
        updateView(activeProject, current => ({ ...current, info: result.info, models: result.catalog }))
        return result.catalog
      })

  const resolveApproval = (method: string, params: Record<string, unknown> = {}) => {
    updateView(activeProject, current => ({ ...current, busy: true }))
    void sendGateway(activeProject, method, params).catch(error => {
      updateView(activeProject, current => ({
        ...current,
        busy: false,
        items: [...current.items, { id: nextId('approval'), kind: 'system', text: String(error) }]
      }))
    })
  }

  const startNewSessionAt = (workspace: string) => {
    const current = views[workspace] || emptyView(workspace)
    if (current.busy || !workspace) return Promise.resolve()
    setPage('chat')
    updateView(workspace, value => ({ ...value, busy: true }))
    return sendGateway<{ history: HistoryItem[]; info: SessionInfo }>(workspace, 'session.new').then(result => {
      updateView(workspace, value => ({
        ...value,
        activeSession: '',
        busy: false,
        checkpoints: [],
        info: result.info,
        items: timelineFromHistory(result.history),
        pendingApproval: null
      }))
    }).catch(error => {
      updateView(workspace, value => ({
        ...value,
        busy: false,
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
    if (projectView.busy) return
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
        busy: false,
        info: result.info,
        items: timelineFromHistory(result.history),
        pendingApproval: result.info.approval?.pending ? result.info.approval : null
      }))
      void refreshCheckpoints(workspace).catch(() => undefined)
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
    if (!window.confirm(`Delete "${sessionLabel(session)}"?`)) return
    void sendGateway<{ history: HistoryItem[]; info: SessionInfo }>(workspace, 'session.delete', { id: session.id })
      .then(result => {
        updateView(workspace, current => session.id === current.activeSession
          ? {
              ...current,
              activeSession: result.info.session_id || '',
              checkpoints: [],
              info: result.info,
              items: timelineFromHistory(result.history),
              pendingApproval: null
            }
          : current)
        return Promise.all([refreshSessions(workspace), refreshCheckpoints(workspace)])
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

  const openSkill = (skill: SkillInfo) => {
    setSkillError('')
    void sendGateway<SkillDetail>(activeProject, 'skill.get', { path: skill.path })
      .then(setSkillDetail)
      .catch(error => setSkillError(String(error)))
  }

  const openObservability = () => {
    if (!activeProject) return
    void sendGateway<{ url: string }>(activeProject, 'trace.serve').catch(error => {
      updateView(activeProject, current => ({
        ...current,
        items: [...current.items, { id: nextId('trace'), kind: 'system', text: String(error) }]
      }))
    })
  }

  const selectedSession = sessions.find(session => session.id === activeSession)
  const conversationTitle = selectedSession ? sessionLabel(selectedSession) : 'New conversation'
  const project = isDefaultWorkspace ? 'Personal conversations' : projectLabel(activeProject)
  const permission = permissionOptions.find(option => option.value === info.permission_mode) || permissionOptions[0]
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

  const renderSessions = (workspace: string) => {
    const projectView = views[workspace] || emptyView(workspace)
    const isCurrent = samePath(workspace, activeProject)
    const isRenaming = (session: ResumeChoice) =>
      renaming?.id === session.id && samePath(renaming.workspace, workspace)
    return projectView.sessions.length ? projectView.sessions.map(session => (
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
          <small>{formatSessionTime(session.time)} · {session.turns} turns</small>
        </div>
      ) : (
        <button className="session-main" disabled={projectView.busy} onClick={() => void resumeSession(workspace, session)} type="button">
          <span>{sessionLabel(session)}</span>
          <small>{formatSessionTime(session.time)} · {session.turns} turns</small>
        </button>
      )}
      <div className="session-actions">
        <button aria-label="Rename conversation" disabled={projectView.busy} onClick={event => beginRenameConversation(event, workspace, session)} title="Rename" type="button">
          <span aria-hidden="true">{'\u270e'}</span>
        </button>
        <button aria-label="Delete conversation" disabled={projectView.busy} onClick={event => deleteConversation(event, workspace, session)} title="Delete" type="button">
          <span aria-hidden="true">{'\u00d7'}</span>
        </button>
      </div>
    </div>
    )) : <div className="empty-sessions">No saved conversations</div>
  }

  const timelineItems = bindCheckpoints(items, checkpoints, activeSession)
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
              <span>Plugins</span>
            </button>
            <button
              disabled={!activeProject}
              onClick={openObservability}
              title="Open Trace Workbench in browser"
              type="button"
            >
              <svg aria-hidden="true" className="nav-icon" fill="none" viewBox="0 0 24 24">
                <path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              <span>Observability</span>
            </button>
          </nav>

          <div className="sidebar-tree">
            <section className="sidebar-section projects">
              <div className="section-heading">
                <h2>Projects</h2>
                <button aria-label="Add project" onClick={() => void addProject()} title="Add project" type="button">+</button>
              </div>
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
                          aria-label={`New conversation in ${projectLabel(path)}`}
                          disabled={isActive && (busy || status !== 'ready')}
                          onClick={event => addProjectSession(event, path)}
                          title="New conversation"
                          type="button"
                        >
                          <span aria-hidden="true">+</span>
                        </button>
                        <button
                          aria-label={`Close ${projectLabel(path)}`}
                          className="project-close"
                          onClick={event => void closeProject(event, path)}
                          title="Close project"
                          type="button"
                        >
                          <span aria-hidden="true">{'\u00d7'}</span>
                        </button>
                      </div>
                    </div>
                    {isExpanded && <div className="nested-sessions">{renderSessions(path)}</div>}
                  </div>
                )
              })}
            </section>

            <section className="sidebar-section conversation-space">
              <div className="section-heading">
                <h2>Recent</h2>
                <button
                  aria-label="New personal conversation"
                  disabled={isDefaultWorkspace && (busy || status !== 'ready')}
                  onClick={addDefaultSession}
                  title="New conversation"
                  type="button"
                >
                  +
                </button>
              </div>
              {defaultWorkspace && renderSessions(defaultWorkspace)}
            </section>
          </div>

          <button
            className="sidebar-footer"
            disabled={!activeProject}
            onClick={() => setModelSettingsOpen(true)}
            title="Configure models"
            type="button"
          >
            <span className={`status-dot ${status} ${status === 'ready' && !info.model_configured ? 'needs-key' : ''}`} />
            <span>
              <strong>{busy ? 'Working' : status === 'ready' && !info.model_configured ? 'API key required' : status === 'ready' ? 'Ready' : status === 'error' ? 'Unavailable' : status === 'idle' ? 'No project' : 'Connecting'}</strong>
              <span>{info.model_name || info.model}</span>
            </span>
            <span aria-hidden="true" className="footer-chevron">{'\u203a'}</span>
          </button>
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

        <main className="workspace">
        {page === 'skills' ? (
          <SkillBrowser
            detail={skillDetail}
            error={skillError}
            onClose={() => setSkillDetail(null)}
            onOpen={openSkill}
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
          onScroll={event => {
            const timeline = event.currentTarget
            followOutput.current = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 96
          }}
        >
          {showWelcome && <WelcomePrompt key={activeProject} />}
          {!showWelcome && groupToolItems(timelineItems).map(item => Array.isArray(item)
            ? item.length === 1
              ? <TimelineRow busy={busy} item={item[0]!} key={item[0]!.id} onRestore={restoreCheckpoint} />
              : <ToolGroup items={item} key={`tools-${item[0]!.id}`} />
            : <TimelineRow busy={busy} item={item} key={item.id} onRestore={restoreCheckpoint} />)}
          {pendingApproval && (
            <section className="approval-panel">
              <strong>Approval required</strong>
              <code>{pendingApproval.command || 'Pending command'}</code>
              {pendingApproval.reason && <p>{pendingApproval.reason}</p>}
              <div className="approval-actions">
                <button onClick={() => resolveApproval('approval.approve')} type="button">Approve once</button>
                <button onClick={() => resolveApproval('approval.approve', { session: true })} type="button">Allow for session</button>
                <button className="reject" onClick={() => resolveApproval('approval.reject')} type="button">Reject</button>
              </div>
              <div className="approval-guidance">
                <input
                  aria-label="Tell Friday what to do"
                  onChange={event => updateView(activeProject, current => ({ ...current, guidance: event.target.value }))}
                  placeholder="Tell Friday what to do instead..."
                  value={guidance}
                />
                <button
                  disabled={!guidance.trim()}
                  onClick={() => resolveApproval('approval.instruct', { text: guidance.trim() })}
                  type="button"
                >
                  Send guidance
                </button>
              </div>
            </section>
          )}
          {busy && !activeAssistants.current.get(activeProject) && (
            <div className="thinking"><span /><span /><span /> Friday is working</div>
          )}
          <div ref={bottom} />
        </section>

        <form className="composer" onSubmit={submit}>
          <textarea
            aria-label="Message Friday"
            disabled={status !== 'ready' || Boolean(pendingApproval)}
            onChange={event => updateView(activeProject, current => ({ ...current, draft: event.target.value }))}
            onKeyDown={onKeyDown}
            placeholder={pendingApproval ? 'Resolve the pending approval first...' : status === 'ready' ? 'Ask Friday to do something...' : 'Starting Friday...'}
            rows={3}
            value={draft}
          />
          <div className="composer-footer">
            <span>Enter to send · Shift+Enter for a new line</span>
            <div className="composer-actions">
              <details
                className={`model-picker ${busy ? 'disabled' : ''}`}
                key={`${activeProject}-${info.model_profile}`}
                onBlur={event => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node)) event.currentTarget.removeAttribute('open')
                }}
              >
                <summary aria-disabled={busy} onClick={event => busy && event.preventDefault()}>
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
                      <span className="model-menu-copy">
                        <strong>{profile.name}{profile.vision && <VisionIcon />}</strong>
                        <small>{profile.provider} / {profile.model}</small>
                      </span>
                      <span className={`model-key ${profile.api_key_configured ? 'configured' : ''}`} title={profile.api_key_configured ? 'API key configured' : 'API key required'} />
                    </button>
                  ))}
                  <button
                    className="configure-models"
                    onClick={event => {
                      event.currentTarget.closest('details')?.removeAttribute('open')
                      setModelSettingsOpen(true)
                    }}
                    type="button"
                  >
                    Configure models
                  </button>
                </div>
              </details>
              <details
                className={`permission-picker ${busy ? 'disabled' : ''}`}
                key={`${activeProject}-permissions`}
                onBlur={event => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node)) event.currentTarget.removeAttribute('open')
                }}
              >
                <summary
                  aria-disabled={busy}
                  aria-label="Permission mode"
                  onClick={event => {
                    if (busy) event.preventDefault()
                  }}
                  tabIndex={busy ? -1 : 0}
                  title="Choose how Friday handles risky commands"
                >
                  <span>{permission.label}</span>
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
                      <span className="permission-indicator" />
                      <span>
                        <strong>{option.label}</strong>
                        <small>{option.description}</small>
                      </span>
                    </button>
                  ))}
                </div>
              </details>
              <button
                aria-label="Send message"
                className="send-button"
                disabled={!draft.trim() || busy || Boolean(pendingApproval) || status !== 'ready'}
                title="Send"
                type="submit"
              >
                {busy ? '…' : '↑'}
              </button>
            </div>
          </div>
        </form>
        </>
        )}
        </main>
        {modelSettingsOpen && (
          <ModelSettings
            catalog={models}
            onClose={() => setModelSettingsOpen(false)}
            onDelete={deleteModel}
            onSave={saveModel}
          />
        )}
      </div>
    </div>
  )
}

function WelcomePrompt() {
  const [message] = useState(() => WELCOME_MESSAGES[Math.floor(Math.random() * WELCOME_MESSAGES.length)]!)
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

function ModelSettings({
  catalog,
  onClose,
  onDelete,
  onSave
}: {
  catalog: ModelCatalog
  onClose: () => void
  onDelete: (id: string) => Promise<ModelCatalog>
  onSave: (profile: ModelDraft, apiKey: string, clearApiKey: boolean) => Promise<ModelCatalog>
}) {
  const [selectedId, setSelectedId] = useState(catalog.active)
  const [draft, setDraft] = useState<ModelDraft>(() => modelDraft(catalog.profiles.find(item => item.id === catalog.active)))
  const [apiKey, setApiKey] = useState('')
  const [clearApiKey, setClearApiKey] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const provider = catalog.providers.find(item => item.id === draft.provider) || catalog.providers[0]
  const vision = provider?.models.find(item => item.id === draft.model)?.vision || false

  const edit = (profile?: ModelProfile) => {
    setSelectedId(profile?.id || '')
    setDraft(modelDraft(profile, catalog.providers[0]))
    setApiKey('')
    setClearApiKey(false)
    setError('')
  }

  const save = (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setError('')
    void onSave(draft, apiKey, clearApiKey)
      .then(result => {
        const selected = result.profiles.find(item => item.id === result.active)
        edit(selected)
      })
      .catch(value => setError(String(value)))
      .finally(() => setSaving(false))
  }

  const remove = () => {
    if (!selectedId || !window.confirm(`Remove "${draft.name}"?`)) return
    setSaving(true)
    setError('')
    void onDelete(selectedId)
      .then(result => edit(result.profiles.find(item => item.id === result.active)))
      .catch(value => setError(String(value)))
      .finally(() => setSaving(false))
  }

  return (
    <div className="model-settings-backdrop" onMouseDown={onClose}>
      <section aria-modal="true" className="model-settings" onMouseDown={event => event.stopPropagation()} role="dialog">
        <header>
          <div>
            <h2>Models</h2>
            <p>Provider credentials stay on this computer.</p>
          </div>
          <button aria-label="Close model settings" onClick={onClose} title="Close" type="button">{'\u00d7'}</button>
        </header>
        <div className="model-settings-body">
          <aside>
            <button className="add-model" onClick={() => edit()} type="button">+ Add model</button>
            {catalog.profiles.map(profile => (
              <button
                className={profile.id === selectedId ? 'active' : ''}
                key={profile.id}
                onClick={() => edit(profile)}
                type="button"
              >
                <span>
                  <strong>{profile.name}{profile.vision && <VisionIcon />}</strong>
                  <small>{profile.provider} / {profile.model}</small>
                </span>
                <span className={`model-key ${profile.api_key_configured ? 'configured' : ''}`} />
              </button>
            ))}
          </aside>
          <form onSubmit={save}>
            <div className="model-form-heading">
              <div>
                <h3>{selectedId ? 'Model configuration' : 'New model'}</h3>
                <p>{vision ? 'Vision supported' : 'Text model'}{vision && <VisionIcon />}</p>
              </div>
            </div>
            <label>
              <span>Name</span>
              <input required value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} />
            </label>
            <fieldset className="provider-field">
              <legend>Provider</legend>
              <div className="provider-picker">
                {catalog.providers.map(item => (
                  <button
                    aria-pressed={item.id === draft.provider}
                    className={item.id === draft.provider ? 'active' : ''}
                    key={item.id}
                    onClick={() => setDraft(current => ({
                      ...current,
                      base_url: item.base_url,
                      model: item.models[0]?.id || '',
                      provider: item.id
                    }))}
                    type="button"
                  >
                    <strong>{item.label}</strong>
                    <small>{item.models.length} suggested models</small>
                  </button>
                ))}
              </div>
            </fieldset>
            <label>
              <span>Model</span>
              <input
                list={`models-${draft.provider}`}
                required
                value={draft.model}
                onChange={event => setDraft(current => ({ ...current, model: event.target.value }))}
              />
              <datalist id={`models-${draft.provider}`}>
                {provider?.models.map(item => <option key={item.id} value={item.id} />)}
              </datalist>
            </label>
            <label>
              <span>Base URL</span>
              <input required type="url" value={draft.base_url} onChange={event => setDraft(current => ({ ...current, base_url: event.target.value }))} />
            </label>
            <label>
              <span>API key</span>
              <input
                autoComplete="off"
                placeholder={selectedId ? 'Leave blank to keep the saved key' : 'Required unless set in the environment'}
                type="password"
                value={apiKey}
                onChange={event => {
                  setApiKey(event.target.value)
                  if (event.target.value) setClearApiKey(false)
                }}
              />
            </label>
            {selectedId && (
              <label className="clear-key">
                <input checked={clearApiKey} onChange={event => setClearApiKey(event.target.checked)} type="checkbox" />
                <span>Remove saved API key</span>
              </label>
            )}
            {error && <div className="model-settings-error">{error}</div>}
            <footer>
              <button className="remove-model" disabled={saving || !selectedId || catalog.profiles.length < 2} onClick={remove} type="button">Remove</button>
              <button className="save-model" disabled={saving} type="submit">{saving ? 'Saving...' : 'Save and use'}</button>
            </footer>
          </form>
        </div>
      </section>
    </div>
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
  onQueryChange,
  query,
  skills
}: {
  detail: SkillDetail | null
  error: string
  onClose: () => void
  onOpen: (skill: SkillInfo) => void
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
        <h1>Skills</h1>
        <p>Reusable workflows available to Friday</p>
      </header>
      <label className="skill-search">
        <span aria-hidden="true">{'\u2315'}</span>
        <input
          aria-label="Search skills"
          onChange={event => onQueryChange(event.target.value)}
          placeholder="Search skills"
          value={query}
        />
      </label>
      <div className="skills-section-heading">
        <h2>Installed</h2>
        <span>{filtered.length}</span>
      </div>
      {error && <div className="skill-error">{error}</div>}
      <div className="skills-grid">
        {filtered.map(skill => (
          <button className="skill-card" key={`${skill.scope}-${skill.path}`} onClick={() => onOpen(skill)} type="button">
            <span aria-hidden="true" className="skill-card-icon">{'\u25c7'}</span>
            <span className="skill-card-copy">
              <strong>{skill.name}</strong>
              <small>{skill.description}</small>
            </span>
            <span aria-hidden="true" className="skill-card-check">{'\u2713'}</span>
          </button>
        ))}
      </div>
      {!filtered.length && <div className="skills-empty">No matching skills</div>}
      {detail && (
        <div className="skill-modal-backdrop" onMouseDown={onClose}>
          <article
            aria-modal="true"
            className="skill-modal"
            onMouseDown={event => event.stopPropagation()}
            role="dialog"
          >
            <header>
              <span aria-hidden="true" className="skill-card-icon">{'\u25c7'}</span>
              <button aria-label="Close skill details" onClick={onClose} title="Close" type="button">
                {'\u00d7'}
              </button>
            </header>
            <h2>{detail.skill.name} <span>Skill</span></h2>
            <p>{detail.skill.description}</p>
            <small>{detail.skill.scope} · {detail.skill.path}</small>
            <div className="skill-content">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{detail.content}</ReactMarkdown>
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
      className="window-titlebar"
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
        <button aria-label="Minimize" onClick={() => void appWindow.minimize()} title="Minimize" type="button">
          <span aria-hidden="true" className="window-minimize" />
        </button>
        <button
          aria-label={maximized ? 'Restore window' : 'Maximize window'}
          onClick={() => void appWindow.toggleMaximize()}
          title={maximized ? 'Restore' : 'Maximize'}
          type="button"
        >
          <span aria-hidden="true" className={maximized ? 'window-restore' : 'window-maximize'} />
        </button>
        <button className="window-close" aria-label="Close" onClick={() => void appWindow.close()} title="Close" type="button">
          <span aria-hidden="true" className="window-close-glyph" />
        </button>
      </div>
    </header>
  )
}

function verificationLabel(verification: VerificationStatus) {
  if (verification.passed || verification.verdict === 'pass') return '验证通过'
  if (verification.error) return '验证异常'
  if (verification.verdict === 'blocked') return '验证受阻'
  if (verification.verdict === 'inconclusive') return '验证结果不确定'
  return '验证未通过'
}

function groupToolItems(items: TimelineItem[]) {
  const rows: Array<TimelineItem | TimelineItem[]> = []
  for (const item of items) {
    if (item.kind !== 'tool') {
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
    const start = userIndexes[position]!
    const end = userIndexes[position + 1] ?? next.length
    for (let index = start; index < end; index += 1) {
      if (next[index]!.kind === 'user' || next[index]!.kind === 'assistant') {
        next[index]!.checkpointId = checkpoint!.id
      }
    }
  }
  return next
}

function timelineFromHistory(history: HistoryItem[]) {
  return history.map((item, index): TimelineItem => ({
    arguments: item.arguments == null ? undefined : JSON.stringify(item.arguments, null, 2),
    id: `history-${index}-${item.tool_call_id || item.kind}`,
    kind: item.kind,
    name: item.name,
    status: item.status,
    text: item.text,
    createdAt: item.timestamp,
    toolCallId: item.tool_call_id
  }))
}

function TimelineRow({
  busy,
  item,
  onRestore
}: {
  busy: boolean
  item: TimelineItem
  onRestore: (checkpointId: string) => void
}) {
  const [copied, setCopied] = useState(false)

  if (item.kind === 'system') {
    return <div className="system-row">{item.text}</div>
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
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown>
        </div>
        {item.metrics && <MetricsLine metrics={item.metrics} />}
        {(item.kind === 'user' || item.checkpointId) && (
          <div className="message-meta">
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
            {item.checkpointId && (
              <button
                aria-label="Restore to before this turn"
                disabled={busy}
                onClick={() => onRestore(item.checkpointId!)}
                title="Restore to before this turn"
                type="button"
              >
                <span aria-hidden="true" className="restore-icon">{'\u21b6'}</span>
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  )
}

function ToolGroup({ items }: { items: TimelineItem[] }) {
  const status: NonNullable<TimelineItem['status']> = items.some(item => item.status === 'approval')
    ? 'approval'
    : items.some(item => item.status === 'running')
      ? 'running'
      : items.some(item => item.status === 'error')
        ? 'error'
        : 'done'
  return (
    <details className={`tool-row tool-group ${status}`}>
      <summary>
        <span aria-hidden="true" className="tool-status" />
        <strong>{toolGroupLabel(items, status)}</strong>
      </summary>
      <div className="tool-group-list">
        {items.map(item => (
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

function toolVerb(name = '') {
  const value = name.toLocaleLowerCase()
  if (value === 'websearch') return '\u641c\u7d22\u7f51\u9875'
  if (value === 'webfetch') return '\u8bfb\u53d6\u7f51\u9875'
  if (value === 'bash') return '\u8fd0\u884c\u547d\u4ee4'
  if (value === 'read') return '\u8bfb\u53d6\u6587\u4ef6'
  if (value === 'write' || value === 'edit') return '\u4fee\u6539\u6587\u4ef6'
  if (value === 'glob' || value === 'grep') return '\u67e5\u627e\u6587\u4ef6'
  if (value === 'updateplan') return '\u66f4\u65b0\u4efb\u52a1\u8fdb\u5ea6'
  return '\u4f7f\u7528\u5de5\u5177'
}

function completedToolAction(name = '') {
  const value = name.toLocaleLowerCase()
  if (value === 'websearch') return '\u641c\u7d22\u4e86\u7f51\u9875'
  if (value === 'webfetch') return '\u8bfb\u53d6\u4e86\u7f51\u9875'
  if (value === 'bash') return '\u8fd0\u884c\u4e86\u547d\u4ee4'
  if (value === 'read') return '\u8bfb\u53d6\u4e86\u6587\u4ef6'
  if (value === 'write' || value === 'edit') return '\u4fee\u6539\u4e86\u6587\u4ef6'
  if (value === 'glob' || value === 'grep') return '\u67e5\u627e\u4e86\u6587\u4ef6'
  if (value === 'updateplan') return '\u66f4\u65b0\u4e86\u4efb\u52a1\u8fdb\u5ea6'
  return '\u4f7f\u7528\u4e86\u5de5\u5177'
}

function toolActivityLabel(item: TimelineItem) {
  const verb = toolVerb(item.name)
  if (item.status === 'running') return `\u6b63\u5728${verb}`
  if (item.status === 'approval') return `\u7b49\u5f85\u6279\u51c6\uff1a${verb}`
  if (item.status === 'error') return `${verb}\u65f6\u9047\u5230\u95ee\u9898`
  return completedToolAction(item.name)
}

function toolGroupLabel(items: TimelineItem[], status: NonNullable<TimelineItem['status']>) {
  const verbs = [...new Set(items.map(item => toolVerb(item.name)))]
  if (verbs.length === 1 && items.length > 1) {
    const verb = verbs[0]!
    if (status === 'running') {
      if (verb === '\u8fd0\u884c\u547d\u4ee4') return '\u6b63\u5728\u8fd0\u884c\u591a\u4e2a\u547d\u4ee4'
      if (verb === '\u641c\u7d22\u7f51\u9875') return '\u6b63\u5728\u8fdb\u884c\u591a\u6b21\u7f51\u9875\u641c\u7d22'
      if (verb === '\u8bfb\u53d6\u6587\u4ef6') return '\u6b63\u5728\u8bfb\u53d6\u591a\u4e2a\u6587\u4ef6'
      if (verb === '\u4fee\u6539\u6587\u4ef6') return '\u6b63\u5728\u4fee\u6539\u591a\u4e2a\u6587\u4ef6'
      return `\u6b63\u5728\u591a\u6b21${verb}`
    }
    if (status === 'approval') return `\u7b49\u5f85\u6279\u51c6\uff1a\u591a\u6b21${verb}`
    if (status === 'error') return `\u591a\u6b21${verb}\u65f6\u6709\u64cd\u4f5c\u5931\u8d25`
    if (verb === '\u8fd0\u884c\u547d\u4ee4') return '\u8fd0\u884c\u4e86\u591a\u4e2a\u547d\u4ee4'
    if (verb === '\u8bfb\u53d6\u6587\u4ef6') return '\u8bfb\u53d6\u4e86\u591a\u4e2a\u6587\u4ef6'
    if (verb === '\u4fee\u6539\u6587\u4ef6') return '\u4fee\u6539\u4e86\u591a\u4e2a\u6587\u4ef6'
    if (verb === '\u641c\u7d22\u7f51\u9875') return '\u8fdb\u884c\u4e86\u591a\u6b21\u7f51\u9875\u641c\u7d22'
    if (verb === '\u8bfb\u53d6\u7f51\u9875') return '\u8bfb\u53d6\u4e86\u591a\u4e2a\u7f51\u9875'
    if (verb === '\u67e5\u627e\u6587\u4ef6') return '\u8fdb\u884c\u4e86\u591a\u6b21\u6587\u4ef6\u67e5\u627e'
    return '\u6267\u884c\u4e86\u591a\u9879\u5de5\u5177\u64cd\u4f5c'
  }
  const text = verbs.join('\u3001')
  if (status === 'running') return `\u6b63\u5728${text}`
  if (status === 'approval') return `\u7b49\u5f85\u6279\u51c6\uff1a${text}`
  if (status === 'error') return `${text}\u65f6\u6709\u64cd\u4f5c\u5931\u8d25`
  return [...new Set(items.map(item => completedToolAction(item.name)))].join('\u3001')
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
