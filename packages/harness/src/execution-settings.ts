import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ExecutionSettings } from 'friday-agent-protocol'
import { projectStateDir } from './config.js'
import { withStateLock, writeJsonAtomic } from './storage.js'

const DEFAULT: ExecutionSettings = { backend: 'native', image: '', network: 'none' }

export function validateExecutionSettings(value: unknown): ExecutionSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Execution settings must be an object.')
  const record = value as Record<string, unknown>
  if (!['native', 'docker'].includes(String(record.backend)) || !['none', 'bridge'].includes(String(record.network))) throw new Error('Unsupported execution backend or network.')
  const image = typeof record.image === 'string' ? record.image.trim() : ''
  if (record.backend === 'docker' && !/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,255}$/.test(image)) throw new Error('Docker requires a valid, locally installed image name.')
  return { backend: record.backend as ExecutionSettings['backend'], image, network: record.network as ExecutionSettings['network'] }
}

export function loadExecutionSettings(workspace: string): ExecutionSettings {
  if (process.env.FRIDAY_EXECUTION_IMAGE) return { ...validateExecutionSettings({ backend: 'docker', image: process.env.FRIDAY_EXECUTION_IMAGE, network: 'none' }), managed_by: 'environment' }
  try { return validateExecutionSettings(JSON.parse(readFileSync(join(projectStateDir(workspace), 'execution.json'), 'utf8'))) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT }; throw error }
}

export async function saveExecutionSettings(workspace: string, value: unknown): Promise<ExecutionSettings> {
  if (process.env.FRIDAY_EXECUTION_IMAGE) throw new Error('Execution backend is set by FRIDAY_EXECUTION_IMAGE. Remove the environment override before changing it here.')
  const settings = validateExecutionSettings(value)
  const path = join(projectStateDir(workspace), 'execution.json')
  await withStateLock(path, () => writeJsonAtomic(path, settings))
  return settings
}
