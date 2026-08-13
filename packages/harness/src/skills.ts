import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { JsonObject, Tool } from 'friday-agent-core'

import { fridayHome, projectStateDir } from './config.js'

const MAX_SKILL_CHARS = 80_000

export type SkillInfo = {
  name: string
  description: string
  scope: 'project' | 'user'
  path: string
}

export function discoverSkills(workspace: string): SkillInfo[] {
  const found = new Map<string, SkillInfo>()
  const roots: Array<[SkillInfo['scope'], string]> = [
    ['project', join(projectStateDir(workspace), 'FridaySkills')],
    ['project', join(resolve(workspace), '.friday', 'FridaySkills')],
    ['user', join(fridayHome(), 'FridaySkills')]
  ]
  for (const [scope, root] of roots) {
    let directories
    try { directories = readdirSync(root, { withFileTypes: true }) } catch { continue }
    for (const directory of directories.filter(entry => entry.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(root, directory.name, 'SKILL.md')
      let source: string
      try { source = readFileSync(path, 'utf8') } catch { continue }
      const metadata = skillMetadata(source, directory.name)
      const key = metadata.name.trim().toLowerCase() || directory.name.toLowerCase()
      if (!found.has(key)) {
        found.set(key, { ...metadata, scope, path: realpathSync.native(path) })
      }
    }
  }
  return [...found.values()].sort((left, right) => left.name.localeCompare(right.name))
}

export function skillDetail(workspace: string, requestedPath: string): { skill: SkillInfo; content: string } {
  const skill = discoverSkills(workspace).find(item => samePath(item.path, requestedPath))
  if (!skill) throw new Error('Skill is not available to Friday.')
  return { skill, content: skillBody(readFileSync(skill.path, 'utf8')) }
}

export function skillRouting(workspace: string): string {
  const skills = discoverSkills(workspace)
  if (!skills.length) return ''
  return [
    'Use the `Skill` tool only when a task clearly matches one of these descriptions. Read one selected skill at a time, then follow it.',
    ...skills.map(skill => `- ${skill.name}: ${skill.description}`)
  ].join('\n')
}

export function buildSkillTool(workspace: string): Tool {
  return {
    name: 'Skill',
    description: 'Read one available Friday skill or a relative resource referenced by that skill.',
    parallel: true,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact skill name from the Skills prompt section.' },
        resource: { type: 'string', description: 'Optional path relative to the skill directory.' }
      },
      required: ['name'],
      additionalProperties: false
    },
    execute(args) {
      if (typeof args.name !== 'string' || !args.name.trim()) throw new Error('name must be a non-empty string')
      const skill = discoverSkills(workspace).find(item => item.name.toLowerCase() === args.name!.toString().trim().toLowerCase())
      if (!skill) throw new Error(`Unknown Friday skill: ${String(args.name)}`)
      const resource = typeof args.resource === 'string' ? args.resource.trim() : ''
      const root = realpathSync.native(resolve(skill.path, '..'))
      const path = resource ? containedResource(root, resource) : skill.path
      if (!statSync(path).isFile()) throw new Error(`Skill resource is not a file: ${resource}`)
      const source = readFileSync(path, 'utf8')
      const content = resource ? source : skillBody(source)
      return {
        skill,
        path,
        content: content.slice(0, MAX_SKILL_CHARS),
        ...(content.length > MAX_SKILL_CHARS ? { truncated: true, chars: content.length } : {})
      } as JsonObject
    }
  }
}

export function skillBody(source: string): string {
  const lines = source.split(/(?<=\n)/)
  if (!lines.length || lines[0]!.trim() !== '---') return source
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  return end < 0 ? source : lines.slice(end + 1).join('').replace(/^\r?\n/, '')
}

function skillMetadata(source: string, fallback: string): Pick<SkillInfo, 'name' | 'description'> {
  let name = fallback
  let description = ''
  const lines = source.split(/\r?\n/)
  if (lines[0]?.trim() === '---') {
    for (const line of lines.slice(1)) {
      if (line.trim() === '---') break
      const match = /^([^:]+):\s*(.*)$/.exec(line)
      if (!match) continue
      const value = (match[2] ?? '').trim().replace(/^['"]|['"]$/g, '')
      if (match[1]?.trim() === 'name') name = value || name
      else if (match[1]?.trim() === 'description') description = value
    }
  }
  if (!description) {
    description = lines.map(line => line.trim()).find(line => line && !line.startsWith('#') && line !== '---') || 'No description.'
  }
  return { name, description }
}

function containedResource(root: string, resource: string): string {
  const path = realpathSync.native(resolve(root, resource))
  const rel = relative(root, path)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Skill resource escapes its directory: ${resource}`)
  return path
}

function samePath(left: string, right: string): boolean {
  try {
    const a = realpathSync.native(left)
    const b = realpathSync.native(right)
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  } catch { return false }
}
