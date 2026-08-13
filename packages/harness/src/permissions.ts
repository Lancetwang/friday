import { randomUUID } from 'node:crypto'
import { readFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { JsonObject, ToolCall, ToolPreflight } from 'friday-agent-core'

import { projectStateDir } from './config.js'
import { writeJsonAtomic } from './storage.js'

export type PermissionMode = 'auto' | 'bypass' | 'manual'

export type Approval = {
  id: string
  command: string
  reason: string
  timeout_seconds: number
  session_id: string
  tool_call_id?: string
}

type PermissionOptions = {
  mode: PermissionMode
  sessionAllowed: boolean
  sessionId: string
  workspace: string
  review?: (command: string, risk: string, signal?: AbortSignal) => Promise<{ decision: 'allow' | 'deny'; reason: string }>
}

export function normalizePermissionMode(value: unknown): PermissionMode {
  if (value === 'auto' || value === 'bypass' || value === 'manual') return value
  throw new Error(`Unknown permission mode: ${String(value)}`)
}

export function defaultPermissionMode(): PermissionMode {
  try {
    return normalizePermissionMode(String(process.env.FRIDAY_PERMISSION_MODE || 'manual').trim().toLowerCase())
  } catch {
    return 'manual'
  }
}

export async function preflightShell(call: ToolCall, options: PermissionOptions, signal?: AbortSignal): Promise<ToolPreflight> {
  const args = argumentsOf(call)
  const command = typeof args.command === 'string' ? args.command.trim() : ''
  if (!command) return { action: 'deny', result: { blocked: true, message: 'Shell command cannot be empty.' } }
  const hardDeny = hardDenied(command)
  if (hardDeny) return denied(hardDeny)

  const rules = await permissionRules(options.workspace)
  if (matches(command, rules.deny)) return denied('matched deny rule')
  if (options.mode === 'bypass' || options.sessionAllowed || matches(command, rules.allow)) return { action: 'allow' }

  const reason = matches(command, rules.require_approval) ? 'matched approval rule' : dangerous(command)
  if (!reason) return { action: 'allow' }
  if (options.mode === 'auto') {
    if (!options.review) return denied(`automatic review is unavailable for a command that ${reason}`)
    try {
      const review = await options.review(command, reason, signal)
      return review.decision === 'allow' ? { action: 'allow' } : denied(`automatic review refused it: ${review.reason}`)
    } catch (error) {
      if (signal?.aborted) throw error
      return denied(`automatic review failed safely: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const approval: Approval = {
    id: randomUUID().replaceAll('-', '').slice(0, 16),
    command,
    reason,
    timeout_seconds: positiveInteger(args.timeout_seconds, 60, 600),
    session_id: options.sessionId,
    tool_call_id: call.id
  }
  await writeJsonAtomic(approvalPath(options.workspace, options.sessionId), approval)
  return {
    action: 'pause',
    result: { ...approval, approval_required: true, message: 'Execution paused for human approval.' }
  }
}

export async function preflightVerifierShell(call: ToolCall, workspace: string): Promise<ToolPreflight> {
  const args = argumentsOf(call)
  const command = typeof args.command === 'string' ? args.command.trim() : ''
  if (!command) return denied('shell command cannot be empty')
  const hardDeny = hardDenied(command)
  if (hardDeny) return denied(hardDeny)
  const rules = await permissionRules(workspace)
  if (matches(command, rules.deny)) return denied('matched deny rule')
  const mutation = dangerous(command) || verifierMutation(command)
  return mutation ? denied(`the verifier is read-only and this command ${mutation}`) : { action: 'allow' }
}

export async function pendingApproval(workspace: string, sessionId: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(approvalPath(workspace, sessionId), 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value)
      ? { pending: true, ...value as JsonObject }
      : { pending: false, message: 'Invalid pending approval.' }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { pending: false, message: 'No pending approval.' }
      : { pending: false, message: 'Invalid pending approval.' }
  }
}

export async function claimApproval(workspace: string, sessionId: string): Promise<Approval | undefined> {
  const path = approvalPath(workspace, sessionId)
  const claim = join(projectStateDir(workspace), 'approvals', `.${sessionId}.claim-${process.pid}-${randomUUID()}`)
  try {
    await rename(path, claim)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    const value: unknown = JSON.parse(await readFile(claim, 'utf8'))
    return isApproval(value) ? value : undefined
  } finally {
    await rm(claim, { force: true })
  }
}

export async function discardApproval(workspace: string, sessionId: string): Promise<void> {
  await rm(approvalPath(workspace, sessionId), { force: true })
}

function approvalPath(workspace: string, sessionId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error(`Invalid session id: ${sessionId}`)
  return join(projectStateDir(workspace), 'approvals', `${sessionId}.json`)
}

async function permissionRules(workspace: string): Promise<{ allow: string[]; deny: string[]; require_approval: string[] }> {
  let saved: JsonObject = {}
  try {
    const value: unknown = JSON.parse(await readFile(join(projectStateDir(workspace), 'permissions.json'), 'utf8'))
    if (value && typeof value === 'object' && !Array.isArray(value)) saved = value as JsonObject
  } catch {}
  const bash = saved.bash && typeof saved.bash === 'object' && !Array.isArray(saved.bash) ? saved.bash as JsonObject : {}
  return {
    allow: [...strings(bash.allow), ...environmentRules('FRIDAY_ALLOWED_TOOLS')],
    deny: [...strings(bash.deny), ...environmentRules('FRIDAY_DISALLOWED_TOOLS')],
    require_approval: strings(bash.require_approval)
  }
}

function environmentRules(name: string): string[] {
  try {
    return strings(JSON.parse(process.env[name] || '[]')).map(value => {
      const match = /^bash\((.*)\*?\)$/i.exec(value.trim())
      return value.trim().toLowerCase() === 'bash' ? '*' : match?.[1]?.replace(/\*$/, '').trim() || ''
    }).filter(Boolean)
  } catch {
    return []
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function matches(command: string, rules: string[]): boolean {
  const raw = command.trim().toLowerCase()
  const surface = shellSurface(command).trim().toLowerCase()
  return rules.some(value => {
    const rule = value.trim().toLowerCase()
    return rule === '*' || !!rule && [raw, surface].some(text => text === rule || text.startsWith(`${rule} `))
  })
}

function shellSurface(command: string): string {
  let quote = ''
  let escaped = false
  return [...command].map(char => {
    if (escaped) {
      escaped = false
      return quote ? ' ' : char
    }
    if (char === '\\') {
      escaped = true
      return quote ? ' ' : char
    }
    if (quote) {
      if (char === quote) quote = ''
      return ' '
    }
    if (char === '"' || char === "'") {
      quote = char
      return ' '
    }
    return char
  }).join('')
}

function dangerous(command: string): string {
  const text = shellSurface(command).toLowerCase()
  const raw = command.toLowerCase()
  if (CREDENTIAL_PATH.test(raw)) return 'accesses credential-bearing files'
  if (SECRET_READ.test(text)) return 'reads credentials from the environment'
  if (/\b(?:shutil\.rmtree|os\.(?:remove|unlink)|fs\.(?:rm|rmsync)|pathlib\.path\([^)]*\)\.unlink)\b/.test(raw)) {
    return 'deletes files or directories'
  }
  const checks: Array<[RegExp, string]> = [
    [/\b(remove-item|rm|del|erase|rmdir|rd)\b/, 'deletes files or directories'],
    [/\bgit\s+(reset|clean)\b/, 'can discard git state'],
    [/\bgit\s+push\b/, 'can send commits off this machine'],
    [/\b(set-content|add-content|out-file|new-item|move-item|rename-item)\b/, 'writes or moves files'],
    [/\b(curl|wget|invoke-webrequest|invoke-restmethod|iwr|irm|scp|sftp|rsync|ssh|nc|ncat|netcat|telnet)\b/, 'can send data off this machine'],
    [/\b(pip|pip3|pipx)\s+install\b|\buv\s+(pip\s+install|add|tool\s+install)\b|\buvx\b|\b(npm|pnpm|yarn|bun)\s+(i|install|add|create|exec)\b|\bnpx\b|\bcargo\s+install\b|\b(brew|winget|choco|scoop|apt|apt-get|dnf|yum)\s+install\b/, 'installs packages that run publisher-supplied scripts'],
    [/\b(chmod|chown|icacls|takeown|attrib)\b/, 'changes file permissions or ownership'],
    [/\b(iex|invoke-expression|runas|schtasks|reg\s+(add|delete))\b|\b-verb\s+runas\b/, 'executes dynamic code or changes system state'],
    [/\b(crontab|register-scheduledtask|new-service)\b|\bsystemctl\s+(enable|start)\b|\blaunchctl\s+(load|bootstrap)\b/, 'installs a persistent background task'],
    [/\bdocker\b[^\n]*(--privileged|\s-v\s+\/:|\s-v\s+[a-z]:[\\/]:)/, 'grants a container access to the host filesystem'],
    [/(^|[^>])>>?\s*(?!\$null\b|nul\b|\/dev\/null\b)[^|;&\s]+/, 'redirects output to a file']
  ]
  for (const [pattern, reason] of checks) if (pattern.test(text)) return reason
  return ''
}

function hardDenied(command: string): string {
  const text = command.toLowerCase().replace(/\s+/g, ' ')
  if (CREDENTIAL_PATH.test(command.toLowerCase()) && EGRESS.test(text)) return 'credential exfiltration is blocked'
  if (SECRET_READ.test(text) && EGRESS.test(text)) return 'sending environment secrets off this machine is blocked'
  const checks: Array<[RegExp, string]> = [
    [/\b(format-volume|clear-disk|initialize-disk|remove-partition|diskpart|bcdedit|mkfs|fdisk|parted)\b/, 'disk or boot configuration changes are blocked'],
    [/\bdd\b[^\n;&]*\bof\s*=\s*\/dev\//, 'raw device writes are blocked'],
    [/\bformat(?:\.com)?\s+[a-z]:/, 'drive formatting is blocked'],
    [/\b(shutdown|restart-computer|stop-computer)\b/, 'system shutdown is blocked'],
    [/\bvssadmin\s+delete\s+shadows\b/, 'system recovery deletion is blocked'],
    [/\b(powershell|pwsh)(?:\.exe)?\b[^\n;&]*\s-(e|enc|encodedcommand)\b/, 'encoded shell commands are blocked'],
    [/\b(curl|wget|invoke-webrequest|invoke-restmethod|iwr|irm)\b[^\n]*(\||;)\s*(sh|bash|powershell|pwsh|python|python3|node|ruby|perl|iex|invoke-expression)\b/, 'executing remotely downloaded code is blocked'],
    [/\b(iex|invoke-expression)\s*\(?\s*(iwr|irm|invoke-webrequest|invoke-restmethod)\b/, 'executing remotely downloaded code is blocked'],
    [/\breg(?:\.exe)?\s+delete\s+(hklm|hkey_local_machine)\\/, 'machine-wide registry deletion is blocked']
  ]
  for (const [pattern, reason] of checks) if (pattern.test(text)) return reason
  for (const segment of command.split(/[;&|\n]+/)) {
    if (!/\b(remove-item|rm|rmdir|rd|del|erase)\b/i.test(segment)) continue
    const words = [...segment.matchAll(/"([^"]+)"|'([^']+)'|([^\s,]+)/g)]
      .map(match => String(match[1] || match[2] || match[3] || '').replace(/[.,]+$/, ''))
    const targets = words.map(word => /^[a-z]:/i.test(word) ? word.replaceAll('/', '\\') : word)
    if (targets.some(target => SYSTEM_PATH.test(target.replace(/[\\/]+$/, '')))) {
      return 'deletion inside an operating-system directory is blocked'
    }
    const recursive = /(^|\s)(-[a-z]*r[a-z]*f?|-recurse|\/s)(\s|$)/i.test(segment)
    if (recursive && targets.some(target =>
      ROOT_PATH.test(target)
      || ROOT_PATH.test(target.replace(/[\\/]+$/, ''))
      || samePath(target, homedir())
    )) {
      return 'recursive deletion of a system or home root is blocked'
    }
  }
  return ''
}

function verifierMutation(command: string): string {
  const text = shellSurface(command).toLowerCase()
  const checks: Array<[RegExp, string]> = [
    [/\bgit\s+(add|apply|checkout|cherry-pick|clean|commit|merge|mv|rebase|reset|restore|revert|rm|stash|switch|tag|worktree)\b/, 'changes Git or workspace state'],
    [/\b(npm|pnpm|yarn|bun)\s+(publish|pack|version|link|unlink)\b|\bcargo\s+publish\b|\bpython\s+-m\s+build\b/, 'publishes or packages artifacts'],
    [/\b(mkdir|md|touch|copy-item|cp|move|mv|rename|ren)\b/, 'creates or moves files']
  ]
  for (const [pattern, reason] of checks) if (pattern.test(text)) return reason
  return ''
}

function denied(reason: string): ToolPreflight {
  return { action: 'deny', result: { blocked: true, message: `Command blocked before execution: ${reason}` } }
}

function argumentsOf(call: ToolCall): JsonObject {
  try {
    const value: unknown = JSON.parse(call.function.arguments || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
  } catch {
    return {}
  }
}

function positiveInteger(value: unknown, fallback: number, maximum: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? Math.min(maximum, value as number) : fallback
}

function isApproval(value: unknown): value is Approval {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Partial<Approval>
  return typeof item.id === 'string' && typeof item.command === 'string' && typeof item.session_id === 'string'
    && (item.tool_call_id === undefined || typeof item.tool_call_id === 'string')
    && typeof item.timeout_seconds === 'number' && typeof item.reason === 'string'
}

const CREDENTIAL_PATH = /(^|[\\/\s'"])(\.env(?:\.\w+)?|\.ssh|\.aws|\.azure|\.kube|model-credentials\.json|credentials(?:\.json)?|id_rsa|id_ed25519)($|[\\/\s'"])/
const EGRESS = /\b(curl|wget|invoke-webrequest|invoke-restmethod|iwr|irm|scp|sftp|rsync|ssh|nc|ncat|netcat|telnet)\b|\bgit\s+push\b/
const SECRET_READ = /\bprintenv\b|(^|[;&|]\s*)env\s*($|[;&|])|\b(get-childitem|gci|ls|dir)\s+env:\s*(?=$|[;&|])|\$env:\w*(key|token|secret|password|passwd|credential)\w*|\bgh\s+auth\s+token\b|\baws\s+configure\s+get\b|\bsecurity\s+find-generic-password\b|\bcmdkey\b|\bget-credential\b|\bkeyctl\b/
const ROOT_PATH = /^(\/|~|\$home|\$env:(userprofile|home)|%userprofile%|[a-z]:[\\/])$/i
const SYSTEM_PATH = /^(\/(boot|etc|usr|bin|sbin|lib|var)(\/.*)?|[a-z]:[\\/](windows|program files( \(x86\))?|programdata)([\\/].*)?)$/i

function samePath(left: string, right: string): boolean {
  const clean = (value: string) => value.replace(/[\\/]+$/, '').replaceAll('/', process.platform === 'win32' ? '\\' : '/')
  return process.platform === 'win32'
    ? clean(left).toLowerCase() === clean(right).toLowerCase()
    : clean(left) === clean(right)
}
