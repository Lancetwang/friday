import { existsSync, readFileSync } from 'node:fs'
import { platform, release } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { fridayHome, projectStateDir, type ModelConfig } from './config.js'
import { promptAssets } from './prompt-assets.js'

export function buildInstructions(
  workspace: string,
  config: ModelConfig,
  extraSections: Array<[string, string]> = []
): string {
  const home = fridayHome()
  const parts: Array<[string, string]> = [
    ['Soul', userFile(home, ['SOUL.md', 'soul.md']) || template('SOUL.md')],
    ['Security', template('SECURITY.md')],
    ['Runtime', template('RUNTIME.md')],
    ['Tool Guidance', template('TOOL_GUIDANCE.md')],
    ['Global Rules', userFile(home, ['AGENTS.md']) || template('AGENTS.md')],
    ['Project Instructions', projectInstructions(workspace)],
    // Capability and plugin sections (Skills routing included) sit between
    // the durable rules and the environment so they can guide tool choice
    // without outranking security or user rules.
    ...extraSections,
    ['Environment', environment(workspace, config)]
  ]
  return parts.filter(([, body]) => body.trim()).map(([title, body]) => `## ${title}\n${body.trim()}`).join('\n\n')
}

/** Prompt contribution owned by the memory capability. */
export function buildMemoryInstructions(workspace: string): string {
  const home = fridayHome()
  const state = projectStateDir(workspace)
  const durable: Array<[string, string]> = [
    ['User Profile', memoryPromptFile(home, ['USER.md', 'user.md'])],
    ['Global Memory', memoryPromptFile(home, ['MEMORY.md'])],
    ['Project Memory', memoryPromptFile(state, ['MEMORY.md'])]
  ]
  return [
    template('MEMORY.md').trim(),
    ...durable.filter(([, body]) => body.trim()).map(([title, body]) => `### ${title}\n${body.trim()}`)
  ].join('\n\n')
}

export function promptTemplate(name: string): string {
  const value = promptAssets[name]
  if (value === undefined) throw new Error(`Unknown bundled prompt: ${name}`)
  return value
}

const template = promptTemplate

function userFile(root: string, names: string[]): string {
  const path = names.map(name => join(root, name)).find(existsSync)
  return path ? readFileSync(path, 'utf8').slice(0, 12_000) : ''
}

/** Keep storage bookkeeping out of the model-facing durable-memory prefix. */
function memoryPromptFile(root: string, names: string[]): string {
  const path = names.map(name => join(root, name)).find(existsSync)
  if (!path) return ''
  return readFileSync(path, 'utf8')
    .replace(/^<!-- friday-memory \{.*\} -->\r?$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, 12_000)
}

function projectInstructions(workspace: string): string {
  const roots: string[] = []
  for (let current = resolve(workspace); ; current = dirname(current)) {
    roots.unshift(current)
    if (dirname(current) === current) break
  }
  const globalRules = resolve(fridayHome(), 'AGENTS.md')
  return roots.flatMap(root => [join(root, 'AGENTS.md'), join(root, '.friday', 'AGENTS.md')])
    .filter(existsSync)
    .filter(path => resolve(path) !== globalRules)
    .map(path => readFileSync(path, 'utf8').slice(0, 12_000))
    .join('\n\n')
}

function environment(workspace: string, config: ModelConfig): string {
  const os = platform()
  const shell = os === 'win32' ? 'PowerShell' : 'bash'
  return `# Environment

- Workspace: ${resolve(workspace)}
- Current date: ${localDate()}
- OS: ${os} ${release()}
- Shell: ${shell}
- Friday home: ${fridayHome()}
- Friday install: ${resolve(dirname(process.execPath))}
- Global model config: ${join(fridayHome(), 'config.json')}
- Project model config override: ${join(projectStateDir(workspace), 'config.json')}
- Model: ${config.provider}/${config.model}
- Context window: ${config.contextWindow} tokens
- Maximum output: ${config.maxOutputTokens} tokens
- Permission mode: ${permissionMode()}`
}

function permissionMode(): string {
  const value = process.env.FRIDAY_PERMISSION_MODE
  return value === 'auto' || value === 'bypass' ? value : 'manual'
}

function localDate(): string {
  const now = new Date()
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((value, index) => index ? String(value).padStart(2, '0') : String(value))
    .join('-')
}
