import { createHash } from 'node:crypto'
import { access, readFile, readdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Message } from 'friday-agent-core'
import { projectStateDir } from './config.js'
import { withStateLock, writeJsonAtomic } from './storage.js'

type Pages = { format: 'friday.messages.v1'; count: number; pages: string[] }
const FIELDS = ['messages', 'archived_messages', 'before_messages', 'before_archived'] as const
const PAGE_SIZE = 32

/** Immutable content-addressed pages are shared by sessions, forks and checkpoints. */
export async function writeRecord(workspace: string, path: string, value: Record<string, unknown>): Promise<void> {
  await withStateLock(join(projectStateDir(workspace), 'record-store'), async () => {
    const stored = { ...value }
    for (const field of FIELDS) {
      if (!Array.isArray(value[field])) continue
      const messages = value[field] as Message[]
      const pages: string[] = []
      for (let offset = 0; offset < messages.length; offset += PAGE_SIZE) {
        const page = messages.slice(offset, offset + PAGE_SIZE)
        const id = createHash('sha256').update(JSON.stringify(page)).digest('hex')
        const target = objectPath(workspace, id)
        try { await access(target) } catch { await writeJsonAtomic(target, page, true) }
        pages.push(id)
      }
      stored[field] = { format: 'friday.messages.v1', count: messages.length, pages } satisfies Pages
    }
    await writeJsonAtomic(path, stored, true)
    if ('messages' in value && value.session_id) await cacheSummary(path, stored).catch(() => {})
  })
}

export async function readRecord(workspace: string, path: string): Promise<Record<string, unknown>> {
  const record = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  for (const field of FIELDS) if (isPages(record[field])) record[field] = await readMessagePage(workspace, record[field], 0, record[field].count)
  return record
}

/** Reads only pages intersecting a requested transcript range. Legacy arrays remain readable. */
export async function readMessagePage(workspace: string, value: unknown, offset = 0, limit = 100): Promise<Message[]> {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid message page range.')
  if (Array.isArray(value)) return value.slice(offset, offset + limit) as Message[]
  if (!isPages(value)) throw new Error('Invalid message page reference.')
  const first = Math.floor(offset / PAGE_SIZE)
  const pages = value.pages.slice(first, Math.ceil(Math.min(value.count, offset + limit) / PAGE_SIZE))
  const messages: Message[] = []
  for (const id of pages) {
    const page = JSON.parse(await readFile(objectPath(workspace, id), 'utf8')) as Message[]
    if (!Array.isArray(page) || createHash('sha256').update(JSON.stringify(page)).digest('hex') !== id) throw new Error(`Corrupt message page: ${id}`)
    messages.push(...page)
  }
  return messages.slice(offset % PAGE_SIZE, offset % PAGE_SIZE + limit)
}

function isPages(value: unknown): value is Pages {
  if (!value || typeof value !== 'object') return false
  const item = value as Pages
  return item.format === 'friday.messages.v1' && Array.isArray(item.pages) && Number.isSafeInteger(item.count) && item.count >= 0
}

/** Indexes are disposable; changed legacy files and manual renames rebuild their entries. */
export async function recordSummary(path: string): Promise<Record<string, unknown>> {
  const modified = (await stat(path)).mtimeMs
  try {
    const cached = JSON.parse(await readFile(indexPath(path), 'utf8')) as { modified: number; record: Record<string, unknown> }
    if (cached.modified === modified) return cached.record
  } catch {}
  const record = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  if ((await stat(path)).mtimeMs !== modified) return recordSummary(path)
  return cacheSummary(path, record, modified)
}
async function cacheSummary(path: string, value: Record<string, unknown>, modified = 0): Promise<Record<string, unknown>> {
  const fields = new Set<string>([...FIELDS, 'metrics', 'activities', 'artifacts', 'user_message_times'])
  const record = Object.fromEntries(Object.entries(value).filter(([key]) => !fields.has(key)))
  await writeJsonAtomic(indexPath(path), { modified: modified || (await stat(path)).mtimeMs, record }, true)
  return record
}
function indexPath(path: string): string { return join(dirname(path), 'index', basename(path)) }

/** Explicit GC under the same lock as page publication. Corrupt manifests stop collection. */
export async function collectMessageObjects(workspace: string): Promise<{ removed: number }> {
  const root = projectStateDir(workspace)
  return withStateLock(join(root, 'record-store'), async () => {
    const referenced = new Set<string>()
    for (const directory of [join(root, 'sessions'), join(root, 'checkpoints-ts', 'entries')]) {
      for (const name of await jsonNames(directory)) {
        const record = JSON.parse(await readFile(join(directory, name), 'utf8')) as Record<string, unknown>
        for (const field of FIELDS) if (isPages(record[field])) for (const id of record[field].pages) referenced.add(id)
      }
    }
    let removed = 0
    const directory = join(root, 'message-objects')
    for (const name of await jsonNames(directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name) || referenced.has(name.slice(0, -5))) continue
      await rm(join(directory, name), { force: true })
      removed++
    }
    return { removed }
  })
}
async function jsonNames(directory: string): Promise<string[]> {
  try { return (await readdir(directory)).filter(name => name.endsWith('.json')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
}
function objectPath(workspace: string, id: string): string {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid message page id.')
  return join(projectStateDir(workspace), 'message-objects', `${id}.json`)
}
