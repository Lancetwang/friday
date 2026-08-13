import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

import type { Message } from 'friday-agent-core'
import ignore, { type Ignore } from 'ignore'

import { projectStateDir } from './config.js'
import { writeJsonAtomic, writeTextAtomic } from './storage.js'
import { localTimestamp } from './time.js'

const exec = promisify(execFile)
const ACTIVE = new Set(['pending', 'ready'])
const MAX_CHECKPOINTS = 50
const FILE_TREE = 'files:'
const readyRepos = new Map<string, Promise<void>>()

type FileEntry = { path: string; type: 'file' | 'symlink'; hash: string; mode: number; target?: string }
type FileTree = { schema_version: 1; entries: FileEntry[] }

export type Checkpoint = {
  schema_version: 1
  id: string
  workspace: string
  session_id: string
  created: string
  updated?: string
  user: string
  state: 'pending' | 'ready' | 'undone'
  before_tree: string
  after_tree: string
  before_messages: Message[]
  before_archived: Message[]
  before_progress: Record<string, unknown>
  before_turns: number
  before_thinking_effort: string
  changed_paths?: string[]
}

export async function beginCheckpoint(options: {
  workspace: string
  sessionId: string
  user: string
  messages: Message[]
  archived?: Message[]
  progress?: Record<string, unknown>
  turns?: number
  thinkingEffort?: string
  continuation?: boolean
}): Promise<string> {
  const root = resolve(options.workspace)
  if (options.continuation) {
    const pending = (await entries(root)).findLast(entry => entry.state === 'pending' && entry.session_id === options.sessionId)
    if (pending) return pending.id
  }
  const created = now()
  const id = `${created.replace(/[-:T.]/g, '')}-${randomUUID().slice(0, 8)}`
  const entry: Checkpoint = {
    schema_version: 1,
    id,
    workspace: root,
    session_id: options.sessionId,
    created,
    user: options.user,
    state: 'pending',
    before_tree: await snapshot(root),
    after_tree: '',
    before_messages: structuredClone(options.messages),
    before_archived: structuredClone(options.archived ?? []),
    before_progress: structuredClone(options.progress ?? {}),
    before_turns: options.turns ?? 0,
    before_thinking_effort: options.thinkingEffort ?? ''
  }
  await writeEntry(root, entry)
  return id
}

export async function finishCheckpoint(workspace: string, id: string, pending: boolean): Promise<Checkpoint> {
  const root = resolve(workspace)
  const entry = await readEntry(root, id)
  entry.state = pending ? 'pending' : 'ready'
  entry.after_tree = await snapshot(root, entry.before_tree)
  entry.changed_paths = await diffPaths(root, entry.before_tree, entry.after_tree)
  entry.updated = now()
  await writeEntry(root, entry)
  await prune(root)
  return entry
}

export async function checkpointChoices(workspace: string, limit = 50): Promise<Record<string, unknown>[]> {
  const values = (await entries(resolve(workspace))).filter(entry => ACTIVE.has(entry.state)).reverse().slice(0, Math.max(1, limit))
  return values.map(entry => ({
    id: entry.id,
    created: entry.created,
    session_id: entry.session_id,
    state: entry.state,
    user: entry.user.slice(0, 140)
  }))
}

export async function restoreCheckpoint(
  workspace: string,
  requestedId?: string,
  force = false
): Promise<Checkpoint & { changed_paths: string[] }> {
  const root = resolve(workspace)
  const active = (await entries(root)).filter(entry => ACTIVE.has(entry.state))
  const target = requestedId ? active.find(entry => entry.id === requestedId) : active.at(-1)
  if (!target) throw new Error(requestedId ? `Checkpoint not found: ${requestedId}` : 'No restorable Friday checkpoint.')
  const latest = active.at(-1) ?? target
  const expected = latest.after_tree || latest.before_tree
  const current = await snapshot(root, expected)
  const conflicts = await diffPaths(root, expected, current)
  if (conflicts.length && !force) {
    throw new Error(`Workspace changed after Friday's last checkpoint: ${conflicts.slice(0, 8).join(', ')}${conflicts.length > 8 ? ' ...' : ''}. Review those files or retry with --force.`)
  }
  const targetCurrent = sameBackend(target.before_tree, current) ? current : await snapshot(root, target.before_tree)
  const changed = await diffPaths(root, target.before_tree, targetCurrent)
  await restoreTree(root, target.before_tree)
  for (const entry of active) {
    if (entry.id < target.id) continue
    entry.state = 'undone'
    entry.updated = now()
    await writeEntry(root, entry)
  }
  await prune(root)
  return { ...target, changed_paths: changed }
}

export async function deleteSessionCheckpoints(workspace: string, sessionIds: readonly string[]): Promise<void> {
  const ids = new Set(sessionIds)
  const root = resolve(workspace)
  await removeEntries(root, (await entries(root)).filter(entry => ids.has(entry.session_id)))
}

async function snapshot(workspace: string, like = ''): Promise<string> {
  if (like.startsWith(FILE_TREE) || process.env.FRIDAY_CHECKPOINT_BACKEND === 'files') return fileSnapshot(workspace)
  if (like) return gitSnapshot(workspace)
  try {
    return await gitSnapshot(workspace)
  } catch (error) {
    if (!gitMissing(error)) throw error
    return fileSnapshot(workspace)
  }
}

async function gitSnapshot(workspace: string): Promise<string> {
  await ensureRepo(workspace)
  const index = temporaryIndex(workspace)
  const environment = gitEnvironment(workspace, index)
  try {
    await git(workspace, environment, ['add', '-A', '--', '.'])
    return (await git(workspace, environment, ['write-tree'])).trim()
  } finally {
    await rm(index, { force: true })
  }
}

async function restoreTree(workspace: string, tree: string): Promise<void> {
  if (tree.startsWith(FILE_TREE)) return restoreFileTree(workspace, tree)
  await ensureRepo(workspace)
  const index = temporaryIndex(workspace)
  const environment = gitEnvironment(workspace, index)
  try {
    await git(workspace, environment, ['read-tree', tree])
    const current = new Set(await worktreePaths(workspace))
    const target = new Set((await git(workspace, environment, ['ls-files', '-z'])).split('\0').filter(Boolean))
    for (const path of current) {
      if (target.has(path)) continue
      const absolute = workspacePath(workspace, path)
      await rm(absolute, { recursive: true, force: true })
    }
    for (const path of target) await removeBlockingDirectory(workspacePath(workspace, path), path)
    await git(workspace, environment, ['checkout-index', '-a', '-f'])
    const restored = await gitSnapshot(workspace)
    if (restored !== tree) throw new Error('Could not restore the checkpoint exactly.')
  } finally {
    await rm(index, { force: true })
  }
}

async function diffPaths(workspace: string, left: string, right: string): Promise<string[]> {
  if (left === right) return []
  if (left.startsWith(FILE_TREE) && right.startsWith(FILE_TREE)) return diffFileTrees(workspace, left, right)
  if (!sameBackend(left, right)) throw new Error('Checkpoint backends do not match.')
  const output = await git(workspace, gitEnvironment(workspace), ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', left, right])
  return output.split('\0').filter(Boolean).sort()
}

async function worktreePaths(workspace: string): Promise<string[]> {
  const output = await git(workspace, gitEnvironment(workspace), ['ls-files', '--others', '--cached', '--exclude-standard', '-z'])
  return [...new Set(output.split('\0').filter(path => path && !path.startsWith('.git/') && !path.startsWith('.friday/')))]
}

async function fileSnapshot(workspace: string): Promise<string> {
  const entries = await fileEntries(workspace)
  const tree = createHash('sha256').update(JSON.stringify(entries)).digest('hex')
  const path = fileTreePath(workspace, tree)
  if (!existsSync(path)) await writeJsonAtomic(path, { schema_version: 1, entries } satisfies FileTree)
  return `${FILE_TREE}${tree}`
}

async function fileEntries(workspace: string): Promise<FileEntry[]> {
  const root = resolve(workspace)
  const entries: FileEntry[] = []
  const rootRules = ignore().add(['.git/', '.friday/'])
  await walkFiles(root, '', [{ base: '', rules: rootRules }], entries)
  return entries.sort((left, right) => left.path.localeCompare(right.path))
}

async function walkFiles(
  root: string,
  directory: string,
  inherited: Array<{ base: string; rules: Ignore }>,
  output: FileEntry[]
): Promise<void> {
  const absolute = directory ? join(root, ...directory.split('/')) : root
  const local = await readOptional(join(absolute, '.gitignore'))
  const matchers = local === undefined ? inherited : [...inherited, { base: directory, rules: ignore().add(local) }]
  const names = await readdir(absolute, { withFileTypes: true })
  names.sort((left, right) => left.name.localeCompare(right.name))
  for (const item of names) {
    const path = directory ? `${directory}/${item.name}` : item.name
    if (ignoredPath(path, item.isDirectory(), matchers)) continue
    const target = join(root, ...path.split('/'))
    const status = await lstat(target)
    if (status.isDirectory()) {
      await walkFiles(root, path, matchers, output)
      continue
    }
    if (status.isSymbolicLink()) {
      const link = await readlink(target)
      output.push({ path, type: 'symlink', hash: textHash(link), mode: status.mode & 0o777, target: link })
      continue
    }
    if (!status.isFile()) continue
    const content = await readFile(target)
    const hash = createHash('sha256').update(content).digest('hex')
    await storeBlob(root, hash, content)
    output.push({ path, type: 'file', hash, mode: status.mode & 0o777 })
  }
}

function ignoredPath(path: string, directory: boolean, matchers: Array<{ base: string; rules: Ignore }>): boolean {
  let ignored = false
  for (const { base, rules } of matchers) {
    if (base && path !== base && !path.startsWith(`${base}/`)) continue
    const relativePath = base ? path.slice(base.length + 1) : path
    if (!relativePath) continue
    const result = rules.test(directory ? `${relativePath}/` : relativePath)
    if (result.ignored) ignored = true
    else if (result.unignored) ignored = false
  }
  return ignored
}

async function storeBlob(workspace: string, hash: string, content: Buffer): Promise<void> {
  const path = fileBlobPath(workspace, hash)
  if (existsSync(path)) return
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`
  await writeFile(temporary, content)
  try { await rename(temporary, path) } catch (error) {
    await rm(temporary, { force: true })
    if (!existsSync(path)) throw error
  }
}

async function restoreFileTree(workspace: string, id: string): Promise<void> {
  const target = await readFileTree(workspace, id)
  const currentId = await fileSnapshot(workspace)
  const current = await readFileTree(workspace, currentId)
  const wanted = new Map(target.entries.map(entry => [entry.path, entry]))
  for (const entry of [...current.entries].sort((left, right) => right.path.length - left.path.length)) {
    if (wanted.has(entry.path)) continue
    await rm(workspacePath(workspace, entry.path), { recursive: true, force: true })
  }
  for (const entry of target.entries) await restoreFileEntry(workspace, entry)
  const restored = await fileSnapshot(workspace)
  if (restored !== id) throw new Error('Could not restore the file checkpoint exactly.')
}

async function restoreFileEntry(workspace: string, entry: FileEntry): Promise<void> {
  const path = workspacePath(workspace, entry.path)
  await mkdir(dirname(path), { recursive: true })
  let status
  try { status = await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (entry.type === 'symlink') {
    if (status) await rm(path, { recursive: true, force: true })
    await symlink(entry.target ?? '', path)
    return
  }
  if (status?.isDirectory()) await removeBlockingDirectory(path, entry.path)
  else if (status?.isSymbolicLink()) await rm(path, { force: true })
  await copyFile(fileBlobPath(workspace, entry.hash), path)
  if (process.platform !== 'win32') await chmod(path, entry.mode)
}

async function diffFileTrees(workspace: string, left: string, right: string): Promise<string[]> {
  const [a, b] = await Promise.all([readFileTree(workspace, left), readFileTree(workspace, right)])
  const first = new Map(a.entries.map(entry => [entry.path, entrySignature(entry)]))
  const second = new Map(b.entries.map(entry => [entry.path, entrySignature(entry)]))
  return [...new Set([...first.keys(), ...second.keys()])]
    .filter(path => first.get(path) !== second.get(path))
    .sort()
}

async function readFileTree(workspace: string, id: string): Promise<FileTree> {
  const hash = id.startsWith(FILE_TREE) ? id.slice(FILE_TREE.length) : ''
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Invalid file checkpoint tree: ${id}`)
  try {
    const value: unknown = JSON.parse(await readFile(fileTreePath(workspace, hash), 'utf8'))
    if (validFileTree(value)) return value
  } catch {}
  throw new Error(`File checkpoint tree not found: ${id}`)
}

function validFileTree(value: unknown): value is FileTree {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const tree = value as Partial<FileTree>
  return tree.schema_version === 1 && Array.isArray(tree.entries) && tree.entries.every(entry => {
    if (!entry || typeof entry !== 'object') return false
    const item = entry as Partial<FileEntry>
    return typeof item.path === 'string' && (item.type === 'file' || item.type === 'symlink')
      && typeof item.hash === 'string' && typeof item.mode === 'number'
  })
}

function entrySignature(entry: FileEntry): string {
  return `${entry.type}\0${entry.hash}\0${entry.mode}\0${entry.target ?? ''}`
}

function sameBackend(left: string, right: string): boolean {
  return left.startsWith(FILE_TREE) === right.startsWith(FILE_TREE)
}

function gitMissing(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

async function readOptional(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function textHash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function fileTreePath(workspace: string, hash: string): string {
  return join(fileStoreDir(workspace), 'trees', `${hash}.json`)
}

function fileBlobPath(workspace: string, hash: string): string {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid checkpoint blob hash.')
  return join(fileStoreDir(workspace), 'objects', hash.slice(0, 2), hash.slice(2))
}

function fileStoreDir(workspace: string): string {
  return join(projectStateDir(resolve(workspace)), 'checkpoints-ts', 'files')
}

async function ensureRepo(workspace: string): Promise<void> {
  const directory = repoDir(workspace)
  const key = process.platform === 'win32' ? directory.toLowerCase() : directory
  const existing = readyRepos.get(key)
  if (existing) return existing
  const prepare = (async () => {
    if (![join(directory, 'HEAD'), join(directory, 'config'), join(directory, 'objects')].every(existsSync)) {
      await rm(directory, { recursive: true, force: true })
      await mkdir(directory, { recursive: true })
      await git(workspace, { GIT_DIR: directory }, ['init', '--bare', '--quiet'])
    }
    await writeTextAtomic(join(directory, 'info', 'exclude'), '/.git/\n/.friday/\n')
  })()
  readyRepos.set(key, prepare)
  try {
    await prepare
  } catch (error) {
    readyRepos.delete(key)
    throw error
  }
}

async function git(workspace: string, environment: Record<string, string>, args: string[]): Promise<string> {
  const result = await exec('git', args, {
    cwd: workspace,
    env: {
      ...process.env,
      ...environment,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.autocrlf',
      GIT_CONFIG_VALUE_0: 'false'
    },
    maxBuffer: 10_000_000,
    encoding: 'utf8'
  })
  return result.stdout
}

function gitEnvironment(workspace: string, index?: string): Record<string, string> {
  return {
    GIT_DIR: repoDir(workspace),
    GIT_WORK_TREE: resolve(workspace),
    ...(index ? { GIT_INDEX_FILE: index } : {})
  }
}

async function entries(workspace: string): Promise<Checkpoint[]> {
  let names: string[]
  try { names = await readdir(entriesDir(workspace)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const values = await Promise.all(names.filter(name => name.endsWith('.json')).sort().map(async name => {
    try {
      const value: unknown = JSON.parse(await readFile(join(entriesDir(workspace), name), 'utf8'))
      return validEntry(value) ? value : undefined
    } catch { return undefined }
  }))
  return values.filter((value): value is Checkpoint => !!value)
}

async function readEntry(workspace: string, id: string): Promise<Checkpoint> {
  validateId(id)
  try {
    const value: unknown = JSON.parse(await readFile(entryPath(workspace, id), 'utf8'))
    if (validEntry(value)) return value
  } catch {}
  throw new Error(`Checkpoint not found: ${id}`)
}

async function writeEntry(workspace: string, entry: Checkpoint): Promise<void> {
  await writeJsonAtomic(entryPath(workspace, entry.id), entry)
  await syncEntryRefs(workspace, entry)
}

async function prune(workspace: string): Promise<void> {
  const values = await entries(workspace)
  const active = values.filter(entry => ACTIVE.has(entry.state))
  const keep = new Set(active.slice(-MAX_CHECKPOINTS).map(entry => entry.id))
  await removeEntries(workspace, values.filter(entry =>
    entry.state === 'undone' || ACTIVE.has(entry.state) && !keep.has(entry.id)
  ))
}

async function removeEntries(workspace: string, removed: readonly Checkpoint[]): Promise<void> {
  if (!removed.length) return
  const removedIds = new Set(removed.map(entry => entry.id))
  const kept = (await entries(workspace)).filter(entry => !removedIds.has(entry.id))
  for (const entry of kept) await syncEntryRefs(workspace, entry)
  for (const entry of removed) {
    await rm(entryPath(workspace, entry.id), { force: true })
    await deleteEntryRefs(workspace, entry.id)
  }
  await pruneFileStore(workspace, kept)
  if (existsSync(repoDir(workspace))) {
    await git(workspace, gitEnvironment(workspace), ['gc', '--prune=now', '--quiet']).catch(() => {})
  }
}

async function syncEntryRefs(workspace: string, entry: Checkpoint): Promise<void> {
  for (const [name, tree] of [['before', entry.before_tree], ['after', entry.after_tree]] as const) {
    if (!tree || tree.startsWith(FILE_TREE)) continue
    await ensureRepo(workspace)
    await git(workspace, gitEnvironment(workspace), ['update-ref', `refs/friday/${entry.id}/${name}`, tree])
  }
}

async function deleteEntryRefs(workspace: string, id: string): Promise<void> {
  if (!existsSync(repoDir(workspace))) return
  for (const name of ['before', 'after']) {
    await git(workspace, gitEnvironment(workspace), ['update-ref', '-d', `refs/friday/${id}/${name}`])
  }
}

async function pruneFileStore(workspace: string, kept: readonly Checkpoint[]): Promise<void> {
  const trees = new Set(kept.flatMap(entry => [entry.before_tree, entry.after_tree])
    .filter(tree => tree.startsWith(FILE_TREE)).map(tree => tree.slice(FILE_TREE.length)))
  const blobs = new Set<string>()
  for (const tree of trees) {
    try {
      const value = await readFileTree(workspace, `${FILE_TREE}${tree}`)
      for (const entry of value.entries) if (entry.type === 'file') blobs.add(entry.hash)
    } catch {}
  }
  const treeDirectory = join(fileStoreDir(workspace), 'trees')
  for (const name of await directoryNames(treeDirectory)) {
    if (name.endsWith('.json') && !trees.has(name.slice(0, -5))) await rm(join(treeDirectory, name), { force: true })
  }
  const objectDirectory = join(fileStoreDir(workspace), 'objects')
  for (const prefix of await directoryNames(objectDirectory)) {
    const directory = join(objectDirectory, prefix)
    for (const name of await directoryNames(directory)) {
      if (!blobs.has(`${prefix}${name}`)) await rm(join(directory, name), { force: true })
    }
    if (!(await directoryNames(directory)).length) await rm(directory, { recursive: true, force: true })
  }
}

async function directoryNames(path: string): Promise<string[]> {
  try { return await readdir(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function removeBlockingDirectory(path: string, relativePath: string): Promise<void> {
  let status
  try { status = await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!status.isDirectory()) return
  if (await directoryHasFiles(path)) {
    throw new Error(`Checkpoint restore cannot replace '${relativePath}' because it contains ignored files.`)
  }
  await rm(path, { recursive: true, force: true })
}

async function directoryHasFiles(path: string): Promise<boolean> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (!entry.isDirectory() || await directoryHasFiles(join(path, entry.name))) return true
  }
  return false
}

function validEntry(value: unknown): value is Checkpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Partial<Checkpoint>
  return item.schema_version === 1 && typeof item.id === 'string' && typeof item.before_tree === 'string'
    && typeof item.session_id === 'string' && Array.isArray(item.before_messages)
}

function workspacePath(workspace: string, path: string): string {
  const root = resolve(workspace)
  const absolute = resolve(root, ...path.split('/'))
  const rel = relative(root, absolute)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Checkpoint path escapes workspace: ${path}`)
  }
  return absolute
}

function validateId(id: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid checkpoint id.')
}

function entryPath(workspace: string, id: string): string {
  validateId(id)
  return join(entriesDir(workspace), `${id}.json`)
}

function entriesDir(workspace: string): string {
  return join(projectStateDir(resolve(workspace)), 'checkpoints-ts', 'entries')
}

function repoDir(workspace: string): string {
  return join(projectStateDir(resolve(workspace)), 'checkpoints-ts', 'repo.git')
}

function temporaryIndex(workspace: string): string {
  return join(projectStateDir(resolve(workspace)), 'checkpoints-ts', `.index-${process.pid}-${randomUUID()}`)
}

function now(): string {
  return localTimestamp()
}
