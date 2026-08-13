import { readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { parse, relative, resolve, sep } from 'node:path'

import { fridayHome, projectStateDir } from './config.js'
import { writeTextAtomic } from './storage.js'

export async function resetFriday(workspace: string, includeUser = false): Promise<string[]> {
  const root = resolve(workspace)
  const home = resolve(fridayHome())
  const project = resolve(projectStateDir(root))
  const legacy = resolve(root, '.friday')
  childOf(resolve(home, 'projects'), project)
  childOf(root, legacy)
  if (includeUser) safeUserHome(home, root)

  const projectConfig = await optionalText(resolve(project, 'config.json'))
    || await optionalText(resolve(legacy, 'config.json'))
  const userConfig = await optionalText(resolve(home, 'config.json'))
  const targets = includeUser ? [project, legacy, home] : [project, legacy]
  const removed: string[] = []
  for (const target of [...new Set(targets)]) {
    try {
      await rm(target, { recursive: true, force: false })
      removed.push(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  if (includeUser && userConfig) await writeTextAtomic(resolve(home, 'config.json'), userConfig)
  if (projectConfig) await writeTextAtomic(resolve(project, 'config.json'), projectConfig)
  return removed
}

function childOf(parent: string, path: string): void {
  const value = relative(parent, path)
  if (!value || value === '..' || value.startsWith(`..${sep}`)) {
    throw new Error(`Refusing to reset unsafe state directory: ${path}`)
  }
}

function safeUserHome(path: string, workspace: string): void {
  if (path === parse(path).root || contains(path, resolve(homedir())) || contains(path, workspace)) {
    throw new Error(`Refusing to reset unsafe Friday home: ${path}`)
  }
}

function contains(parent: string, child: string): boolean {
  const value = relative(parent, child)
  return !value || value !== '..' && !value.startsWith(`..${sep}`) && !parse(value).root
}

async function optionalText(path: string): Promise<string> {
  try { return await readFile(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}
