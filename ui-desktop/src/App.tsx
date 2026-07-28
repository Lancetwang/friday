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
  permission_mode: PermissionMode
  session_id?: string
  tools: string[]
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
  draft: string
  guidance: string
  info: SessionInfo
  items: TimelineItem[]
  pendingApproval: Approval | null
  sessions: ResumeChoice[]
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
const welcome: TimelineItem = {
  id: 'welcome',
  kind: 'assistant',
  text: 'Friday 已经准备好了。告诉我你想完成什么。'
}

function nextId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function emptyView(path = ''): ProjectView {
  return {
    activeSession: '',
    busy: false,
    draft: '',
    guidance: '',
    info: { cwd: path, model: path ? 'loading' : '', permission_mode: 'manual', tools: [] },
    items: [welcome],
    pendingApproval: null,
    sessions: [],
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
  const [renaming, setRenaming] = useState<{ id: string; original: string; title: string } | null>(null)
  const [resizingSidebar, setResizingSidebar] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth)
  const [views, setViews] = useState<Record<string, ProjectView>>({})
  const activeProjectRef = useRef(activeProject)
  const activeAssistants = useRef(new Map<string, string>())
  const bottom = useRef<HTMLDivElement | null>(null)
  const pendingRequests = useRef(new Map<string, PendingRequest>())
  const requestId = useRef(0)
  const sidebarDrag = useRef<{ startWidth: number; startX: number } | null>(null)
  const startedProjects = useRef(new Set<string>())
  const openProjects = useRef(new Set(initialProjects.current.map(pathKey)))

  const view = views[activeProject] || emptyView(activeProject)
  const { activeSession, busy, draft, guidance, info, items, pendingApproval, sessions, status } = view

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
      void invoke('gateway_send', {
        workspace,
        message: JSON.stringify({ id, jsonrpc: '2.0', method, params })
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

  const hydrateProject = (workspace: string) =>
    Promise.all([
      sendGateway<{ history: HistoryItem[]; info: SessionInfo }>(workspace, 'session.current'),
      sendGateway<{ choices: ResumeChoice[] }>(workspace, 'session.resume_choices')
    ]).then(([current, saved]) => {
      updateView(workspace, existing => ({
        ...existing,
        activeSession: current.info.session_id || '',
        busy: false,
        info: current.info,
        items: timelineFromHistory(current.history),
        pendingApproval: current.info.approval?.pending ? current.info.approval : null,
        sessions: saved.choices,
        status: 'ready'
      }))
    })

  useEffect(() => {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects))
  }, [projects])

  useEffect(() => {
    if (activeProject) localStorage.setItem(ACTIVE_PROJECT_KEY, activeProject)
    setRenaming(null)
  }, [activeProject])

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
        void refreshSessions(workspace).catch(() => undefined)
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
      const requested = localStorage.getItem(ACTIVE_PROJECT_KEY) || initialProjects.current[0] || undefined
      let workspace: string
      try {
        workspace = await invoke<string>('gateway_start', { workspace: requested })
      } catch {
        if (requested) setProjects(current => current.filter(path => !samePath(path, requested)))
        workspace = await invoke<string>('gateway_start')
      }
      startedProjects.current.add(pathKey(workspace))
      activeProjectRef.current = workspace
      setActiveProject(workspace)
      rememberProject(workspace)
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
    bottom.current?.scrollIntoView({ behavior: 'smooth' })
  }, [activeProject, items])

  const submit = async (event?: FormEvent) => {
    event?.preventDefault()
    const text = draft.trim()
    if (!text || busy || pendingApproval || status !== 'ready') return

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

  const startNewSession = () => {
    if (busy || !activeProject) return
    updateView(activeProject, current => ({ ...current, busy: true }))
    void sendGateway<{ history: HistoryItem[]; info: SessionInfo }>(activeProject, 'session.new').then(result => {
      updateView(activeProject, current => ({
        ...current,
        activeSession: '',
        busy: false,
        info: result.info,
        items: timelineFromHistory(result.history),
        pendingApproval: null
      }))
    }).catch(error => {
      updateView(activeProject, current => ({
        ...current,
        busy: false,
        items: [...current.items, { id: nextId('session'), kind: 'system', text: String(error) }]
      }))
    })
  }

  const resumeSession = (session: ResumeChoice) => {
    if (busy || session.id === activeSession) return
    updateView(activeProject, current => ({ ...current, busy: true }))
    void sendGateway<{ history: HistoryItem[]; info: SessionInfo }>(activeProject, 'session.resume', { id: session.id }).then(result => {
      updateView(activeProject, current => ({
        ...current,
        activeSession: result.info.session_id || '',
        busy: false,
        info: result.info,
        items: timelineFromHistory(result.history),
        pendingApproval: result.info.approval?.pending ? result.info.approval : null
      }))
    }).catch(error => {
      updateView(activeProject, current => ({
        ...current,
        busy: false,
        items: [...current.items, { id: nextId('resume'), kind: 'system', text: String(error) }]
      }))
    })
  }

  const selectProject = async (workspace: string) => {
    const known = projects.find(path => samePath(path, workspace)) || workspace
    const wasStarted = startedProjects.current.has(pathKey(known))
    activeProjectRef.current = known
    setActiveProject(known)
    updateView(known, current => ({ ...current, status: wasStarted ? current.status : 'connecting' }))
    try {
      const resolved = await invoke<string>('gateway_start', { workspace: known })
      startedProjects.current.add(pathKey(resolved))
      rememberProject(resolved)
      activeProjectRef.current = resolved
      setActiveProject(resolved)
      if (!wasStarted) await hydrateProject(resolved)
    } catch (error) {
      updateView(known, current => ({
        ...current,
        items: [...current.items, { id: nextId('workspace'), kind: 'system', text: String(error) }],
        status: 'error'
      }))
    }
  }

  const addProject = async () => {
    const selected = await open({
      defaultPath: activeProject || undefined,
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
      const next = remaining[0] || ''
      activeProjectRef.current = next
      setActiveProject(next)
      if (next) await selectProject(next)
    }
  }

  const beginRenameConversation = (event: MouseEvent, session: ResumeChoice) => {
    event.stopPropagation()
    const title = sessionLabel(session)
    setRenaming({ id: session.id, original: title, title })
  }

  const commitRenameConversation = (session: ResumeChoice, value: string) => {
    if (renaming?.id !== session.id) return
    const title = value.trim()
    setRenaming(null)
    if (!title || title === renaming.original) return
    void sendGateway(activeProject, 'session.rename', { id: session.id, title })
      .then(() => refreshSessions(activeProject))
      .catch(error => updateView(activeProject, current => ({
        ...current,
        items: [...current.items, { id: nextId('rename'), kind: 'system', text: String(error) }]
      })))
  }

  const deleteConversation = (event: MouseEvent, session: ResumeChoice) => {
    event.stopPropagation()
    if (!window.confirm(`Delete "${sessionLabel(session)}"?`)) return
    void sendGateway<{ history: HistoryItem[]; info: SessionInfo }>(activeProject, 'session.delete', { id: session.id })
      .then(result => {
        updateView(activeProject, current => session.id === current.activeSession
          ? {
              ...current,
              activeSession: result.info.session_id || '',
              info: result.info,
              items: timelineFromHistory(result.history),
              pendingApproval: null
            }
          : current)
        return refreshSessions(activeProject)
      })
      .catch(error => updateView(activeProject, current => ({
        ...current,
        items: [...current.items, { id: nextId('delete'), kind: 'system', text: String(error) }]
      })))
  }

  const selectedSession = sessions.find(session => session.id === activeSession)
  const conversationTitle = selectedSession ? sessionLabel(selectedSession) : 'New conversation'
  const project = projectLabel(activeProject)
  const permission = permissionOptions.find(option => option.value === info.permission_mode) || permissionOptions[0]

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

  return (
    <div className="desktop-window">
      <WindowTitlebar />
      <div
        className={`app-shell ${resizingSidebar ? 'resizing' : ''}`}
        style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}
      >
        <aside className="sidebar">

          <section className="sidebar-section projects">
          <div className="section-heading">
            <h2>Projects</h2>
            <button aria-label="Add project" onClick={() => void addProject()} title="Add project" type="button">+</button>
          </div>
          {projects.map(path => {
            const projectView = views[path]
            return (
              <div className={`project-entry ${samePath(path, activeProject) ? 'active' : ''}`} key={path}>
                <button className="project-main" onClick={() => void selectProject(path)} title={path} type="button">
                  <span className={`project-dot ${projectView?.busy ? 'busy' : projectView?.status || ''}`} />
                  <span>{projectLabel(path)}</span>
                </button>
                <button
                  aria-label={`Close ${projectLabel(path)}`}
                  className="project-close"
                  onClick={event => void closeProject(event, path)}
                  title="Close project"
                  type="button"
                >
                  <span aria-hidden="true">×</span>
                </button>
              </div>
            )
          })}
          </section>

          <section className="sidebar-section sessions">
          <div className="section-heading">
            <h2>Conversations</h2>
            <button
              aria-label="New conversation"
              disabled={busy || !activeProject}
              onClick={startNewSession}
              title="New conversation"
              type="button"
            >
              +
            </button>
          </div>
          {sessions.length ? sessions.map(session => (
            <div className={`session-entry ${session.id === activeSession ? 'active' : ''} ${renaming?.id === session.id ? 'renaming' : ''}`} key={session.id}>
              {renaming?.id === session.id ? (
                <div className="session-main">
                  <input
                    aria-label="Conversation name"
                    autoFocus
                    onBlur={event => commitRenameConversation(session, event.currentTarget.value)}
                    onChange={event => setRenaming(current => current ? { ...current, title: event.target.value } : null)}
                    onFocus={event => event.currentTarget.select()}
                    onKeyDown={event => {
                      if (event.nativeEvent.isComposing) return
                      if (event.key === 'Enter') event.currentTarget.blur()
                      if (event.key === 'Escape') {
                        event.currentTarget.value = renaming.original
                        event.currentTarget.blur()
                      }
                    }}
                    value={renaming.title}
                  />
                  <small>{formatSessionTime(session.time)} · {session.turns} turns</small>
                </div>
              ) : (
                <button
                  className="session-main"
                  disabled={busy}
                  onClick={() => resumeSession(session)}
                  type="button"
                >
                  <span>{sessionLabel(session)}</span>
                  <small>{formatSessionTime(session.time)} · {session.turns} turns</small>
                </button>
              )}
              <div className="session-actions">
                <button aria-label="Rename conversation" disabled={busy} onClick={event => beginRenameConversation(event, session)} title="Rename" type="button">
                  <span aria-hidden="true">✎</span>
                </button>
                <button aria-label="Delete conversation" disabled={busy} onClick={event => deleteConversation(event, session)} title="Delete" type="button">
                  <span aria-hidden="true">×</span>
                </button>
              </div>
            </div>
          )) : <div className="empty-sessions">No saved conversations</div>}
          </section>

          <div className="sidebar-footer">
          <span className={`status-dot ${status}`} />
          <div>
            <strong>{busy ? 'Working' : status === 'ready' ? 'Ready' : status === 'error' ? 'Unavailable' : status === 'idle' ? 'No project' : 'Connecting'}</strong>
            <span>{info.model}</span>
          </div>
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

        <main className="workspace">
        <header className="topbar">
          <div className="topbar-spacer" aria-hidden="true" />
          <div className="conversation-heading">
            <h1>{conversationTitle}</h1>
            <p>{project}</p>
          </div>
          <div className="tool-count">{info.tools.length} tools</div>
        </header>

        <section className="timeline" aria-live="polite">
          {groupToolItems(items).map(item => Array.isArray(item)
            ? item.length === 1
              ? <TimelineRow item={item[0]!} key={item[0]!.id} />
              : <ToolGroup items={item} key={`tools-${item[0]!.id}`} />
            : <TimelineRow item={item} key={item.id} />)}
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
        </main>
      </div>
    </div>
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

function timelineFromHistory(history: HistoryItem[]) {
  return history.length
    ? history.map((item, index): TimelineItem => ({
        arguments: item.arguments == null ? undefined : JSON.stringify(item.arguments, null, 2),
        id: `history-${index}-${item.tool_call_id || item.kind}`,
        kind: item.kind,
        name: item.name,
        status: item.status,
        text: item.text,
        createdAt: item.timestamp,
        toolCallId: item.tool_call_id
      }))
    : [welcome]
}

function TimelineRow({ item }: { item: TimelineItem }) {
  const [copied, setCopied] = useState(false)

  if (item.kind === 'system') {
    return <div className="system-row">{item.text}</div>
  }

  if (item.kind === 'tool') {
    return (
      <details className={`tool-row ${item.status}`}>
        <summary>
          <span className="tool-status">
            {toolStatusLabel(item.status)}
          </span>
          <strong>{item.name}</strong>
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
        {item.kind === 'user' && (
          <div className="message-meta">
            {item.createdAt && (
              <time dateTime={item.createdAt}>
                {formatMessageTime(item.createdAt)}
              </time>
            )}
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
        <span className="tool-status">{toolStatusLabel(status)}</span>
        <strong>{status === 'running' ? `Running ${items.length} tools` : `Ran ${items.length} tools`}</strong>
      </summary>
      <div className="tool-group-list">
        {items.map(item => (
          <details className={`tool-subrow ${item.status}`} key={item.id}>
            <summary>
              <span className="tool-status">{toolStatusLabel(item.status)}</span>
              <strong>{item.name}</strong>
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

function toolStatusLabel(status: TimelineItem['status']) {
  return status === 'running' ? 'Running' : status === 'approval' ? 'Approval required' : status === 'error' ? 'Failed' : 'Done'
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
