import { execFileSync, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const triple = execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim()
const extension = triple.includes('windows') ? '.exe' : ''
const binary = join(root, 'ui-desktop', 'src-tauri', 'binaries', `friday-app-server-${triple}${extension}`)
if (!existsSync(binary)) throw new Error(`Friday sidecar not found: ${binary}`)

const temporary = await mkdtemp(join(tmpdir(), 'friday-sidecar-'))
const home = join(temporary, 'home')
const workspace = join(temporary, 'workspace')
await mkdir(home)
await mkdir(workspace)
const child = spawn(binary, [], {
  cwd: workspace,
  env: { ...process.env, FRIDAY_HOME: home },
  stdio: ['pipe', 'pipe', 'pipe']
})
const stderr = []
createInterface({ input: child.stderr }).on('line', line => stderr.push(line))

try {
  const answer = new Promise((resolveAnswer, reject) => {
    const timeout = setTimeout(() => reject(new Error('Sidecar did not answer within 30 seconds.')), 30_000)
    const state = { ready: false, answered: false }
    createInterface({ input: child.stdout }).on('line', line => {
      let message
      try { message = JSON.parse(line) } catch { return }
      if (message.method === 'event' && message.params?.type === 'gateway.ready') state.ready = true
      if (message.id === 'smoke-1' && !message.error) state.answered = true
      if (message.id === 'smoke-1' && message.error) reject(new Error(String(message.error.message || 'Gateway error.')))
      if (state.ready && state.answered) {
        clearTimeout(timeout)
        resolveAnswer(state)
      }
    })
    child.once('exit', code => reject(new Error(`Sidecar exited early (${code ?? 'signal'}).`)))
  })
  child.stdin.write(`${JSON.stringify({ id: 'smoke-1', jsonrpc: '2.0', method: 'session.current', params: {} })}\n`)
  await answer
  process.stdout.write('Friday sidecar smoke test passed.\n')
} catch (error) {
  if (stderr.length && error instanceof Error) error.message += `\n${stderr.slice(-40).join('\n')}`
  throw error
} finally {
  child.kill()
  if (child.exitCode === null && child.signalCode === null) await new Promise(resolveExit => child.once('exit', resolveExit))
  await rm(temporary, { recursive: true, force: true })
}
