#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

import type { AgentEvent } from 'friday-agent-core'

import {
  clearModelCredential,
  closeProject,
  deleteModelProfile,
  listProjects,
  loadModelCatalog,
  readModelCredential,
  recordProject,
  refreshModelProfiles,
  resolveWorkspace,
  saveModelProfile,
  selectModelProfile,
  setModelEnabled,
  setPluginEnabled,
  type ModelCatalog
} from './config.js'
import {
  deleteSessionTree,
  forkSession,
  FridaySession,
  renameSession,
  sessionChoices,
  sessionExists,
  sessionHistory,
  sessionTree
} from './session.js'
import { thinkingOptions } from './thinking.js'
import { discoverSkills, skillDetail } from './skills.js'
import type { PermissionMode } from './permissions.js'
import { checkpointChoices, restoreCheckpoint } from './checkpoint.js'
import { artifactDetail } from './artifacts.js'
import { formatMemoryResult, runMemoryCommand } from './memory.js'
import { startTraceServer, stopTraceServer, type TraceServer } from './trace.js'
import { imageUrls, localAttachments } from './attachments.js'
import { resetFriday } from './reset.js'
import {
  loadUserProfile,
  loadWebSearchSettings,
  memoryFile,
  readWebSearchCredential,
  saveMemoryFile,
  saveUserProfile,
  saveWebSearchSettings
} from './settings.js'

type Request = { id?: unknown; method?: unknown; params?: Record<string, unknown> }

const MAX_CACHED_SESSIONS = 8

export class Gateway {
  private session!: FridaySession
  private readonly sessions = new Map<string, FridaySession>()
  private readonly sessionLoads = new Map<string, Promise<FridaySession>>()
  private readonly activeRuns = new Map<string, Promise<unknown>>()
  private readonly runLabels = new Map<string, string>()
  private readonly deletingSessions = new Set<string>()
  private globalRun: Promise<unknown> | undefined
  private navigationRun: Promise<unknown> | undefined
  private readonly toolNames = new Map<string, string>()
  private readonly titling = new Set<string>()
  private readonly reasoning = new Map<string, { id: string; started: number }>()
  private reasoningSequence = 0
  private permissionMode: PermissionMode | undefined
  private traceServer: TraceServer | undefined
  private readonly workspace: string
  private readonly send: (value: unknown) => void

  constructor(workspace = process.cwd(), send: (value: unknown) => void = writeLine) {
    this.workspace = resolveWorkspace(workspace)
    this.send = send
  }

  async start(): Promise<void> {
    this.session = await this.loadSession()
    await recordProject(this.workspace, true)
    this.event('gateway.ready', { cwd: this.session.workspace })
  }

  async handle(request: Request): Promise<void> {
    const id = request.id
    const method = typeof request.method === 'string' ? request.method : ''
    const params = request.params ?? {}
    let requestSession: FridaySession | undefined
    let requestFinalized = false
    try {
      if (method === 'session.info') this.ok(id, this.sessionInfo())
      else if (method === 'session.current') this.ok(id, { info: this.sessionInfo(), history: sessionHistory(this.session) })
      else if (method === 'session.resume_choices') this.ok(id, { choices: await this.resumeChoices() })
      else if (method === 'session.tree') this.ok(id, await sessionTree(this.workspace, String(params.id || this.session.sessionId)))
      else if (method === 'context.get') this.ok(id, { text: this.session.contextText() })
      else if (method === 'progress.get') this.ok(id, { progress: this.session.progress() })
      else if (method === 'trace.serve') {
        this.traceServer ??= await startTraceServer(this.workspace)
        this.ok(id, { url: this.traceServer.url })
      } else if (method === 'trace.stop') {
        const stopped = await stopTraceServer(this.traceServer)
        this.traceServer = undefined
        this.ok(id, { stopped })
      }
      else if (method === 'memory.command') {
        const session = this.session
        const result = await runMemoryCommand(String(params.command || ''), this.workspace, {
          consolidate: days => this.runVisibleSession(session, 'Consolidating memory', () => session.consolidateMemory(days))
        })
        // Structured result rides along so UIs can build pickers; the
        // formatted text stays the answer for plain command usage.
        this.ok(id, { text: formatMemoryResult(result), ...(typeof result === 'object' ? { result } : {}) })
      }
      else if (method === 'checkpoint.list') this.ok(id, { checkpoints: await checkpointChoices(this.workspace) })
      else if (method === 'checkpoint.undo') {
        const checkpointId = typeof params.id === 'string' && params.id ? params.id : undefined
        const result = await this.runGlobal(async () => {
          const restored = await restoreCheckpoint(this.workspace, checkpointId, params.force === true)
          if (this.session.sessionId !== restored.session_id) {
            this.session = await this.loadSession(restored.session_id)
          }
          await this.session.restoreCheckpoint(restored)
          return {
            id: restored.id,
            user: restored.user,
            changed_paths: restored.changed_paths,
            progress: this.session.progress(),
            history: sessionHistory(this.session),
            info: this.sessionInfo()
          }
        }, 'Stop running requests before restoring a checkpoint.')
        this.ok(id, result)
      }
      else if (method === 'plugin.list') {
        // The session's registry is the truth: built-in capability packs and
        // external plugins together, with live disabled/error state.
        this.ok(id, { plugins: this.session.info().plugins })
      }
      else if (method === 'plugin.toggle') {
        const name = String(params.name || '').trim()
        if (!name) throw new Error('Plugin name is required.')
        const enabled = params.enabled === true
        const result = await this.runGlobal(async () => {
          const known = this.session.info().plugins as Array<Record<string, unknown>>
          const target = known.find(plugin => String(plugin.name).toLowerCase() === name.toLowerCase())
          if (!target) throw new Error(`Unknown plugin: ${name}`)
          if (target.required === true && !enabled) throw new Error(`Plugin '${name}' is required and cannot be disabled.`)
          await setPluginEnabled(this.workspace, name, enabled)
          await this.session.reloadPlugins()
          return { plugins: this.session.info().plugins, info: this.sessionInfo() }
        }, 'Stop running requests before changing plugins.')
        this.ok(id, result)
      }
      else if (method === 'skill.list') this.ok(id, { skills: discoverSkills(this.workspace) })
      else if (method === 'skill.get') this.ok(id, skillDetail(this.workspace, String(params.path || '')))
      else if (method === 'artifact.get') this.ok(id, await artifactDetail(this.workspace, String(params.path || '')))
      else if (method === 'model.list') this.ok(id, modelCatalog(this.workspace))
      else if (method === 'projects.list') this.ok(id, { projects: listProjects(true) })
      else if (method === 'projects.close') {
        const workspace = String(params.workspace || '').trim()
        if (workspace) await closeProject(workspace)
        this.ok(id, { closed: !!workspace })
      } else if (method === 'settings.web.get') this.ok(id, loadWebSearchSettings())
      else if (method === 'settings.web.key.get') {
        this.ok(id, { api_key: readWebSearchCredential(String(params.provider || '')) })
      } else if (method === 'settings.web.save') {
        this.ok(id, await this.runGlobal(() => saveWebSearchSettings(params)))
      }
      else if (method === 'settings.user.save') {
        this.ok(id, await this.runGlobal(() => saveUserProfile(params.profile)))
      }
      else if (method === 'settings.memory.read') {
        this.ok(id, await memoryFile(this.workspace, params.file))
      } else if (method === 'settings.memory.save') {
        this.ok(id, await this.runGlobal(() => saveMemoryFile(this.workspace, params.file, params.content)))
      } else if (method === 'settings.get') {
        const [user, global] = await Promise.all([
          memoryFile(this.workspace, 'user', false), memoryFile(this.workspace, 'global', false)
        ])
        this.ok(id, {
          memory_files: { user, global },
          web_search: loadWebSearchSettings(),
          user_profile: loadUserProfile()
        })
      } else if (method === 'permission.set') {
        this.requireSessionIdle(this.session)
        const permission_mode = this.session.selectPermissionMode(params.mode)
        this.permissionMode = permission_mode
        this.ok(id, { permission_mode, session_id: this.session.sessionId })
      } else if (method === 'approval.pending') this.ok(id, this.session.approval())
      else if (method === 'session.reset') {
        const result = await this.runGlobal(async () => {
          const removed = await resetFriday(this.workspace, params.global === true)
          this.releaseSessions()
          this.session = await this.loadSession()
          await recordProject(this.workspace, true)
          return { removed, info: this.sessionInfo(), history: [] }
        }, 'Stop running requests before resetting Friday.')
        this.ok(id, result)
      } else if (method === 'session.new') {
        const result = await this.runNavigation(async () => {
          this.session = await this.loadSession()
          return { info: this.sessionInfo(), history: [] }
        })
        this.ok(id, result)
      } else if (method === 'session.compact') {
        const session = this.session
        this.ok(id, { text: await this.runVisibleSession(session, 'Compacting conversation', () => session.compact()) })
      } else if (method === 'session.resume') {
        const sessionId = typeof params.id === 'string' ? params.id : ''
        if (!sessionId) throw new Error('Session id is required.')
        const result = await this.runNavigation(async () => {
          if (!this.sessions.has(sessionId) && !await sessionExists(this.workspace, sessionId)) {
            throw new Error(`Session not found: ${sessionId}`)
          }
          this.session = await this.loadSession(sessionId)
          return {
            info: this.sessionInfo(), history: sessionHistory(this.session),
            count: this.session.context.messages.length, progress: this.session.progress()
          }
        })
        this.ok(id, result)
      } else if (method === 'session.rename') {
        const sessionId = String(params.id || '')
        const result = await this.runNavigation(async () => {
          const record = await renameSession(this.workspace, sessionId, String(params.title || ''))
          return { id: sessionId, title: record.title }
        })
        this.ok(id, result)
      } else if (method === 'session.fork') {
        const sourceId = String(params.id || this.session.sessionId)
        const rawIndex = params.message_index
        const messageIndex = rawIndex === undefined ? undefined : Number(rawIndex)
        const result = await this.runNavigation(async () => {
          let source = this.sessions.get(sourceId)
          if (!source) {
            if (!await sessionExists(this.workspace, sourceId)) throw new Error(`Session not found: ${sourceId}`)
            source = await this.loadSession(sourceId)
          }
          this.assertSessionIdle(source, 'Stop the running request before forking this session.')
          const snapshot = await forkSession(this.workspace, sourceId, messageIndex, source.transcript())
          this.session = await this.loadSession(String(snapshot.session_id))
          return {
            history: sessionHistory(this.session), info: this.sessionInfo(),
            tree: await sessionTree(this.workspace, this.session.sessionId)
          }
        })
        this.ok(id, result)
      } else if (method === 'session.delete') {
        const sessionId = String(params.id || '')
        const result = await this.runNavigation(async () => {
          const deleted = await this.deleteSessions(sessionId)
          if (deleted.includes(this.session.sessionId)) this.session = await this.loadSession()
          return { deleted, info: this.sessionInfo(), history: sessionHistory(this.session) }
        })
        this.ok(id, result)
      } else if (method === 'goal.run') {
        const text = typeof params.text === 'string' ? params.text.trim() : ''
        if (!text) throw new Error('Goal cannot be empty.')
        const session = this.session
        const images = imageUrls(params.images)
        const attachments = await localAttachments(params.attachments)
        const run = this.runSession(session, `/goal ${text}`, async () => {
          this.event('message.start', { text: `/goal ${text}`, session_id: session.sessionId })
          this.event('session.updated', { running: true, session_id: session.sessionId })
          try {
            const result = await session.goal(
              text,
              chunk => this.event('message.delta', { text: chunk, session_id: session.sessionId }),
              { images, attachments }
            )
            this.emitTurn(session, result)
            this.titleSession(session)
            if (result.status === 'done') this.followUpSteers(session)
            requestFinalized = true
            return result
          } catch (error) {
            this.finishTurnError(session.sessionId, error)
            requestFinalized = true
            throw error
          }
        })
        requestSession = session
        const result = await run
        this.ok(id, {
          text: result.text,
          verification: result.verification,
          stop_reason: result.stop_reason,
          session_id: session.sessionId
        })
      } else if (method === 'thinking.set') {
        this.requireSessionIdle(this.session)
        const thinking_effort = this.session.selectThinking(params.effort)
        this.ok(id, { thinking_effort, info: this.sessionInfo() })
      } else if (method === 'model.save') {
        if (!params.profile || typeof params.profile !== 'object' || Array.isArray(params.profile)) {
          throw new Error('Model configuration must be an object.')
        }
        const result = await this.runGlobal(async () => {
          const catalog = await saveModelProfile(this.workspace, params.profile as Record<string, unknown>, {
            ...(typeof params.api_key === 'string' ? { apiKey: params.api_key } : {}),
            ...(params.clear_api_key === true ? { clearApiKey: true } : {}),
            activate: params.activate !== false
          })
          this.useAvailableModel(catalog, params.activate !== false)
          return { catalog: modelCatalog(this.workspace), info: this.sessionInfo() }
        })
        this.ok(id, result)
      } else if (method === 'model.key.get') {
        this.ok(id, { api_key: readModelCredential(this.workspace, String(params.provider || ''), String(params.profile || '')) })
      } else if (method === 'model.key.clear') {
        const result = await this.runGlobal(async () => {
          const catalog = await clearModelCredential(this.workspace, String(params.provider || ''), String(params.profile || ''))
          this.useAvailableModel(catalog)
          return { catalog: modelCatalog(this.workspace), info: this.sessionInfo() }
        })
        this.ok(id, result)
      } else if (method === 'model.refresh') {
        const result = await this.runGlobal(async () => {
          const refreshed = await refreshModelProfiles(this.workspace, String(params.provider || ''), String(params.profile || ''))
          this.useAvailableModel(refreshed.catalog)
          return { catalog: modelCatalog(this.workspace), info: this.sessionInfo(), models: refreshed.models }
        })
        this.ok(id, result)
      } else if (method === 'model.enabled.set') {
        const result = await this.runGlobal(async () => {
          const catalog = await setModelEnabled(
            this.workspace, params.enabled === true, String(params.provider || ''), String(params.profile || '')
          )
          this.useAvailableModel(catalog)
          return { catalog: modelCatalog(this.workspace), info: this.sessionInfo() }
        })
        this.ok(id, result)
      } else if (method === 'model.select') {
        const profileId = String(params.id || '')
        const result = await this.runGlobal(async () => {
          await selectModelProfile(this.workspace, profileId)
          this.session.selectModel(profileId)
          return { catalog: modelCatalog(this.workspace), info: this.sessionInfo() }
        })
        this.ok(id, result)
      } else if (method === 'model.delete') {
        const result = await this.runGlobal(async () => {
          const catalog = await deleteModelProfile(this.workspace, String(params.id || ''))
          this.useAvailableModel(catalog)
          return { catalog: modelCatalog(this.workspace), info: this.sessionInfo() }
        })
        this.ok(id, result)
      } else if (method === 'chat.send') {
        const text = typeof params.text === 'string' ? params.text : ''
        if (!text.trim()) throw new Error('Message cannot be empty.')
        const session = this.session
        const images = imageUrls(params.images)
        const attachments = await localAttachments(params.attachments)
        const run = this.runSession(session, text, async () => {
          this.event('message.start', { text, session_id: session.sessionId })
          this.event('session.updated', { running: true, session_id: session.sessionId })
          try {
            const result = await session.chat(
              text,
              chunk => this.event('message.delta', { text: chunk, session_id: session.sessionId }),
              { images, attachments }
            )
            this.emitTurn(session, result)
            this.titleSession(session)
            if (result.status === 'done') this.followUpSteers(session)
            requestFinalized = true
            return result
          } catch (error) {
            this.finishTurnError(session.sessionId, error)
            requestFinalized = true
            throw error
          }
        })
        requestSession = session
        const result = await run
        this.ok(id, { text: result.text, session_id: session.sessionId })
      } else if (method === 'chat.steer') {
        const text = typeof params.text === 'string' ? params.text.trim() : ''
        if (!text) throw new Error('Steering message cannot be empty.')
        const session = this.session
        session.steer(text)
        // Everyone watching this session renders the injected message from
        // this event; the steering client does not add a local copy.
        this.event('message.steered', { text, session_id: session.sessionId })
        this.ok(id, { steered: true, session_id: session.sessionId })
      } else if (method === 'chat.cancel') {
        const sessionId = String(params.session_id || this.session.sessionId)
        const session = this.sessions.get(sessionId)
        const cancelled = !!session && this.activeRuns.has(sessionId) && session.cancel()
        this.ok(id, { cancelled, ...(cancelled ? { session_id: sessionId } : {}) })
      } else if (method === 'approval.approve') {
        const session = this.session
        this.requireSessionIdle(session)
        requestSession = session
        await this.resolveApproval(id, session, 'approve', params, () => { requestFinalized = true })
      } else if (method === 'approval.instruct') {
        const instruction = typeof params.text === 'string' ? params.text.trim() : ''
        if (!instruction) throw new Error('Tell Friday what to do before continuing.')
        const session = this.session
        this.requireSessionIdle(session)
        requestSession = session
        await this.resolveApproval(id, session, 'instruct', { text: instruction }, () => { requestFinalized = true })
      } else if (method === 'approval.reject') {
        const session = this.session
        this.requireSessionIdle(session)
        requestSession = session
        await this.resolveApproval(id, session, 'reject', params, () => { requestFinalized = true })
      } else throw new Error(`Method not implemented by the TypeScript gateway: ${method}`)
    } catch (error) {
      if (requestSession && isAbort(error) && (method === 'chat.send' || method === 'goal.run')) {
        const sessionId = requestSession.sessionId
        if (!requestFinalized) this.finishTurnError(sessionId, error)
        this.ok(id, { cancelled: true, session_id: sessionId })
        return
      }
      if (!requestFinalized && requestSession && (method === 'chat.send' || method === 'goal.run' || method.startsWith('approval.'))) {
        const sessionId = requestSession.sessionId
        this.finishActivity(sessionId, true)
        this.event('session.updated', { running: false, session_id: sessionId })
      }
      this.send({ jsonrpc: '2.0', id: id ?? null, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } })
    }
  }

  private ok(id: unknown, result: unknown): void {
    this.send({ jsonrpc: '2.0', id: id ?? null, result })
  }

  async close(): Promise<void> {
    await stopTraceServer(this.traceServer)
    this.traceServer = undefined
    for (const session of this.sessions.values()) session.cancel()
    await Promise.allSettled([
      ...this.activeRuns.values(),
      ...(this.globalRun ? [this.globalRun] : []),
      ...(this.navigationRun ? [this.navigationRun] : [])
    ])
    this.releaseSessions()
  }

  private event(type: string, payload: Record<string, unknown>): void {
    this.send({ jsonrpc: '2.0', method: 'event', params: { type, payload } })
  }

  private emitTurn(session: FridaySession, result: {
    text: string
    metrics: unknown
    status: 'done' | 'paused'
    stop_reason?: string
    verification?: unknown
    artifacts?: unknown
  }): void {
    this.finishActivity(session.sessionId)
    if (result.status === 'paused') {
      this.event('approval.pending', { ...session.approval(), session_id: session.sessionId })
      this.event('message.suspended', {
        text: result.text,
        metrics: result.metrics,
        progress: session.progress(),
        status: 'needs_approval',
        ...(result.artifacts ? { artifacts: result.artifacts } : {}),
        session_id: session.sessionId
      })
    } else {
      this.event('message.complete', {
        text: result.text,
        metrics: result.metrics,
        progress: session.progress(),
        status: result.stop_reason || 'done',
        fork_points: sessionHistory(session).flatMap(item =>
          item.kind === 'assistant' && typeof item.message_index === 'number'
            ? [{ kind: 'assistant', message_index: item.message_index }]
            : []
        ),
        ...(result.verification ? { verification: result.verification } : {}),
        ...(result.artifacts ? { artifacts: result.artifacts } : {}),
        session_id: session.sessionId
      })
    }
    this.event('session.updated', { running: false, session_id: session.sessionId })
  }

  private async resolveApproval(
    id: unknown,
    session: FridaySession,
    decision: 'approve' | 'instruct' | 'reject',
    params: Record<string, unknown>,
    finalized: () => void
  ): Promise<void> {
    const outcome = await this.runSession(session, `Approval: ${decision}`, async () => {
      this.event('session.updated', { running: true, session_id: session.sessionId })
      try {
        let announced = false
        const resolved = (continued: boolean) => {
          announced = true
          this.event('approval.resolved', { decision, continued, session_id: session.sessionId })
        }
        const delta = (text: string) => this.event('message.delta', { text, session_id: session.sessionId })
        const result = decision === 'approve'
          ? await session.approve(params.session === true, delta, resolved)
          : await session.reject(decision === 'instruct' ? String(params.text || '') : '', delta, resolved)
        if (!announced) resolved(result.continued)
        if (result.turn) this.emitTurn(session, result.turn)
        else this.event('session.updated', { running: false, session_id: session.sessionId })
        finalized()
        return result
      } catch (error) {
        this.finishActivity(session.sessionId, true)
        this.event('session.updated', { running: false, session_id: session.sessionId })
        finalized()
        throw error
      }
    })
    this.ok(id, outcome.continued
      ? { approval: outcome.approval, approved: decision === 'approve', continued: true, message: { text: outcome.turn?.text || '' } }
      : outcome.approval)
  }

  /**
   * Steers accepted after the turn's last model step never reached the model;
   * run them as an immediate follow-up turn so nothing typed is lost. The
   * turn announces itself through the same events as a client-sent message.
   */
  private followUpSteers(session: FridaySession): void {
    const pending = session.takeUndeliveredSteers()
    if (!pending.length) return
    const text = pending.join('\n')
    void this.runSession(session, text, async () => {
      this.event('message.start', { text, session_id: session.sessionId })
      this.event('session.updated', { running: true, session_id: session.sessionId })
      try {
        const result = await session.chat(
          text,
          chunk => this.event('message.delta', { text: chunk, session_id: session.sessionId }),
          {}
        )
        this.emitTurn(session, result)
        this.titleSession(session)
        if (result.status === 'done') this.followUpSteers(session)
      } catch (error) {
        this.finishTurnError(session.sessionId, error)
      }
    }).catch(() => {})
  }

  /**
   * Name a conversation after its first turn, off the request path. The
   * session method is idempotent, so firing after every turn is safe; the
   * event tells UIs to refresh their lists without polling.
   */
  private titleSession(session: FridaySession): void {
    // Tests script their mock model responses; an extra naming request would
    // consume them, so the switch exists for deterministic runs.
    if (process.env.FRIDAY_AUTOTITLE === '0') return
    if (this.titling.has(session.sessionId)) return
    this.titling.add(session.sessionId)
    void session.ensureTitle().then(title => {
      if (title) this.event('session.titled', { session_id: session.sessionId, title })
    }).catch(() => {}).finally(() => this.titling.delete(session.sessionId))
  }

  private attach(session: FridaySession): void {
    session.onEvent = event => this.eventFromCore(event, session)
  }

  private async loadSession(sessionId?: string): Promise<FridaySession> {
    if (sessionId) {
      if (this.deletingSessions.has(sessionId)) throw new Error('This session is being deleted.')
      const cached = this.sessions.get(sessionId)
      if (cached) {
        this.remember(cached)
        return cached
      }
      const loading = this.sessionLoads.get(sessionId)
      if (loading) return loading
    }
    const loading = (async () => {
      const session = await FridaySession.create(this.workspace, sessionId)
      if (this.permissionMode) session.selectPermissionMode(this.permissionMode)
      this.attach(session)
      this.remember(session)
      return session
    })()
    if (sessionId) this.sessionLoads.set(sessionId, loading)
    try {
      return await loading
    } finally {
      if (sessionId && this.sessionLoads.get(sessionId) === loading) this.sessionLoads.delete(sessionId)
    }
  }

  private remember(session: FridaySession): void {
    this.sessions.delete(session.sessionId)
    this.sessions.set(session.sessionId, session)
    this.evictSessions(session.sessionId)
  }

  private evictSessions(protectedId = ''): void {
    if (this.sessions.size <= MAX_CACHED_SESSIONS) return
    for (const [sessionId, session] of this.sessions) {
      if (this.sessions.size <= MAX_CACHED_SESSIONS) break
      if (sessionId === protectedId || sessionId === this.session?.sessionId || this.activeRuns.has(sessionId)) continue
      delete session.onEvent
      this.sessions.delete(sessionId)
    }
  }

  private releaseSessions(): void {
    for (const session of this.sessions.values()) delete session.onEvent
    this.sessions.clear()
    this.sessionLoads.clear()
    this.activeRuns.clear()
    this.runLabels.clear()
    this.deletingSessions.clear()
  }

  /**
   * Run `work` as a tracked promise: `register` publishes the tracked handle
   * before work starts (so concurrent guards can see it) and returns the
   * cleanup that retires it. One primitive backs the session, global, and
   * navigation lanes instead of three hand-rolled copies of the same gate.
   */
  private launch<T>(work: () => Promise<T>, register: (tracked: Promise<unknown>) => () => void): Promise<T> {
    let start = () => {}
    const gate = new Promise<void>(resolve => { start = resolve })
    const run = (async () => {
      await gate
      return work()
    })()
    let cleanup: () => void = () => {}
    const tracked = run.finally(() => cleanup())
    cleanup = register(tracked)
    start()
    return tracked
  }

  private runSession<T>(session: FridaySession, label: string, work: () => Promise<T>): Promise<T> {
    this.requireSessionIdle(session)
    return this.launch(work, tracked => {
      this.activeRuns.set(session.sessionId, tracked)
      this.runLabels.set(session.sessionId, label)
      return () => {
        if (this.activeRuns.get(session.sessionId) === tracked) {
          this.activeRuns.delete(session.sessionId)
          this.runLabels.delete(session.sessionId)
          this.remember(session)
        }
      }
    })
  }

  private runVisibleSession<T>(session: FridaySession, label: string, work: () => Promise<T>): Promise<T> {
    return this.runSession(session, label, async () => {
      this.event('session.updated', { running: true, session_id: session.sessionId })
      try {
        return await work()
      } finally {
        this.event('session.updated', { running: false, session_id: session.sessionId })
      }
    })
  }

  private runGlobal<T>(work: () => Promise<T>, message?: string): Promise<T> {
    this.requireAllIdle(message)
    return this.launch(work, tracked => {
      this.globalRun = tracked
      return () => {
        if (this.globalRun === tracked) this.globalRun = undefined
      }
    })
  }

  private runNavigation<T>(work: () => Promise<T>): Promise<T> {
    this.requireNoGlobalRun()
    if (this.navigationRun) throw new Error('Another session navigation is in progress.')
    return this.launch(work, tracked => {
      this.navigationRun = tracked
      return () => {
        if (this.navigationRun === tracked) this.navigationRun = undefined
      }
    })
  }

  private requireSessionIdle(session: FridaySession, message = 'This session already has a request in progress.'): void {
    if (this.globalRun) throw new Error('A workspace-wide operation is in progress.')
    if (this.navigationRun) throw new Error('A session navigation is in progress.')
    this.assertSessionIdle(session, message)
  }

  private assertSessionIdle(session: FridaySession, message: string): void {
    if (this.deletingSessions.has(session.sessionId)) throw new Error('This session is being deleted.')
    if (session.running || this.activeRuns.has(session.sessionId)) throw new Error(message)
  }

  private requireAllIdle(message = 'Stop running requests before changing global settings.'): void {
    if (this.globalRun || this.navigationRun || this.deletingSessions.size || this.activeRuns.size
      || [...this.sessions.values()].some(session => session.running)) {
      throw new Error(message)
    }
  }

  private requireNoGlobalRun(): void {
    if (this.globalRun) throw new Error('A workspace-wide operation is in progress.')
  }

  private sessionInfo(session = this.session): Record<string, unknown> {
    return {
      ...session.info(),
      running: session.running || this.activeRuns.has(session.sessionId)
    }
  }

  private async resumeChoices(): Promise<Record<string, unknown>[]> {
    const choices = await sessionChoices(this.workspace)
    const byId = new Map(choices.map(choice => [String(choice.id ?? ''), choice]))
    for (const [sessionId] of this.activeRuns) {
      const existing = byId.get(sessionId)
      if (existing) {
        existing.running = true
        continue
      }
      const tree = await sessionTree(this.workspace, sessionId) as { root?: unknown }
      const root = String(tree.root || '')
      if (root && root !== sessionId) continue
      const session = this.sessions.get(sessionId)
      if (!session) continue
      const label = this.runLabels.get(sessionId) || 'New conversation'
      const progress = session.progress()
      choices.unshift({
        assistant: '',
        id: sessionId,
        objective: String(progress.objective || ''),
        running: true,
        status: 'working',
        time: '',
        title: '',
        turns: '0',
        user: label.slice(0, 80)
      })
    }
    return choices
  }

  private async deleteSessions(sessionId: string): Promise<string[]> {
    const tree = await sessionTree(this.workspace, sessionId) as {
      nodes?: Array<{ id?: unknown; parent?: unknown }>
    }
    const children = new Map<string, string[]>()
    for (const node of tree.nodes ?? []) {
      const child = String(node.id || '')
      const parent = String(node.parent || '')
      if (child && parent) children.set(parent, [...children.get(parent) ?? [], child])
    }
    const subtree: string[] = []
    const pending = [sessionId]
    while (pending.length) {
      const current = pending.pop()!
      if (!current || subtree.includes(current)) continue
      if (current === sessionId || (tree.nodes ?? []).some(node => node.id === current)) subtree.push(current)
      pending.push(...children.get(current) ?? [])
    }
    if (!(tree.nodes ?? []).some(node => node.id === sessionId) && !this.sessions.has(sessionId)) {
      return deleteSessionTree(this.workspace, sessionId)
    }

    if (subtree.some(id => this.deletingSessions.has(id))) throw new Error('This session is already being deleted.')
    for (const id of subtree) this.deletingSessions.add(id)
    try {
      const runs = subtree.flatMap(id => {
        const run = this.activeRuns.get(id)
        if (!run) return []
        this.sessions.get(id)?.cancel()
        return [run]
      })
      if (runs.length) await waitForRuns(runs)

      const persisted = await deleteSessionTree(this.workspace, sessionId, true)
      const deleted = [...new Set([...subtree, ...persisted])]
      for (const deletedId of deleted) {
        const session = this.sessions.get(deletedId)
        if (session) delete session.onEvent
        this.sessions.delete(deletedId)
        this.activeRuns.delete(deletedId)
        this.runLabels.delete(deletedId)
      }
      return deleted
    } finally {
      for (const id of subtree) this.deletingSessions.delete(id)
    }
  }

  private useAvailableModel(catalog: ModelCatalog, preferActive = false): void {
    const enabled = new Set(catalog.profiles.filter(profile => profile.enabled).map(profile => profile.id))
    if (preferActive || !enabled.has(this.session.config.profileId)) this.session.selectModel(catalog.active)
  }

  private eventFromCore(event: AgentEvent, session: FridaySession): void {
    const sessionId = session.sessionId
    const reasoningKey = `${sessionId}:${event.runId}:${event.step ?? 0}`
    if (event.type === 'model.reasoning.delta') {
      let active = this.reasoning.get(reasoningKey)
      if (!active) {
        active = { id: `reasoning-${++this.reasoningSequence}`, started: event.timestamp }
        this.reasoning.set(reasoningKey, active)
      }
      this.event('reasoning.delta', { id: active.id, text: event.data.content, session_id: sessionId })
    } else if (event.type === 'model.response' && event.data.has_reasoning) {
      const active = this.reasoning.get(reasoningKey)
      if (active) {
        this.reasoning.delete(reasoningKey)
        this.event('reasoning.complete', {
          id: active.id,
          elapsed_ms: Math.max(0, event.timestamp - active.started),
          session_id: sessionId
        })
      }
    } else if (event.type === 'tool.call') {
      const id = String(event.data.tool_call_id ?? '')
      this.toolNames.set(`${sessionId}:${id}`, String(event.data.name ?? ''))
      this.event('tool.start', { ...event.data, session_id: sessionId })
    } else if (event.type === 'tool.result') {
      const id = String(event.data.tool_call_id ?? '')
      const name = this.toolNames.get(`${sessionId}:${id}`) ?? ''
      const approval = approvalPayload(event.data.content)
      this.toolNames.delete(`${sessionId}:${id}`)
      this.event('tool.complete', {
        ...event.data,
        name,
        error: event.data.is_error,
        ...(approval ? { approval } : {}),
        session_id: sessionId
      })
    } else if (event.type === 'tool.progress') {
      this.event('tool.update', { ...event.data, session_id: sessionId })
    } else if (event.type === 'context.compacted') this.event('context.compacted', { ...event.data, session_id: sessionId })
    else if (event.type === 'memory.updated') this.event('memory.updated', { ...event.data, session_id: sessionId })
    else if (event.type === 'progress.updated') this.event('progress.update', { ...event.data, session_id: sessionId })
    else if (event.type === 'verification.start') this.event('verification.start', { session_id: sessionId })
    else if (event.type === 'verification.result') this.event('verification.complete', { ...event.data, session_id: sessionId })
  }

  private finishActivity(sessionId: string, error = false): void {
    const prefix = `${sessionId}:`
    for (const [key, active] of this.reasoning) {
      if (!key.startsWith(prefix)) continue
      this.reasoning.delete(key)
      this.event('reasoning.complete', {
        id: active.id,
        elapsed_ms: Math.max(0, Date.now() - active.started),
        ...(error ? { error: true } : {}),
        session_id: sessionId
      })
    }
    for (const key of this.toolNames.keys()) {
      if (key.startsWith(prefix)) this.toolNames.delete(key)
    }
  }

  private finishTurnError(sessionId: string, error: unknown): void {
    const cancelled = isAbort(error)
    if (cancelled) this.event('message.cancelled', { session_id: sessionId })
    this.finishActivity(sessionId, !cancelled)
    this.event('session.updated', { running: false, session_id: sessionId })
  }
}

function writeLine(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

function approvalPayload(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed as Record<string, unknown>).approval_required === true
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

async function waitForRuns(runs: Promise<unknown>[]): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), 5_000)
  })
  const outcome = await Promise.race([
    Promise.allSettled(runs).then(() => 'done' as const),
    timeout
  ])
  if (timer) clearTimeout(timer)
  if (outcome === 'timeout') throw new Error('A running command did not stop; the session was not deleted.')
}

function modelCatalog(workspace: string): ModelCatalog & { profiles: Array<ModelCatalog['profiles'][number] & { thinking_options: string[] }> } {
  const catalog = loadModelCatalog(workspace)
  return {
    ...catalog,
    profiles: catalog.profiles.map(profile => ({
      ...profile,
      thinking_options: thinkingOptions(profile.provider, profile.model)
    }))
  }
}

export async function runGateway(): Promise<void> {
  const gateway = new Gateway()
  await gateway.start()
  // Leaving no orphans is this block's one job. A client kill (SIGTERM from
  // the TUI, SIGINT from a terminal) must cancel running sessions so their
  // detached tool process trees are killed rather than inherited by init;
  // and once shutdown starts, a bounded timer guarantees the process ends
  // even if a stuck request or a runtime stdin quirk would keep the event
  // loop alive (the compiled Bun sidecar exhibited exactly that).
  let closing = false
  const shutdown = (code: number): void => {
    if (closing) return
    closing = true
    setTimeout(() => process.exit(code), 3_000).unref()
    void gateway.close()
      .catch(() => {})
      .finally(() => process.exit(code))
  }
  process.once('SIGTERM', () => shutdown(0))
  process.once('SIGINT', () => shutdown(0))
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  try {
    for await (const line of input) {
      if (!line.trim()) continue
      try {
        const value: unknown = JSON.parse(line.replace(/^\uFEFF/, ''))
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected an object')
        void gateway.handle(value as Request)
      } catch (error) {
        writeLine({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `Invalid JSON-RPC request: ${error instanceof Error ? error.message : String(error)}` } })
      }
    }
  } finally {
    shutdown(0)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runGateway()
}
