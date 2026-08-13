import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { fridayHome } from './config.js'
import { writeJsonAtomic, writeTextAtomic } from './storage.js'

const WEB_KEYS = { tavily: 'TAVILY_API_KEY', anysearch: 'ANYSEARCH_API_KEY' } as const
const MEMORY_FILES = { user: ['USER.md', 1_500], global: ['MEMORY.md', 2_500] } as const
const PROFILE_START = '<!-- friday-profile:start -->'
const PROFILE_END = '<!-- friday-profile:end -->'
const PROFILE_BLOCK = new RegExp(`${escapeRegex(PROFILE_START)}\\n([\\s\\S]*?)\\n${escapeRegex(PROFILE_END)}`)
const SECRET = /(?:api[_ -]?key|password|passwd|secret|access[_ -]?token)\s*[:=]\s*\S+|\b(?:sk-|hf_|tvly-|as_sk_)[A-Za-z0-9_-]{8,}/i

export type WebSearchSettings = { tavily_configured: boolean; anysearch_configured: boolean }
export type UserProfile = { preferred_name: string; preferred_language: string; habits: string }

export function loadWebSearchSettings(): WebSearchSettings {
  const saved = readObject(join(fridayHome(), 'web-credentials.json'))
  return {
    tavily_configured: !!text(saved.TAVILY_API_KEY, process.env.TAVILY_API_KEY || ''),
    anysearch_configured: !!text(saved.ANYSEARCH_API_KEY, process.env.ANYSEARCH_API_KEY || '')
  }
}

export function readWebSearchCredential(provider: string): string {
  const environment = WEB_KEYS[provider as keyof typeof WEB_KEYS]
  if (!environment) throw new Error(`Unknown web search provider: ${provider}`)
  return text(readObject(join(fridayHome(), 'web-credentials.json'))[environment], process.env[environment] || '')
}

export async function saveWebSearchSettings(params: Record<string, unknown>): Promise<WebSearchSettings> {
  const path = join(fridayHome(), 'web-credentials.json')
  const saved = readObject(path)
  for (const provider of Object.keys(WEB_KEYS) as Array<keyof typeof WEB_KEYS>) {
    const environment = WEB_KEYS[provider]
    const value = params[`${provider}_api_key`]
    if (params[`clear_${provider}`] === true) delete saved[environment]
    else if (typeof value === 'string' && value.trim()) saved[environment] = credential(value, `${provider} API key`)
  }
  await writeJsonAtomic(path, saved, true)
  return loadWebSearchSettings()
}

export function loadUserProfile(): UserProfile {
  let source = ''
  try { source = readFileSync(join(fridayHome(), 'USER.md'), 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const body = PROFILE_BLOCK.exec(source)?.[1] ?? ''
  return {
    preferred_name: /^Preferred name:\s*(.*)$/m.exec(body)?.[1]?.trim() ?? '',
    preferred_language: /^Preferred language:\s*(.*)$/m.exec(body)?.[1]?.trim() ?? '',
    habits: (body.split('Habits and preferences:\n', 2)[1] ?? '')
      .split('\n').map(line => line.startsWith('  ') ? line.slice(2) : line).join('\n').trim()
  }
}

export async function saveUserProfile(value: unknown): Promise<UserProfile> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('User profile settings must be an object.')
  const profile = value as Record<string, unknown>
  const current = loadUserProfile()
  const updated: UserProfile = {
    preferred_name: profileField(profile.preferred_name, 'Preferred name', 100),
    preferred_language: profileField(profile.preferred_language, 'Preferred language', 100),
    habits: 'habits' in profile ? profileField(profile.habits, 'Habits', 1_000) : current.habits
  }
  if (/\r|\n/.test(updated.preferred_name + updated.preferred_language)) {
    throw new Error('Preferred name and language must each fit on one line.')
  }
  const path = join(fridayHome(), 'USER.md')
  let source = '# User Profile\n'
  try { source = await readFile(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const base = source.replace(PROFILE_BLOCK, '').trimEnd()
  const habits = updated.habits.split('\n').map(line => `  ${line}`).join('\n')
  const block = `${PROFILE_START}\n## Personal Profile\nPreferred name: ${updated.preferred_name}\nPreferred language: ${updated.preferred_language}\nHabits and preferences:\n${habits}\n${PROFILE_END}`
  const content = Object.values(updated).some(Boolean) ? `${base}\n\n${block}\n` : `${base}\n`
  if (content.length > MEMORY_FILES.user[1]) throw new Error(`User profile would exceed ${MEMORY_FILES.user[1]} characters.`)
  await writeTextAtomic(path, content)
  return updated
}

export async function memoryFile(workspace: string, scope: unknown, includeContent = true): Promise<Record<string, unknown>> {
  const { path, limit } = memoryPath(scope)
  let content = ''
  try { content = await readFile(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return {
    path,
    chars: content.length,
    limit,
    ...(includeContent ? { content } : {})
  }
}

export async function saveMemoryFile(workspace: string, scope: unknown, value: unknown): Promise<Record<string, unknown>> {
  if (typeof value !== 'string') throw new Error('Memory file content must be text.')
  const { path, limit } = memoryPath(scope)
  if (value.length > limit) throw new Error(`Memory file exceeds ${limit} characters.`)
  if (SECRET.test(value)) throw new Error('Memory file appears to contain a secret or credential.')
  await writeTextAtomic(path, value)
  return memoryFile(workspace, scope, false)
}

function memoryPath(scope: unknown): { path: string; limit: number } {
  if (scope === 'user' || scope === 'global') {
    const [name, limit] = MEMORY_FILES[scope]
    return { path: join(fridayHome(), name), limit }
  }
  throw new Error(`Unknown memory file: ${String(scope)}`)
}

function readObject(path: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(requireRead(path))
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    if (error instanceof SyntaxError) throw new Error(`Invalid Friday settings JSON: ${path}`)
    throw error
  }
}

function requireRead(path: string): string {
  // Settings reads are tiny and synchronous so a load observes one coherent
  // snapshot between atomic renames without spreading async plumbing through RPC dispatch.
  return readFileSync(path, 'utf8')
}

function credential(value: string, label: string): string {
  const result = value.trim()
  if (result.length > 4_096 || /[\r\n]/.test(result)) throw new Error(`Invalid ${label}.`)
  return result
}

function profileField(value: unknown, label: string, maximum: number): string {
  if (value == null) return ''
  if (typeof value !== 'string') throw new Error(`${label} must be text.`)
  const result = value.trim()
  if (result.length > maximum) throw new Error(`${label} must be at most ${maximum} characters.`)
  if (result.includes(PROFILE_START) || result.includes(PROFILE_END) || SECRET.test(result)) {
    throw new Error(`${label} contains unsupported or secret content.`)
  }
  return result
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value ? value : fallback
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
