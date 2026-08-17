import { spawn, type ChildProcess } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync, mkdirSync, realpathSync } from 'node:fs'
import { opendir, readFile, readdir, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'

import { getCurrentToolCall, type JsonObject, type Tool } from 'friday-agent-core'

import { disabledPlugins, projectStateDir } from './config.js'
import { defaultPermissionMode, preflightShell, preflightVerifierShell, type PermissionMode } from './permissions.js'
import { assembleTools, builtinPlugin, markDisabled, type LoadedPlugin } from './plugins.js'
import { writeTextAtomic } from './storage.js'
import { buildSkillTool, skillRouting } from './skills.js'
import { buildWebTools } from './web.js'
import { formatMemoryResult, runMemoryCommand } from './memory.js'

const MAX_OUTPUT_CHARS = 50_000
const MAX_OUTPUT_LINES = 2_000
const MAX_RESULTS = 1_000
const GENERATED_DIRECTORIES = new Set([
  '.mypy_cache', '.next', '.pytest_cache', '.ruff_cache', '.turbo', '.venv',
  '__pycache__', 'build', 'coverage', 'dist', 'node_cache', 'node_modules', 'target', 'venv'
])

const object = (properties: JsonObject, required: string[] = []): JsonObject => ({
  type: 'object', properties, additionalProperties: false, ...(required.length ? { required } : {})
})
const string = (description: string): JsonObject => ({ type: 'string', description })
const integer = (description: string, minimum = 1, maximum = MAX_RESULTS): JsonObject => ({
  type: 'integer', description, minimum, maximum
})

type ToolOptions = {
  sessionId?: string
  permissionMode?: () => PermissionMode
  sessionAllowed?: () => boolean
  beforeMutation?: () => Promise<void>
  updatePlan?: (value: { plan: unknown; objective?: unknown; explanation?: unknown; next_action?: unknown }) => unknown | Promise<unknown>
  readPaths?: () => readonly string[]
  reviewCommand?: (command: string, risk: string, signal?: AbortSignal) => Promise<{ decision: 'allow' | 'deny'; reason: string }>
}

type Edit = { old_text: string; new_text: string }

const fileLocks = new Map<string, Promise<void>>()

/**
 * Friday's built-in capabilities, registered as plugins. The workspace pack
 * is the required core; web, memory, and skills are unpluggable by listing
 * them in `disabled_plugins` - the same switch external plugins get.
 */
export function builtinPlugins(workspace: string, options: ToolOptions = {}): LoadedPlugin[] {
  const root = realpathSync.native(resolve(workspace))
  return [
    builtinPlugin({
      name: 'workspace',
      description: 'Read, write, search, shell, and planning inside the workspace.',
      required: true,
      verifierTools: ['Read', 'Glob', 'Grep', 'Bash'],
      tools: () => workspaceTools(root, options)
    }),
    builtinPlugin({
      name: 'web',
      description: 'Live web search and page fetching.',
      verifierTools: ['WebSearch', 'WebFetch'],
      tools: () => buildWebTools()
    }),
    builtinPlugin({
      name: 'memory',
      description: 'Durable cross-session memory.',
      tools: () => [memoryTool(root)]
    }),
    builtinPlugin({
      name: 'skills',
      description: 'Reusable procedures discovered from FridaySkills directories.',
      verifierTools: ['Skill'],
      tools: () => [buildSkillTool(root)],
      // Re-evaluated on every prompt rebuild so new skills appear mid-session.
      instructions: () => skillRouting(root)
    })
  ]
}

export function buildTools(workspace: string, options: ToolOptions = {}): Tool[] {
  return assembleTools(builtinPlugins(workspace, options), { workspace: resolve(workspace) })
}

function workspaceTools(root: string, options: ToolOptions): Tool[] {
  const paths = workspacePaths(root, options.readPaths)
  return [
    {
      name: 'Read', description: 'Read one page of a UTF-8 text file or list a folder inside the workspace or a user-attached path.', parallel: true,
      parameters: object({
        path: string('Path relative to the workspace.'),
        start_line: integer('1-based first line.', 1, Number.MAX_SAFE_INTEGER),
        line_count: integer(`Lines to return, capped at ${MAX_OUTPUT_LINES}.`, 1, MAX_OUTPUT_LINES)
      }, ['path']),
      async execute(args, signal) {
        return readPage(paths.readable(args.path), positive(args.start_line, 1), capped(args.line_count, MAX_OUTPUT_LINES, MAX_OUTPUT_LINES), signal)
      }
    },
    {
      name: 'Write', description: 'Create or replace a UTF-8 text file inside the workspace.',
      parameters: object({ path: string('Path relative to the workspace.'), content: string('Full file content.') }, ['path', 'content']),
      async preflight() {
        await options.beforeMutation?.()
        return { action: 'allow' }
      },
      async execute(args) {
        if (typeof args.content !== 'string') throw new Error('content must be a string')
        const path = paths.writable(args.path)
        await withFileLock(path, () => writeTextAtomic(path, args.content as string))
        return { path, chars: args.content.length, lines: args.content.split(/\r?\n/).length }
      }
    },
    {
      name: 'Edit', description: 'Apply disjoint exact-text replacements to a UTF-8 file inside the workspace.',
      parameters: object({
        path: string('Path relative to the workspace.'),
        edits: {
          type: 'array', minItems: 1,
          items: object({ old_text: string('Unique text to replace.'), new_text: string('Replacement text; empty deletes it.') }, ['old_text', 'new_text'])
        }
      }, ['path', 'edits']),
      async preflight() {
        await options.beforeMutation?.()
        return { action: 'allow' }
      },
      async execute(args) {
        const path = paths.existing(args.path)
        const edits = parseEdits(args.edits)
        return withFileLock(path, async () => {
          const original = await readFile(path, 'utf8')
          const { content, firstChangedLine } = applyEdits(original, edits, path)
          await writeTextAtomic(path, content)
          return { path, replacements: edits.length, first_changed_line: firstChangedLine }
        })
      }
    },
    {
      name: 'Glob', description: 'Find files and directories by glob pattern inside the workspace.', parallel: true,
      parameters: object({
        pattern: string("Glob such as '**/*.ts'."),
        max_results: integer(`Maximum results, capped at ${MAX_RESULTS}.`)
      }, ['pattern']),
      async execute(args, signal) {
        if (typeof args.pattern !== 'string' || !args.pattern) throw new Error('pattern must be a non-empty string')
        const limit = capped(args.max_results, 200, MAX_RESULTS)
        const pattern = globPattern(args.pattern)
        const matches: string[] = []
        for await (const item of walk(root, args.pattern, root, signal)) {
          if (pattern.test(item.relative)) matches.push(item.relative)
          if (matches.length >= limit) break
        }
        return { pattern: args.pattern, count: matches.length, paths: matches }
      }
    },
    {
      name: 'Grep', description: 'Search UTF-8 text files by regular expression inside the workspace.', parallel: true,
      parameters: object({
        pattern: string('JavaScript regular expression.'),
        path_glob: string("Files to search, such as '**/*.ts'."),
        max_results: integer(`Maximum matches, capped at ${MAX_RESULTS}.`),
        max_chars: integer('Maximum characters from each matching line.', 1, 2_000)
      }, ['pattern']),
      async execute(args, signal) {
        if (typeof args.pattern !== 'string') throw new Error('pattern must be a string')
        const expression = new RegExp(args.pattern)
        const requested = typeof args.path_glob === 'string' && args.path_glob ? args.path_glob : '**/*'
        const filePattern = globPattern(requested)
        const limit = capped(args.max_results, 100, MAX_RESULTS)
        const lineLimit = capped(args.max_chars, 240, 2_000)
        const matches: Array<{ path: string; line: number; text: string }> = []
        for await (const item of walk(root, requested, root, signal)) {
          if (item.directory || !filePattern.test(item.relative)) continue
          await grepFile(item.path, item.relative, expression, lineLimit, matches, limit, signal)
          if (matches.length >= limit) break
        }
        return { pattern: args.pattern, count: matches.length, matches }
      }
    },
    {
      name: 'Bash', description: 'Run a shell command in the workspace. Uses PowerShell on Windows and sh elsewhere.',
      parameters: object({ command: string('Shell command.'), timeout_seconds: integer('Timeout in seconds.', 1, 600) }, ['command']),
      async preflight(call, signal) {
        await options.beforeMutation?.()
        return preflightShell(call, {
          workspace: root,
          sessionId: options.sessionId || 'default',
          mode: options.permissionMode?.() ?? defaultPermissionMode(),
          sessionAllowed: options.sessionAllowed?.() ?? false,
          ...(options.reviewCommand ? { review: options.reviewCommand } : {})
        }, signal)
      },
      execute(args, signal, onProgress) {
        if (typeof args.command !== 'string') throw new Error('command must be a string')
        const spillPath = join(toolSpillDir(root, options.sessionId || 'default'), `${getCurrentToolCall()?.id || randomUUID()}.log`)
        return runShell(root, args.command, capped(args.timeout_seconds, 60, 600), signal, onProgress, spillPath)
      }
    },
    {
      name: 'UpdatePlan', description: 'Create or update the visible plan for the current non-trivial session goal.',
      parameters: object({
        plan: {
          type: 'array', maxItems: 12,
          description: 'Full plan. At most one step may be in_progress.',
          items: object({
            step: string('Concrete step.'),
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked'] }
          }, ['step', 'status'])
        },
        objective: string("Updated effective objective when the user's request changed."),
        explanation: string('Short reason for a plan or scope change.'),
        next_action: string('Immediate next action or blocker.')
      }, ['plan']),
      execute(args) {
        if (!options.updatePlan) throw new Error('UpdatePlan requires an active Friday session.')
        return options.updatePlan({
          plan: args.plan,
          objective: args.objective,
          explanation: args.explanation,
          next_action: args.next_action
        })
      }
    }
  ]
}

function memoryTool(root: string): Tool {
  return {
    name: 'Memory',
    description: 'Inspect or change durable Friday memory. Supports status, list, search, add, update, and remove commands.',
    parameters: object({ command: string('Memory command without a leading `friday memory`.') }, ['command']),
    async execute(args) {
      if (typeof args.command !== 'string') throw new Error('command must be a string')
      if (/^\s*consolidate\b/i.test(args.command)) {
        throw new Error('Run memory consolidation from the UI after the active turn finishes.')
      }
      return formatMemoryResult(await runMemoryCommand(args.command, root))
    }
  }
}

/**
 * The verifier assembles only from built-in plugins and only their declared
 * read-only tools. Declarations are checked against what actually assembled,
 * so a renamed tool fails loudly here instead of silently vanishing from the
 * verifier. The user's disabled-plugins list is honored - a capability the
 * user unplugged stays unplugged during verification too - except for the
 * required workspace pack.
 */
export function buildVerifierTools(workspace: string): Tool[] {
  const packs = markDisabled(builtinPlugins(workspace), disabledPlugins(workspace))
  const allowed = packs.flatMap(pack => pack.disabled ? [] : [...pack.module?.verifierTools ?? []])
  const tools = assembleTools(packs, { workspace: resolve(workspace) }).filter(tool => allowed.includes(tool.name))
  const missing = allowed.filter(name => !tools.some(tool => tool.name === name))
  if (missing.length) throw new Error(`Verifier tools are declared but not assembled: ${missing.join(', ')}`)
  return tools.map(tool => tool.name === 'Bash' ? { ...tool, preflight: call => preflightVerifierShell(call, workspace) } : tool)
}

/**
 * Shell output enters the conversation bounded at birth, because the message
 * array is append-only between compactions: what goes in is never rewritten.
 * Within SHELL_CONTEXT_LIMIT the result is complete. Beyond it the context
 * gets the true head and tail with a pointer, and the full stream (up to
 * SPILL_CAP_BYTES) is written to a spill file the agent can Read on demand -
 * an upgrade over the old rolling buffer, which silently discarded the head
 * of anything past 50k characters with no way back.
 */
export const SHELL_CONTEXT_LIMIT = 16_000
const SHELL_HEAD_CHARS = 8_000
const SHELL_TAIL_CHARS = 4_000
const SPILL_CAP_BYTES = 2_000_000

export function toolSpillDir(workspace: string, sessionId: string): string {
  return join(projectStateDir(resolve(workspace)), 'sessions', `${sessionId}-tools`)
}

export async function runShell(
  workspace: string,
  source: string,
  timeoutSeconds = 60,
  signal?: AbortSignal,
  onProgress?: (content: string) => void,
  spillPath?: string
): Promise<JsonObject> {
  signal?.throwIfAborted()
  const command = process.platform === 'win32'
    ? `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding;${source}`
    : source
  const [file, shellArgs] = process.platform === 'win32'
    ? ['powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]]
    : ['/bin/bash', ['-lc', command]]
  const child = spawn(file, shellArgs, {
    cwd: workspace,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const streams = { stdout: streamState(), stderr: streamState() }
  let liveTail = ''
  let lastProgress = 0
  let timedOut = false
  let stopping = false
  let settled = false
  let exitCode: number | null = null
  let settleOutcome: ((value: { code: number | null; error?: Error }) => void) | undefined
  const graceTimers: NodeJS.Timeout[] = []
  const settleAfter = (ms: number) => {
    const grace = setTimeout(() => settleOutcome?.({ code: exitCode }), ms)
    grace.unref?.()
    graceTimers.push(grace)
  }
  const spill = spillPath ? spillWriter(spillPath) : undefined
  const report = (content: string, final = false) => {
    liveTail = (liveTail + content).slice(-8_000)
    const now = performance.now()
    if (liveTail && (final || now - lastProgress >= 100)) {
      onProgress?.(liveTail)
      lastProgress = now
    }
  }
  const consume = (state: StreamState, chunk: string) => {
    if (settled) return
    state.total += chunk.length
    if (state.head.length < SHELL_HEAD_CHARS) state.head += chunk.slice(0, SHELL_HEAD_CHARS - state.head.length)
    state.tail = (state.tail + chunk).slice(-MAX_OUTPUT_CHARS)
    spill?.write(chunk)
    report(chunk)
  }
  child.stdout!.setEncoding('utf8')
  child.stderr!.setEncoding('utf8')
  child.stdout!.on('data', (chunk: string) => consume(streams.stdout, chunk))
  child.stderr!.on('data', (chunk: string) => consume(streams.stderr, chunk))
  const stop = () => {
    if (stopping) return
    stopping = true
    terminateProcessTree(child)
    // SIGKILL cannot free a process stuck in uninterruptible I/O and cannot
    // reach a survivor that re-parented out of the group; the wait below must
    // not depend on either of them dying.
    settleAfter(1_500)
  }
  const timer = setTimeout(() => {
    timedOut = true
    stop()
  }, Math.min(600, Math.max(1, timeoutSeconds)) * 1_000)
  const abort = () => stop()
  signal?.addEventListener('abort', abort, { once: true })
  const outcome = await new Promise<{ code: number | null; error?: Error }>(resolveOutcome => {
    settleOutcome = resolveOutcome
    child.once('error', error => resolveOutcome({ code: null, error }))
    // 'close' waits for stdio to drain and never fires while a background
    // survivor holds the pipes; 'exit' plus a short flush grace is the honest
    // signal that the command itself is over.
    child.once('close', code => resolveOutcome({ code }))
    child.once('exit', code => {
      exitCode = code
      settleAfter(800)
    })
  })
  settled = true
  for (const grace of graceTimers) clearTimeout(grace)
  clearTimeout(timer)
  signal?.removeEventListener('abort', abort)
  // Release our end of the pipes: stops late data from a lingering holder and
  // lets it die on the next write instead of blocking.
  child.stdout!.destroy()
  child.stderr!.destroy()
  report('', true)
  const spilled = await (spill?.finish() ?? Promise.resolve(false))
  signal?.throwIfAborted()
  const stdout = boundedStream(streams.stdout, spilled ? spillPath : undefined)
  const stderrText = boundedStream(streams.stderr, spilled ? spillPath : undefined)
  return {
    stdout,
    stderr: outcome.error ? (stderrText || outcome.error.message).slice(-MAX_OUTPUT_CHARS) : stderrText,
    exit_code: timedOut ? null : outcome.code ?? 1,
    ...(timedOut ? { timed_out: true } : {})
  }
}

type StreamState = { head: string; tail: string; total: number }

function streamState(): StreamState {
  return { head: '', tail: '', total: 0 }
}

function boundedStream(state: StreamState, spillPath?: string): string {
  if (state.total <= SHELL_CONTEXT_LIMIT) return state.tail
  const omitted = state.total - SHELL_HEAD_CHARS - SHELL_TAIL_CHARS
  const pointer = spillPath
    ? `full stream saved to ${spillPath}; Read it (paged) if the middle matters`
    : 'full stream was not captured'
  return `${state.head}\n…[${omitted.toLocaleString()} of ${state.total.toLocaleString()} chars omitted; ${pointer}]\n${state.tail.slice(-SHELL_TAIL_CHARS)}`
}

/**
 * Buffers until the combined stream crosses the context limit, then flushes
 * everything to disk and keeps appending up to the cap. Small results never
 * touch the filesystem.
 */
function spillWriter(path: string): { write(chunk: string): void; finish(): Promise<boolean> } {
  let buffered: string[] | undefined = []
  let bufferedBytes = 0
  let written = 0
  let stream: ReturnType<typeof createWriteStream> | undefined
  let failed = false
  const open = () => {
    try {
      mkdirSync(dirname(path), { recursive: true })
      stream = createWriteStream(path, { encoding: 'utf8' })
      stream.on('error', () => { failed = true })
    } catch {
      failed = true
    }
  }
  return {
    write(chunk: string): void {
      if (failed || written >= SPILL_CAP_BYTES) return
      if (buffered) {
        buffered.push(chunk)
        bufferedBytes += chunk.length
        if (bufferedBytes <= SHELL_CONTEXT_LIMIT) return
        open()
        if (failed) return
        for (const piece of buffered) {
          stream!.write(piece)
          written += piece.length
        }
        buffered = undefined
        return
      }
      const room = SPILL_CAP_BYTES - written
      stream?.write(chunk.slice(0, room))
      written += Math.min(chunk.length, room)
    },
    async finish(): Promise<boolean> {
      if (!stream) return false
      await new Promise<void>(done => stream!.end(() => done()))
      return !failed
    }
  }
}

function terminateProcessTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    return
  }
  const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
    windowsHide: true,
    stdio: 'ignore'
  })
  const fallback = setTimeout(() => child.kill(), 5_000)
  fallback.unref()
  killer.once('error', () => {
    clearTimeout(fallback)
    child.kill()
  })
  killer.once('close', () => {
    clearTimeout(fallback)
    if (child.exitCode === null) child.kill()
  })
}

function workspacePaths(root: string, readPaths?: () => readonly string[]) {
  const contained = (path: string, input: unknown): string => {
    const rel = relative(root, path)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Path escapes workspace: ${String(input)}`)
    return path
  }
  return {
    readable(input: unknown): string {
      if (typeof input !== 'string' || !input) throw new Error('path must be a non-empty string')
      const path = realpathSync.native(resolve(root, input))
      try { return contained(path, input) } catch {
        for (const allowed of readPaths?.() ?? []) {
          let base: string
          try { base = realpathSync.native(allowed) } catch { continue }
          const rel = relative(base, path)
          if (!rel || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return path
        }
        throw new Error(`Path escapes workspace: ${String(input)}`)
      }
    },
    existing(input: unknown): string {
      if (typeof input !== 'string' || !input) throw new Error('path must be a non-empty string')
      return contained(realpathSync.native(resolve(root, input)), input)
    },
    writable(input: unknown): string {
      if (typeof input !== 'string' || !input) throw new Error('path must be a non-empty string')
      const path = resolve(root, input)
      if (existsSync(path)) return contained(realpathSync.native(path), input)
      let ancestor = dirname(path)
      while (!existsSync(ancestor)) ancestor = dirname(ancestor)
      contained(realpathSync.native(ancestor), input)
      return contained(path, input)
    }
  }
}

async function readPage(path: string, startLine: number, lineCount: number, signal?: AbortSignal): Promise<JsonObject> {
  if ((await stat(path)).isDirectory()) return directoryPage(path, startLine, lineCount)
  const lines: string[] = []
  let number = 0
  let chars = 0
  let hasMore = false
  const input = createReadStream(path, { encoding: 'utf8' })
  const reader = createInterface({ input, crlfDelay: Infinity })
  for await (const line of reader) {
    signal?.throwIfAborted()
    number += 1
    if (number < startLine) continue
    if (lines.length >= lineCount || chars + line.length + 1 > MAX_OUTPUT_CHARS) {
      hasMore = true
      break
    }
    lines.push(lines.length || startLine > 1 ? line : line.replace(/^\uFEFF/, ''))
    chars += line.length + 1
  }
  return {
    path,
    start_line: startLine,
    end_line: startLine + lines.length - 1,
    content: lines.join('\n'),
    ...(hasMore ? { next_start_line: startLine + lines.length } : {})
  }
}

async function directoryPage(path: string, startLine: number, lineCount: number): Promise<JsonObject> {
  const entries = (await readdir(path, { withFileTypes: true }))
    .map(entry => `${entry.name}${entry.isDirectory() ? '/' : ''}`)
    .sort((left, right) => left.localeCompare(right))
  const page: string[] = []
  let chars = 0
  for (const entry of entries.slice(startLine - 1)) {
    if (page.length >= lineCount || chars + entry.length + 1 > MAX_OUTPUT_CHARS) break
    page.push(entry)
    chars += entry.length + 1
  }
  return {
    path,
    start_line: startLine,
    end_line: startLine + page.length - 1,
    content: page.join('\n'),
    entries: entries.length,
    ...(startLine - 1 + page.length < entries.length ? { next_start_line: startLine + page.length } : {})
  }
}

async function* walk(
  root: string,
  requestedPattern: string,
  directory = root,
  signal?: AbortSignal
): AsyncGenerator<{ path: string; relative: string; directory: boolean }> {
  // Cancellation has to bite inside long scans: a stop press must not wait
  // for a large tree to finish walking on its own.
  const entries = await opendir(directory)
  for await (const entry of entries) {
    signal?.throwIfAborted()
    const path = resolve(directory, entry.name)
    let target: string
    try {
      target = realpathSync.native(path)
    } catch {
      continue
    }
    const rel = relative(root, target)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue
    const normalized = relative(root, path).split(sep).join('/')
    const isDirectory = entry.isDirectory()
    if (isDirectory && ignoredDirectory(entry.name, requestedPattern)) continue
    yield { path, relative: normalized, directory: isDirectory }
    if (isDirectory) yield* walk(root, requestedPattern, path, signal)
  }
}

function ignoredDirectory(name: string, requestedPattern: string): boolean {
  const normalized = name.toLowerCase()
  if (normalized === '.git') return true
  if (!GENERATED_DIRECTORIES.has(normalized)) return false
  return !requestedPattern.replaceAll('\\', '/').toLowerCase().split('/').includes(normalized)
}

async function grepFile(
  path: string,
  relativePath: string,
  expression: RegExp,
  lineLimit: number,
  matches: Array<{ path: string; line: number; text: string }>,
  limit: number,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  const input = createReadStream(path, { encoding: 'utf8' })
  input.on('error', () => {})
  const reader = createInterface({ input, crlfDelay: Infinity })
  let lineNumber = 0
  try {
    for await (const line of reader) {
      if (signal?.aborted) break
      lineNumber += 1
      if (expression.test(line)) matches.push({ path: relativePath, line: lineNumber, text: line.slice(0, lineLimit) })
      if (matches.length >= limit) break
    }
  } catch {} finally {
    input.close()
  }
  signal?.throwIfAborted()
}

function globPattern(source: string): RegExp {
  const pattern = source.replaceAll('\\', '/').replace(/^\.\//, '')
  let expression = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!
    if (char === '*' && pattern[index + 1] === '*') {
      index += 1
      if (pattern[index + 1] === '/') {
        index += 1
        expression += '(?:.*/)?'
      } else expression += '.*'
    } else if (char === '*') expression += '[^/]*'
    else if (char === '?') expression += '[^/]'
    else expression += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
  }
  return new RegExp(`${expression}$`)
}

function parseEdits(value: unknown): Edit[] {
  if (!Array.isArray(value) || !value.length) throw new Error('edits must contain at least one replacement')
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`edits[${index}] must be an object`)
    const edit = item as Partial<Edit>
    if (typeof edit.old_text !== 'string' || !edit.old_text) throw new Error(`edits[${index}].old_text must be a non-empty string`)
    if (typeof edit.new_text !== 'string') throw new Error(`edits[${index}].new_text must be a string`)
    return { old_text: edit.old_text, new_text: edit.new_text }
  })
}

function applyEdits(original: string, edits: Edit[], path: string): { content: string; firstChangedLine: number } {
  const bom = original.startsWith('\uFEFF') ? '\uFEFF' : ''
  const body = original.slice(bom.length)
  const ending = body.includes('\r\n') ? '\r\n' : body.includes('\r') && !body.includes('\n') ? '\r' : '\n'
  const normalized = body.replace(/\r\n?/g, '\n')
  const matches = edits.map((edit, index) => {
    const oldText = edit.old_text.replace(/\r\n?/g, '\n')
    const start = normalized.indexOf(oldText)
    if (start < 0) throw new Error(`edits[${index}].old_text was not found in ${path}`)
    if (normalized.indexOf(oldText, start + 1) >= 0) throw new Error(`edits[${index}].old_text is not unique in ${path}`)
    return { start, end: start + oldText.length, replacement: edit.new_text.replace(/\r\n?/g, '\n'), index }
  }).sort((left, right) => left.start - right.start)
  for (let index = 1; index < matches.length; index += 1) {
    if (matches[index]!.start < matches[index - 1]!.end) {
      throw new Error(`edits[${matches[index - 1]!.index}] and edits[${matches[index]!.index}] overlap in ${path}`)
    }
  }
  let cursor = 0
  let updated = ''
  for (const match of matches) {
    updated += normalized.slice(cursor, match.start) + match.replacement
    cursor = match.end
  }
  updated += normalized.slice(cursor)
  if (ending !== '\n') updated = updated.replaceAll('\n', ending)
  return { content: bom + updated, firstChangedLine: normalized.slice(0, matches[0]!.start).split('\n').length }
}

async function withFileLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const key = process.platform === 'win32' ? path.toLowerCase() : path
  const previous = fileLocks.get(key) ?? Promise.resolve()
  let release = () => {}
  const gate = new Promise<void>(resolveGate => { release = resolveGate })
  const tail = previous.then(() => gate)
  fileLocks.set(key, tail)
  await previous
  try {
    return await work()
  } finally {
    release()
    if (fileLocks.get(key) === tail) fileLocks.delete(key)
  }
}

function positive(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : fallback
}

function capped(value: unknown, fallback: number, maximum: number): number {
  return Math.min(maximum, positive(value, fallback))
}
