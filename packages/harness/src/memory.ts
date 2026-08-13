import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { fridayHome, projectStateDir } from './config.js'
import { writeTextAtomic } from './storage.js'

export const MEMORY_SCOPES = ['user', 'global', 'project', 'episode'] as const
export type MemoryScope = typeof MEMORY_SCOPES[number]

export type MemoryRecord = {
  id: string
  scope: MemoryScope
  content: string
  path: string
  source: string
  count: number
  [key: string]: unknown
}

type StoredRecord = MemoryRecord & {
  metadata: Record<string, unknown>
  line: number
  metaLine?: number
}

const LIMITS: Record<Exclude<MemoryScope, 'episode'>, number> = { user: 1_500, global: 2_500, project: 2_500 }
const ENTRY_LIMIT = 2_000
const META = /^<!-- friday-memory (\{.*\}) -->$/
const SECRET = /(?:api[_ -]?key|password|passwd|secret|access[_ -]?token)\s*[:=]\s*\S+|\b(?:sk-|hf_|tvly-|as_sk_)[A-Za-z0-9_-]{8,}/i
const CAPTURE = /记住|以后|今后|别再|不要再|我(?:更)?(?:喜欢|偏好|倾向|习惯)|我不喜欢|我叫|我的名字是|纠正一下|不是.{0,80}而是|\bremember\b|from now on|\bi (?:prefer|like|dislike|usually|tend)\b|my name is|don't do that again|do not do that again/i
const PERMANENT = /(?:永远|始终)(?:记住|记得|不要忘记)|永久(?:记住|保存)|\balways remember\b|\bremember (?:this|that|it|me) forever\b|\bnever forget\b/i
const PROJECT = /这个项目|当前项目|本项目|这个仓库|当前仓库|这个分支|\bthis (?:project|repository|repo|branch|workspace)\b|\bcurrent (?:project|repository|repo|branch|workspace)\b/i
const USER = /我(?:更)?(?:喜欢|不喜欢|偏好|倾向|习惯)|我叫|我的名字是|记住我的|(?:默认|请).{0,30}(?:中文|英文).{0,20}(?:回答|回复|交流)|我是.{0,30}(?:开发者|工程师|学生|研究员|作者|产品经理|设计师)|\bi (?:prefer|like|dislike|usually|tend)\b|my name is|\bi am (?:an? )?(?:developer|engineer|student|researcher|writer|designer)\b/i

let memoryWriteTail = Promise.resolve()

export async function memoryStatus(workspace: string): Promise<Record<string, unknown>> {
  const paths = await scopePaths(workspace)
  const memories = await listMemories(workspace)
  const counts = Object.fromEntries(MEMORY_SCOPES.map(scope => [scope, memories.filter(item => item.scope === scope).length]))
  const chars = Object.fromEntries(await Promise.all(MEMORY_SCOPES.map(async scope => [
    scope,
    (await Promise.all(paths[scope].map(readOrEmpty))).reduce((sum, content) => sum + content.length, 0)
  ])))
  return { counts, chars, paths }
}

export async function listMemories(workspace: string, scope: MemoryScope | 'all' = 'all'): Promise<MemoryRecord[]> {
  if (scope !== 'all' && !isScope(scope)) throw new Error(`Unknown memory scope: ${scope}`)
  const paths = await scopePaths(workspace)
  const scopes = scope === 'all' ? MEMORY_SCOPES : [scope]
  const records = await Promise.all(scopes.flatMap(current => paths[current].map(async path => parseEntries(
    await readOrEmpty(path), path, current
  ))))
  return records.flat().map(publicRecord)
}

export async function addMemory(
  workspace: string,
  scope: MemoryScope,
  content: string,
  options: { source?: string; sessionId?: string; date?: Date; count?: number } = {}
): Promise<MemoryRecord> {
  const text = clean(content)
  validateEntry(scope, text)
  return withMemoryWrite(async () => {
    const existing = await storedMemories(workspace, scope)
    const duplicate = existing.find(item => normalize(item.content) === normalize(text))
    if (duplicate) {
      if (scope !== 'episode') return { ...publicRecord(duplicate), duplicate: true }
      const date = options.date ?? new Date()
      const metadata = {
        ...duplicate.metadata,
        count: duplicate.count + positive(options.count, 1),
        last_seen: timestamp(date),
        ...(options.sessionId ? { last_session: options.sessionId } : {}),
        workspaces: [...new Set([
          ...strings(duplicate.metadata.workspaces),
          resolve(workspace)
        ])].sort()
      }
      await replaceRecord(duplicate, [`- ${duplicate.content}`, metadataLine(metadata)])
      return { ...publicRecord({ ...duplicate, metadata, count: Number(metadata.count) }), duplicate: true }
    }

    const date = options.date ?? new Date()
    const { path, limit } = await writeTarget(workspace, scope, date)
    const id = memoryId(scope, text)
    const metadata: Record<string, unknown> = {
      id,
      source: options.source || 'cli',
      created: timestamp(date),
      ...(options.sessionId ? { session: options.sessionId } : {})
    }
    if (scope === 'episode') {
      metadata.count = positive(options.count, 1)
      metadata.workspaces = [resolve(workspace)]
    }
    const current = await readOrEmpty(path) || header(scope, date)
    const updated = `${current.trimEnd()}\n\n- ${text}\n${metadataLine(metadata)}\n`
    if (limit !== undefined && updated.length > limit) {
      throw new Error(`${scope} memory would exceed ${limit} characters; update or remove old entries first.`)
    }
    await writeTextAtomic(path, updated)
    return { id, scope, content: text, path, source: String(metadata.source), count: positive(metadata.count, 1) }
  })
}

export async function updateMemory(workspace: string, id: string, content: string): Promise<MemoryRecord> {
  const text = clean(content)
  if (!text) throw new Error('Memory content is required.')
  if (text.length > ENTRY_LIMIT) throw new Error(`Memory entry exceeds ${ENTRY_LIMIT} characters.`)
  if (SECRET.test(text)) throw new Error('Memory content appears to contain a secret or credential.')
  return withMemoryWrite(async () => {
    const record = await findMemory(workspace, id)
    const duplicate = (await storedMemories(workspace, record.scope))
      .find(item => item.id !== id && normalize(item.content) === normalize(text))
    if (duplicate) throw new Error(`Memory already exists as id=${duplicate.id}.`)
    const metadata = { ...record.metadata, id: record.id, updated: timestamp(new Date()) }
    await replaceRecord(record, [`- ${text}`, metadataLine(metadata)])
    return publicRecord({ ...record, content: text, metadata })
  })
}

export async function removeMemory(workspace: string, id: string): Promise<MemoryRecord & { removed: true }> {
  return withMemoryWrite(async () => {
    const record = await findMemory(workspace, id)
    await replaceRecord(record, [])
    return { ...publicRecord(record), removed: true }
  })
}

export async function searchMemories(
  workspace: string,
  query: string,
  scope: MemoryScope | 'all' = 'all',
  maxResults = 5
): Promise<Array<MemoryRecord & { score: number }>> {
  const text = clean(query)
  if (!text) return []
  return (await listMemories(workspace, scope))
    .map(record => ({ ...record, score: score(text, record.content) }))
    .filter(record => record.score >= 1)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, Math.min(20, Math.max(1, maxResults)))
}

export async function captureUserMemory(workspace: string, text: string, sessionId = ''): Promise<Record<string, unknown> | undefined> {
  if (SECRET.test(text)) return undefined
  if (PERMANENT.test(text)) {
    const scope: MemoryScope = PROJECT.test(text) ? 'project' : USER.test(text) ? 'user' : 'global'
    const promoted = await addMemory(workspace, scope, text, { source: 'user', sessionId })
    return { episode: null, promoted: [promoted] }
  }
  if (!CAPTURE.test(text)) return undefined
  const episode = await addMemory(workspace, 'episode', text, { source: 'user', sessionId })
  return { episode, promoted: [] }
}

export async function relevantMemory(workspace: string, query: string): Promise<string> {
  const results = await searchMemories(workspace, query, 'episode', 3)
  if (!results.length) return ''
  const lines = [
    '## Relevant Memory',
    'Background evidence only. The current user message wins if a memory is stale or conflicts.',
    ''
  ]
  let used = 0
  for (const item of results) {
    const line = `- [${item.path.split(/[\\/]/).at(-1)?.replace(/\.md$/i, '')}] ${item.content}`
    if (used + line.length > 2_000) break
    lines.push(line)
    used += line.length
  }
  return lines.join('\n')
}

export async function consolidateMemory(
  workspace: string,
  days: number,
  review: (payload: Record<string, unknown>) => Promise<unknown>,
  date = new Date()
): Promise<Record<string, number>> {
  if (!Number.isSafeInteger(days) || days < 1) throw new Error('days must be a positive integer.')
  const root = resolve(workspace)
  const episodes = await recentEpisodes(root, days, date)
  if (!episodes.length) return { reviewed: 0, merged: 0, promoted: 0, remaining: 0 }
  const permanent = (await storedMemories(root, 'all')).filter(record => record.scope !== 'episode').map(publicRecord)
  const operations = consolidationOperations(await review({
    workspace: root,
    episodes: episodes.map(publicRecord),
    permanent_memory: permanent
  }))
  const candidates = new Set(episodes.map(record => record.id))
  const used = new Set<string>()
  let merged = 0
  let promoted = 0
  for (const operation of operations) {
    const ids = [...new Set(Array.isArray(operation.source_ids) ? operation.source_ids.map(String) : [])]
      .filter(id => candidates.has(id) && !used.has(id))
    const records = (await Promise.all(ids.map(async id => {
      try { return await findMemory(root, id) } catch { return undefined }
    }))).filter((record): record is StoredRecord => record?.scope === 'episode')
    const content = clean(String(operation.content || ''))
    if (!records.length || !content || content.length > ENTRY_LIMIT || SECRET.test(content)) continue
    const count = records.reduce((sum, record) => sum + record.count, 0)
    const action = String(operation.action || '').toLowerCase()
    if (action === 'promote') {
      const scope = String(operation.scope || '').toLowerCase()
      if (count < 2 || !['user', 'global', 'project'].includes(scope)) continue
      if (scope === 'project' && records.some(record => !sameWorkspaceOnly(record, root))) continue
      try { await addMemory(root, scope as Exclude<MemoryScope, 'episode'>, content, { source: 'consolidation', date }) } catch { continue }
      await removeRecords(records)
      promoted += 1
    } else if (action === 'merge' && (records.length > 1 || normalize(records[0]!.content) !== normalize(content))) {
      const selected = new Set(records.map(record => record.id))
      const collision = (await storedMemories(root, 'episode'))
        .some(record => !selected.has(record.id) && normalize(record.content) === normalize(content))
      if (collision) continue
      await mergeEpisodeRecords(records, content, count, date)
      merged += 1
    } else continue
    records.forEach(record => used.add(record.id))
  }
  return {
    reviewed: episodes.length,
    merged,
    promoted,
    remaining: (await recentEpisodes(root, days, date)).length
  }
}

export async function runMemoryCommand(
  command: string,
  workspace: string,
  options: { consolidate?: (days: number) => Promise<Record<string, unknown>> } = {}
): Promise<Record<string, unknown> | string> {
  const words = command.trim().split(/\s+/).filter(Boolean)
  if (!words.length || ['help', '--help', '-h'].includes(words[0]!)) return memoryHelp()
  const action = words[0]!.toLowerCase()
  if (action === 'status') return memoryStatus(workspace)
  if (action === 'list') return { memories: await listMemories(workspace, parseScope(words[1] || 'all', true)) }
  if (action === 'search') return { memories: await searchMemories(workspace, words.slice(1).join(' ')) }
  if (action === 'add' && words.length >= 3) return addMemory(workspace, parseScope(words[1]!), words.slice(2).join(' '))
  if (action === 'update' && words.length >= 3) return updateMemory(workspace, words[1]!, words.slice(2).join(' '))
  if (action === 'remove' && words.length === 2) return removeMemory(workspace, words[1]!)
  if (action === 'consolidate') {
    const index = words.indexOf('--days')
    if (index >= 0 && !/^\d+$/.test(words[index + 1] || '')) throw new Error('--days requires a positive integer.')
    const days = index < 0 ? 2 : Number(words[index + 1])
    if (!options.consolidate) throw new Error('Memory consolidation requires a model-backed Friday session.')
    return options.consolidate(days)
  }
  throw new Error(memoryHelp())
}

export function formatMemoryResult(value: Record<string, unknown> | string): string {
  if (typeof value === 'string') return value
  if (isObject(value.counts) && isObject(value.chars)) {
    const lines = ['# Memory status', '', '| Scope | Entries | Characters |', '| --- | ---: | ---: |']
    for (const scope of MEMORY_SCOPES) lines.push(`| ${scope} | ${String(value.counts[scope] ?? 0)} | ${String(value.chars[scope] ?? 0)} |`)
    return lines.join('\n')
  }
  if (Array.isArray(value.memories)) {
    if (!value.memories.length) return 'No matching memory.'
    return ['# Memories', '', ...value.memories.map(item => {
      const record = item as MemoryRecord
      return `- \`${record.id}\` [${record.scope}]${record.count > 1 ? ` x${record.count}` : ''} ${record.content}`
    })].join('\n')
  }
  if (typeof value.reviewed === 'number') {
    return `Consolidated ${value.reviewed} episodic notes: ${String(value.merged ?? 0)} merged, ${String(value.promoted ?? 0)} promoted, ${String(value.remaining ?? 0)} remaining.`
  }
  if (value.removed === true) return `Removed memory \`${String(value.id)}\`: ${String(value.content)}`
  if (value.id) return `Saved memory \`${String(value.id)}\` [${String(value.scope)}]${value.duplicate ? ' (already present)' : ''}: ${String(value.content)}`
  return JSON.stringify(value, null, 2)
}

function memoryHelp(): string {
  return `Memory commands:
  status                         Show memory counts, sizes, and files.
  list [user|global|project|episode|all]
  search <query>                 Search Markdown memory.
  add <scope> <text>             Store one durable fact or episode.
  update <id> <text>             Replace an existing entry.
  remove <id>                    Forget an entry.
  consolidate [--days N]         Merge and promote recent episodes with one model review.

Current task progress is not memory.`
}

async function recentEpisodes(workspace: string, days: number, date: Date): Promise<StoredRecord[]> {
  const cutoff = new Date(date.getFullYear(), date.getMonth(), date.getDate() - days + 1)
  const minimum = localDate(cutoff)
  return (await storedMemories(workspace, 'episode')).filter(record => {
    const observed = String(record.metadata.last_seen || record.metadata.created || record.path.split(/[\\/]/).at(-1) || '').slice(0, 10)
    return /^\d{4}-\d{2}-\d{2}$/.test(observed) && observed >= minimum
  })
}

function consolidationOperations(value: unknown): Record<string, unknown>[] {
  if (!isObject(value) || !Array.isArray(value.operations)) throw new Error('Memory consolidation model did not return an operations list.')
  return value.operations.filter(isObject)
}

function sameWorkspaceOnly(record: StoredRecord, workspace: string): boolean {
  const values = strings(record.metadata.workspaces)
  if (!values.length && record.metadata.workspace) values.push(String(record.metadata.workspace))
  const roots = new Set(values.map(value => resolve(value)))
  return roots.size === 1 && roots.has(resolve(workspace))
}

async function mergeEpisodeRecords(records: StoredRecord[], content: string, count: number, date: Date): Promise<void> {
  const [primary, ...rest] = records
  if (!primary) return
  const workspaces = [...new Set(records.flatMap(record => {
    const values = strings(record.metadata.workspaces)
    return values.length ? values : record.metadata.workspace ? [String(record.metadata.workspace)] : []
  }).map(value => resolve(value)))].sort()
  const metadata = {
    ...primary.metadata,
    id: memoryId('episode', content),
    count: Math.max(1, count),
    consolidated: timestamp(date),
    workspaces
  }
  await withMemoryWrite(async () => {
    await replaceRecord(primary, [`- ${content}`, metadataLine(metadata)])
    await removeRecordsUnlocked(rest)
  })
}

async function removeRecords(records: StoredRecord[]): Promise<void> {
  await withMemoryWrite(() => removeRecordsUnlocked(records))
}

async function removeRecordsUnlocked(records: StoredRecord[]): Promise<void> {
  const paths = new Map<string, StoredRecord[]>()
  for (const record of records) paths.set(record.path, [...paths.get(record.path) ?? [], record])
  for (const group of paths.values()) {
    for (const record of group.sort((left, right) => right.line - left.line)) await replaceRecord(record, [])
  }
}

async function scopePaths(workspace: string): Promise<Record<MemoryScope, string[]>> {
  const home = fridayHome()
  const episodes = join(home, 'memory')
  let episodeNames: string[] = []
  try { episodeNames = (await readdir(episodes)).filter(name => name.endsWith('.md')).sort() } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const project = [join(projectStateDir(workspace), 'MEMORY.md')]
  const legacy = join(resolve(workspace), '.friday', 'MEMORY.md')
  if (existsSync(legacy)) project.push(legacy)
  return {
    user: [join(home, 'USER.md')],
    global: [join(home, 'MEMORY.md')],
    project,
    episode: episodeNames.map(name => join(episodes, name))
  }
}

async function writeTarget(workspace: string, scope: MemoryScope, date: Date): Promise<{ path: string; limit?: number }> {
  if (scope === 'episode') return { path: join(fridayHome(), 'memory', `${localDate(date)}.md`) }
  const paths = await scopePaths(workspace)
  return { path: paths[scope][0]!, limit: LIMITS[scope] }
}

async function storedMemories(workspace: string, scope: MemoryScope | 'all'): Promise<StoredRecord[]> {
  const paths = await scopePaths(workspace)
  const scopes = scope === 'all' ? MEMORY_SCOPES : [scope]
  return (await Promise.all(scopes.flatMap(current => paths[current].map(async path => parseEntries(
    await readOrEmpty(path), path, current
  ))))).flat()
}

function parseEntries(source: string, path: string, scope: MemoryScope): StoredRecord[] {
  const lines = source.split(/\r?\n/)
  const records: StoredRecord[] = []
  for (let line = 0; line < lines.length; line += 1) {
    if (!lines[line]!.startsWith('- ')) continue
    const content = lines[line]!.slice(2).trim()
    let metadata: Record<string, unknown> = {}
    let metaLine: number | undefined
    const match = META.exec(lines[line + 1]?.trim() || '')
    if (match) {
      try {
        const value: unknown = JSON.parse(match[1]!)
        if (isObject(value)) metadata = value
        metaLine = line + 1
      } catch {}
    }
    records.push({
      id: typeof metadata.id === 'string' && metadata.id ? metadata.id : memoryId(scope, content),
      scope,
      content,
      path,
      source: typeof metadata.source === 'string' ? metadata.source : 'manual',
      count: positive(metadata.count, 1),
      metadata,
      line,
      ...(metaLine === undefined ? {} : { metaLine })
    })
  }
  return records
}

async function findMemory(workspace: string, id: string): Promise<StoredRecord> {
  const matches = (await storedMemories(workspace, 'all')).filter(item => item.id === id)
  if (matches.length !== 1) throw new Error(`Expected one memory id=${id}, found ${matches.length}.`)
  return matches[0]!
}

async function replaceRecord(record: StoredRecord, replacement: string[]): Promise<void> {
  const source = await readFile(record.path, 'utf8')
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = source.split(/\r?\n/)
  if (lines[record.line]?.slice(2).trim() !== record.content || !lines[record.line]?.startsWith('- ')) {
    throw new Error(`Memory id=${record.id} moved on disk; retry the operation.`)
  }
  const end = record.metaLine === undefined ? record.line + 1 : record.metaLine + 1
  lines.splice(record.line, end - record.line, ...replacement)
  await writeTextAtomic(record.path, `${lines.join(newline).trimEnd()}${newline}`)
}

function publicRecord(record: StoredRecord): MemoryRecord {
  const result: MemoryRecord = {
    id: record.id,
    scope: record.scope,
    content: record.content,
    path: record.path,
    source: record.source,
    count: positive(record.metadata.count, record.count)
  }
  for (const key of ['created', 'updated', 'session', 'last_seen', 'last_session', 'workspace', 'workspaces']) {
    if (record.metadata[key]) result[key] = record.metadata[key]
  }
  return result
}

function validateEntry(scope: MemoryScope, text: string): void {
  if (!isScope(scope)) throw new Error(`Unknown memory scope: ${String(scope)}`)
  if (!text) throw new Error('Memory content is required.')
  if (text.length > ENTRY_LIMIT) throw new Error(`Memory entry exceeds ${ENTRY_LIMIT} characters.`)
  if (SECRET.test(text)) throw new Error('Memory content appears to contain a secret or credential.')
}

function score(query: string, content: string): number {
  const normalizedQuery = normalize(query)
  const exact = normalizedQuery.length >= 2 && normalize(content).includes(normalizedQuery) ? 4 : 0
  const queryTerms = terms(query)
  if (!queryTerms.size) return exact
  const contentTerms = terms(content)
  let overlap = 0
  for (const term of queryTerms) if (contentTerms.has(term)) overlap += 1
  return Math.round((exact + 4 * overlap / queryTerms.size) * 1_000) / 1_000
}

function terms(value: string): Set<string> {
  const lowered = value.toLowerCase()
  const result = new Set((lowered.match(/[a-z0-9_+#.-]{2,}/g) || []).filter(word => !['the', 'and', 'for', 'with'].includes(word)))
  for (const chunk of lowered.match(/[\u3400-\u9fff]+/g) || []) {
    for (let index = 0; index < chunk.length - 1; index += 1) result.add(chunk.slice(index, index + 2))
  }
  return result
}

function memoryId(scope: MemoryScope, content: string): string {
  return createHash('sha256').update(`${scope}\0${content}`).digest('hex').slice(0, 12)
}

function metadataLine(metadata: Record<string, unknown>): string {
  return `<!-- friday-memory ${JSON.stringify(metadata)} -->`
}

function header(scope: MemoryScope, date: Date): string {
  if (scope === 'user') return '# User Profile\n'
  if (scope === 'global') return '# User Memory\n'
  if (scope === 'project') return '# Project Memory\n'
  return `# ${localDate(date)}\n`
}

function parseScope(value: string): MemoryScope
function parseScope(value: string, all: true): MemoryScope | 'all'
function parseScope(value: string, all = false): MemoryScope | 'all' {
  if (all && value === 'all') return 'all'
  if (isScope(value)) return value
  throw new Error(`Unknown memory scope: ${value}`)
}

function isScope(value: unknown): value is MemoryScope {
  return MEMORY_SCOPES.includes(value as MemoryScope)
}

function clean(value: string): string {
  return String(value).trim().split(/\s+/).join(' ')
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, '')
}

function positive(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : fallback
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : []
}

function timestamp(date: Date): string {
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()].map(value => String(value).padStart(2, '0')).join(':')
  return `${localDate(date)}T${time}`
}

function localDate(date: Date): string {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((value, index) => index ? String(value).padStart(2, '0') : String(value))
    .join('-')
}

async function readOrEmpty(path: string): Promise<string> {
  try { return await readFile(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

async function withMemoryWrite<T>(work: () => Promise<T>): Promise<T> {
  const previous = memoryWriteTail
  let release = () => {}
  memoryWriteTail = new Promise<void>(resolveTail => { release = resolveTail })
  await previous
  try { return await work() } finally { release() }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
