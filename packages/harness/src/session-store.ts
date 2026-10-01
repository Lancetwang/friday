import { readFile, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { Message } from 'friday-agent-core'
import type { HistoryItem, ResumeChoice } from 'friday-agent-protocol'
import type { FridaySession } from './session.js'
import type { ResourceState } from './resources.js'
import { projectStateDir } from './config.js'
import { deleteSessionCheckpoints } from './checkpoint.js'
import { deleteSessionTraces } from './trace.js'
import { collectMessageObjects, readMessagePage, readRecord, recordSummary, writeRecord } from './records.js'
import { localTimestamp, localTimestamp as now } from './time.js'
import { turnMetrics } from './session-metrics.js'
import { withStateLock, writeJsonAtomic } from './storage.js'


export type Snapshot = {
  resources?: ResourceState
  revision?: number
  execution?: Record<string, unknown>
  archived: Message[]
  messages: Message[]
  progress: unknown
  thinkingEffort: unknown
  title: unknown
  lastUsage: unknown
  turns: number
}


export type SessionRecord = Record<string, unknown> & { session_id?: string }


export async function sessionChoices(workspace: string): Promise<ResumeChoice[]> {
  const records = await sessionRecords(workspace)
  return records
    .filter(record => !record.fork_parent)
    .sort((left, right) => String(right.updated ?? '').localeCompare(String(left.updated ?? '')))
    .map(record => {
      const progress = record.progress && typeof record.progress === 'object' && !Array.isArray(record.progress)
        ? record.progress as Record<string, unknown>
        : {}
      return {
      id: String(record.session_id ?? ''),
      title: String(record.title || record.user || 'Conversation').slice(0, 80),
      user: String(record.user ?? ''),
      assistant: String(record.assistant ?? ''),
      objective: String(progress.objective || ''),
      status: String(progress.status || 'done'),
      time: String(record.updated ?? ''),
      turns: String(record.turns ?? 0)
      }
    })
}


export function sessionHistory(session: FridaySession): HistoryItem[] {
  const transcript = session.transcript()
  const history: HistoryItem[] = []
  const tools = new Map<string, number>()
  const userRows: number[] = []
  const toolActivity = new Map<string, Record<string, unknown>>()
  for (const message of transcript) {
    if (!Array.isArray(message.friday_activities)) continue
    for (const item of message.friday_activities) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const activity = item as Record<string, unknown>
      if (activity.kind === 'tool' && typeof activity.tool_call_id === 'string') toolActivity.set(activity.tool_call_id, activity)
    }
  }
  for (const [messageIndex, message] of transcript.entries()) {
    if (message.friday_goal_draft) continue
    const content = message.role === 'user' && typeof message.friday_display_text === 'string'
      ? message.friday_display_text
      : messageText(message.content)
    if (message.role === 'user' && content && !message.friday_internal) {
      userRows.push(history.length)
      history.push({
        kind: 'user', message_index: messageIndex, text: content,
        images: messageImages(message.content),
        attachments: Array.isArray(message.friday_attachments) ? message.friday_attachments : [],
        ...(typeof message.friday_timestamp === 'string' ? { timestamp: message.friday_timestamp } : {}),
        ...(message.friday_goal === true ? { goal: true } : {})
      })
    } else if (message.role === 'assistant' && !message.friday_progress) {
      if (Array.isArray(message.friday_activities)) {
        for (const item of message.friday_activities) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) continue
          const activity = item as Record<string, unknown>
          if (activity.kind === 'reasoning') history.push({
            kind: 'reasoning', message_index: messageIndex,
            text: String(activity.text || ''), status: historyStatus(activity.status),
            ...(typeof activity.elapsed_ms === 'number' ? { elapsed_ms: activity.elapsed_ms } : {})
          })
        }
      }
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          if (!call || typeof call !== 'object') continue
          const value = call as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }
          const id = String(value.id ?? '')
          const args = parseJson(value.function?.arguments)
          const timing = toolActivity.get(id)
          tools.set(id, history.length)
          history.push({
            kind: 'tool', message_index: messageIndex, tool_call_id: id,
            name: String(value.function?.name || 'Tool'), arguments: args,
            status: historyStatus(timing?.status, 'running'), text: '',
            ...(typeof timing?.elapsed_ms === 'number' ? { elapsed_ms: timing.elapsed_ms } : {})
          })
        }
      }
      if (content) history.push({
        kind: 'assistant', message_index: messageIndex, text: content,
        ...(Array.isArray(message.friday_artifacts) ? { artifacts: message.friday_artifacts } : {}),
        ...(message.friday_metrics && typeof message.friday_metrics === 'object' && !Array.isArray(message.friday_metrics)
          ? { metrics: message.friday_metrics }
          : {})
      })
    } else if (message.role === 'tool') {
      const id = String(message.tool_call_id ?? '')
      const index = tools.get(id)
      const timing = toolActivity.get(id)
      const item: HistoryItem = {
        kind: 'tool', message_index: messageIndex, tool_call_id: id, name: 'Tool', arguments: {},
        status: historyStatus(timing?.status), text: content,
        ...(typeof timing?.elapsed_ms === 'number' ? { elapsed_ms: timing.elapsed_ms } : {})
      }
      if (index === undefined) history.push(item)
      else Object.assign(history[index]!, {
        status: historyStatus(timing?.status), text: content,
        ...(typeof timing?.elapsed_ms === 'number' ? { elapsed_ms: timing.elapsed_ms } : {})
      })
    }
  }
  for (const index of userRows.slice(0, -6)) if (Array.isArray(history[index]?.images)) history[index]!.images = []
  return history
}


function historyStatus(value: unknown, fallback: NonNullable<HistoryItem['status']> = 'done'): NonNullable<HistoryItem['status']> {
  return value === 'approval' || value === 'done' || value === 'error' || value === 'running' ? value : fallback
}


export async function renameSession(workspace: string, sessionId: string, value: string): Promise<Record<string, unknown>> {
  const title = value.trim().replace(/\s+/g, ' ')
  if (!title) throw new Error('Session title cannot be empty.')
  if (title.length > 120) throw new Error('Session title cannot exceed 120 characters.')
  const path = sessionPath(workspace, sessionId)
  return withStateLock(path, async () => {
    const record = await readObject(path)
    if (!record.session_id) throw new Error(`Session not found: ${sessionId}`)
    const updated = { ...record, title, updated: now() }
    await writeJsonAtomic(path, updated, true)
    return updated
  })
}


export async function forkSession(
  workspace: string,
  sourceId: string,
  requestedIndex?: number,
  liveMessages?: Message[]
): Promise<Record<string, unknown>> {
  const source = await readRecord(workspace, sessionPath(workspace, sourceId))
  if (!source.session_id) throw new Error(`Session not found: ${sourceId}`)
  const stored = Array.isArray(source.messages) ? source.messages.filter(isMessage) : []
  const archived = Array.isArray(source.archived_messages) ? source.archived_messages.filter(isMessage) : []
  hydrateLegacySnapshot(source, stored, archived)
  const storedTranscript = [
    ...archived,
    ...conversationBody(stored).filter(message => !message.friday_compaction_artifact)
  ]
  const body = conversationBody(liveMessages ?? storedTranscript)
  const messageIndex = requestedIndex ?? body.findLastIndex(message => message.role === 'assistant')
  if (!Number.isSafeInteger(messageIndex) || messageIndex < 0 || messageIndex >= body.length) {
    throw new Error('Fork point is outside the conversation.')
  }
  if (body[messageIndex]?.role !== 'assistant') throw new Error('Conversations can only fork from an assistant response.')
  const messages = structuredClone(body.slice(0, messageIndex + 1))
  const sessionId = newSessionId()
  const created = now()
  const turns = messages.filter(message => message.role === 'user' && !message.friday_internal).length
  // A fork is named by the message it split from, not by its parent session:
  // that is the fact the user needs to tell branches apart.
  const sourceText = messageText(body[messageIndex]!.content).replace(/\s+/g, ' ').trim().slice(0, 120)
  const snapshot = {
    session_id: sessionId,
    created,
    updated: created,
    title: (sourceText ? `Fork: ${sourceText}` : `Fork of ${String(source.title || source.user || sourceId)}`).slice(0, 120),
    turns,
    user: String(source.user || ''),
    assistant: '',
    messages,
    progress: {},
    last_usage: {},
    thinking_effort: source.thinking_effort,
    fork_parent: sourceId,
    fork_root: String(source.fork_root || sourceId),
    fork_message_index: messageIndex,
    fork_source_text: sourceText,
    ...legacySnapshotMetadata(messages)
  }
  await writeRecord(workspace, sessionPath(workspace, sessionId), snapshot)
  return snapshot
}


export async function deleteSessionTree(workspace: string, sessionId: string, allowMissing = false): Promise<string[]> {
  sessionPath(workspace, sessionId)
  const records = await sessionRecords(workspace)
  if (!records.some(record => record.session_id === sessionId) && !allowMissing) throw new Error(`Session not found: ${sessionId}`)
  const children = new Map<string, string[]>()
  for (const record of records) {
    const parent = String(record.fork_parent || '')
    if (parent) children.set(parent, [...children.get(parent) ?? [], String(record.session_id)])
  }
  const deleted: string[] = []
  const pending = [sessionId]
  while (pending.length) {
    const current = pending.pop()!
    if (deleted.includes(current)) continue
    deleted.push(current)
    pending.push(...children.get(current) ?? [])
  }
  for (const id of [...deleted].reverse()) {
    await rm(sessionPath(workspace, id), { force: true })
    await rm(join(projectStateDir(workspace), 'sessions', 'index', `${id}.json`), { force: true })
    await rm(join(projectStateDir(workspace), 'approvals', `${id}.json`), { force: true })
    await rm(join(projectStateDir(workspace), 'sessions', `${id}-tools`), { recursive: true, force: true })
  }
  await deleteSessionCheckpoints(workspace, deleted)
  await deleteSessionTraces(workspace, deleted)
  await collectMessageObjects(workspace)
  return deleted
}


export async function sessionTree(workspace: string, sessionId: string): Promise<Record<string, unknown>> {
  const records = await sessionRecords(workspace)
  const current = records.find(record => record.session_id === sessionId)
  if (!current) return { root: '', nodes: [] }
  const root = String(current.fork_root || current.session_id || '')
  return {
    root,
    nodes: records
      .filter(record => record.session_id === root || record.fork_root === root)
      .map(record => ({
        id: String(record.session_id ?? ''),
        parent: String(record.fork_parent ?? ''),
        title: String(record.title || record.user || 'Conversation').slice(0, 80),
        time: String(record.updated ?? ''),
        turns: Number.isSafeInteger(record.turns) ? record.turns as number : 0,
        // Where in the parent the branch split off, so UIs can label the origin.
        ...(Number.isSafeInteger(record.fork_message_index)
          ? { fork_message_index: record.fork_message_index as number }
          : {}),
        ...(typeof record.fork_source_text === 'string' && record.fork_source_text
          ? { fork_source: record.fork_source_text.slice(0, 120) }
          : {})
      }))
  }
}


export async function sessionExists(workspace: string, sessionId: string): Promise<boolean> {
  return !!(await readObject(sessionPath(workspace, sessionId))).session_id
}


export async function sessionMessagePage(workspace: string, sessionId: string, offset = 0, limit = 100): Promise<Message[]> {
  const record = await readObject(sessionPath(workspace, sessionId))
  return readMessagePage(workspace, record.messages ?? [], offset, Math.min(limit, 500))
}


async function sessionRecords(workspace: string): Promise<SessionRecord[]> {
  const directory = join(projectStateDir(resolve(workspace)), 'sessions')
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const records = await Promise.all(names.filter(name => name.endsWith('.json')).map(async name => {
    try {
      const value: unknown = await recordSummary(join(directory, name))
      return value && typeof value === 'object' && !Array.isArray(value) ? value as SessionRecord : undefined
    } catch {
      return undefined
    }
  }))
  return records.filter((value): value is SessionRecord => !!value?.session_id)
}


export async function readSnapshot(workspace: string, sessionId: string): Promise<Snapshot | undefined> {
  try {
    const value: unknown = await readRecord(workspace, join(projectStateDir(workspace), 'sessions', `${sessionId}.json`))
    if (!value || typeof value !== 'object') return undefined
    const snapshot = value as Record<string, unknown>
    const messages = Array.isArray(snapshot.messages) ? snapshot.messages.filter(isMessage) : []
    const archived = Array.isArray(snapshot.archived_messages) ? snapshot.archived_messages.filter(isMessage) : []
    hydrateLegacySnapshot(snapshot, messages, archived)
    return {
      messages,
      revision: Number(snapshot.revision ?? 0),
      ...(snapshot.resources ? { resources: snapshot.resources as ResourceState } : {}),
      ...(snapshot.execution && typeof snapshot.execution === 'object' ? { execution: snapshot.execution as Record<string, unknown> } : {}),
      archived,
      progress: snapshot.progress,
      thinkingEffort: snapshot.thinking_effort,
      title: snapshot.title,
      lastUsage: snapshot.last_usage,
      turns: typeof snapshot.turns === 'number' ? snapshot.turns : 0
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}


function hydrateLegacySnapshot(snapshot: Record<string, unknown>, messages: Message[], archived: Message[]): void {
  const transcript = [...archived, ...conversationBody(messages)].filter(message => !message.friday_compaction_artifact)
  for (const [index, record] of legacyRecords(snapshot.artifacts, transcript)) {
    if (Array.isArray(record.items)) transcript[index]!.friday_artifacts = structuredClone(record.items)
  }
  for (const [index, record] of legacyRecords(snapshot.metrics, transcript)) {
    if (record.values && typeof record.values === 'object' && !Array.isArray(record.values)) {
      transcript[index]!.friday_metrics = structuredClone(record.values)
    }
  }
  for (const [index, record] of legacyRecords(snapshot.activities, transcript)) {
    if (Array.isArray(record.items)) transcript[index]!.friday_activities = structuredClone(record.items)
  }

  const records = Array.isArray(snapshot.user_message_times)
    ? snapshot.user_message_times.filter(value => value && typeof value === 'object' && !Array.isArray(value)) as Record<string, unknown>[]
    : []
  let recordIndex = records.length - 1
  for (let index = transcript.length - 1; index >= 0 && recordIndex >= 0; index -= 1) {
    const message = transcript[index]!
    if (message.role !== 'user' || message.friday_internal) continue
    const content = messageText(message.content)
    while (recordIndex >= 0) {
      const record = records[recordIndex--]!
      if (record.text !== content) continue
      if (typeof record.time === 'string') message.friday_timestamp = record.time
      if (typeof record.display_text === 'string') message.friday_display_text = record.display_text
      if (Array.isArray(record.attachments)) message.friday_attachments = structuredClone(record.attachments)
      if (record.goal === true) message.friday_goal = true
      break
    }
  }
}


function legacyRecords(value: unknown, messages: Message[]): Map<number, Record<string, unknown>> {
  const records = Array.isArray(value)
    ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) as Record<string, unknown>[]
    : []
  records.sort((left, right) => Number(left.message_index || 0) - Number(right.message_index || 0))
  const positions = new Map<string, number[]>()
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'assistant') continue
    const hash = messageFingerprint(message)
    positions.set(hash, [...positions.get(hash) ?? [], index])
  }
  const taken = new Map<string, number>()
  const found = new Map<number, Record<string, unknown>>()
  for (const record of records) {
    const hash = String(record.message_hash || '')
    const matches = positions.get(hash) ?? []
    const seen = taken.get(hash) ?? 0
    if (seen >= matches.length) continue
    taken.set(hash, seen + 1)
    found.set(matches[seen]!, record)
  }
  return found
}


function messageFingerprint(message: Message): string {
  return createHash('sha256').update(pythonJson(message.content)).digest('hex').slice(0, 20)
}


function pythonJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(', ')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}: ${pythonJson((value as Record<string, unknown>)[key])}`).join(', ')}}`
  }
  return JSON.stringify(String(value))
}


export async function readObject(path: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}


function isMessage(value: unknown): value is Message {
  return !!value && typeof value === 'object' && ['system', 'user', 'assistant', 'tool'].includes(String((value as Message).role))
}


export function conversationBody(messages: Message[]): Message[] {
  let start = 0
  while (messages[start]?.role === 'system') start += 1
  return messages.slice(start).filter(message =>
    (!message.friday_progress || message.friday_goal_draft) && !message.friday_memory_recall
  )
}


export function persistedMessages(messages: readonly Message[]): Message[] {
  return messages.map(message => message.friday_goal_draft
    ? { ...structuredClone(message), friday_progress: true }
    : structuredClone(message))
}


export function legacySnapshotMetadata(messages: readonly Message[]): Record<string, unknown> {
  return {
    artifacts: legacyMessageRecords(messages, 'friday_artifacts', 'items', Array.isArray),
    metrics: legacyMessageRecords(
      messages,
      'friday_metrics',
      'values',
      value => !!value && typeof value === 'object' && !Array.isArray(value)
    ),
    activities: legacyMessageRecords(messages, 'friday_activities', 'items', Array.isArray),
    user_message_times: messages.flatMap(message => {
      if (message.role !== 'user' || message.friday_internal || typeof message.friday_timestamp !== 'string') return []
      return [{
        text: messageText(message.content),
        display_text: typeof message.friday_display_text === 'string'
          ? message.friday_display_text
          : messageText(message.content),
        goal: message.friday_goal === true,
        time: message.friday_timestamp,
        attachments: Array.isArray(message.friday_attachments) ? structuredClone(message.friday_attachments) : []
      }]
    })
  }
}


function legacyMessageRecords(
  messages: readonly Message[],
  field: string,
  payload: string,
  valid: (value: unknown) => boolean
): Record<string, unknown>[] {
  return messages.flatMap((message, messageIndex) => {
    const value = message[field]
    if (message.role !== 'assistant' || message.friday_goal_draft || !valid(value)) return []
    return [{
      message_index: messageIndex,
      message_hash: messageFingerprint(message),
      [payload]: structuredClone(value)
    }]
  })
}


export function newSessionId(): string {
  return `${localTimestamp(true).replace(/[-:T.]/g, '')}-${randomUUID().slice(0, 8)}`
}


export function sessionPath(workspace: string, sessionId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error(`Invalid session id: ${sessionId}`)
  return join(projectStateDir(resolve(workspace)), 'sessions', `${sessionId}.json`)
}


export function messageText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return value == null ? '' : String(value)
  return value.flatMap(part => part && typeof part === 'object' && (part as { type?: unknown }).type === 'text'
    ? [String((part as { text?: unknown }).text ?? '')]
    : []).join('\n')
}


function messageImages(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(part => {
    if (!part || typeof part !== 'object') return []
    const item = part as { type?: unknown; image_url?: { url?: unknown } }
    return item.type === 'image_url' && typeof item.image_url?.url === 'string' ? [item.image_url.url] : []
  })
}


function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {}
  try { return JSON.parse(value) as unknown } catch { return value }
}
