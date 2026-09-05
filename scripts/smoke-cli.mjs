import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

// Also accepts an installed friday-agent package directory for release validation.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageDir = resolve(process.argv[2] || root)
const { version } = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
const temporary = await mkdtemp(join(tmpdir(), 'friday-cli-smoke-'))
const home = join(temporary, 'home')
const workspace = join(temporary, 'workspace')
const linkedPackage = join(temporary, 'linked-package')
const pending = new Map()
let child
let closed
let stderr = ''
let sequence = 0

try {
  await mkdir(home)
  await mkdir(workspace)
  await symlink(packageDir, linkedPackage, 'junction')
  const installedVersion = execFileSync(process.execPath, [join(linkedPackage, 'dist', 'friday.js'), '--version'], { encoding: 'utf8' }).trim()
  assert.equal(installedVersion, version)
  child = spawn(process.execPath, [join(linkedPackage, 'dist', 'gateway.js')], {
    cwd: workspace,
    env: { ...process.env, FRIDAY_HOME: home, FRIDAY_CWD: workspace, FRIDAY_DISABLE_PLUGINS: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  closed = new Promise(resolveClose => child.once('close', resolveClose))
  child.stderr.on('data', value => { stderr += value })
  createInterface({ input: child.stdout }).on('line', line => {
    let message
    try { message = JSON.parse(line) } catch { return }
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    clearTimeout(waiter.timer)
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
    else waiter.resolve(message.result)
  })
  child.once('error', rejectPending)
  child.once('close', code => rejectPending(new Error(`Gateway exited ${code}: ${stderr}`)))

  const current = await request('session.current')
  assert(current.info.session_id)
  const toggled = await request('plugin.toggle', { name: 'web', enabled: false })
  assert(toggled.plugins.some(plugin => plugin.name === 'web' && plugin.disabled))
  const reloaded = await request('plugin.reload')
  assert(reloaded.plugins.some(plugin => plugin.name === 'web' && plugin.disabled))
  const listed = await request('session.list', { offset: 0, limit: 10 })
  assert(Array.isArray(listed.choices))

  child.stdin.end()
  let timer
  try {
    const exitCode = await Promise.race([
      closed,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Gateway shutdown timed out.')), 5_000) })
    ])
    assert.equal(exitCode, 0)
  } finally { clearTimeout(timer) }
  console.log(`Friday ${version} CLI smoke passed: symlink startup, session RPC, locked settings, plugin reload and shutdown.`)
} finally {
  rejectPending(new Error('CLI smoke test ended.'))
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await closed
  }
  await rm(temporary, { recursive: true, force: true })
}

function request(method, params = {}) {
  return new Promise((resolveRequest, reject) => {
    const id = `smoke-${++sequence}`
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Timeout for ${method}: ${stderr}`))
    }, 15_000)
    pending.set(id, { resolve: resolveRequest, reject, timer })
    child.stdin.write(JSON.stringify({ id, jsonrpc: '2.0', protocol_version: 1, method, params }) + '\n')
  })
}

function rejectPending(error) {
  for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error) }
  pending.clear()
}
