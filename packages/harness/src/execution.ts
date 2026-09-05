import { randomUUID } from 'node:crypto'
import type { ExecutionBackend } from './plugin-api.js'
import { runShell } from './tools.js'

/** Requires an explicitly selected, locally available Docker image. */
export function dockerExecution(options: { image: string; network?: 'none' | 'bridge'; memory?: string }): ExecutionBackend {
  if (!options.image || options.image.startsWith('-')) throw new Error('Docker image is required.')
  return {
    name: 'docker',
    async execute(request) {
      if (request.workspace.includes(',')) throw new Error('Docker mount paths cannot contain commas.')
      const name = `friday-${randomUUID()}`
      const args = ['run', '--rm', '--pull=never', '--name', name, '--network', options.network ?? 'none',
        '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=256', '--memory', options.memory ?? '1g', '--cpus=2',
        '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m', '--workdir', '/workspace',
        '--mount', `type=bind,src=${request.workspace},dst=/workspace${request.readOnly ? ',readonly' : ''}`,
        options.image, 'sh', '-c', request.command]
      try {
        return await runShell(request.workspace, '', request.timeoutSeconds, request.signal, request.onProgress, request.spillPath, { file: 'docker', args })
      } finally {
        await runShell(request.workspace, '', 10, undefined, undefined, undefined, { file: 'docker', args: ['rm', '-f', name] }).catch(() => {})
      }
    }
  }
}
