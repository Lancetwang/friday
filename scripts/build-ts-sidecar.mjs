import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const triple = execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim()
const targets = {
  'x86_64-pc-windows-msvc': 'bun-windows-x64',
  'aarch64-pc-windows-msvc': 'bun-windows-arm64',
  'x86_64-apple-darwin': 'bun-darwin-x64',
  'aarch64-apple-darwin': 'bun-darwin-arm64',
  'x86_64-unknown-linux-gnu': 'bun-linux-x64',
  'aarch64-unknown-linux-gnu': 'bun-linux-arm64'
}
const target = targets[triple]
if (!target) throw new Error(`Unsupported sidecar target: ${triple}`)

const bun = join(root, 'node_modules', 'bun', 'bin', 'bun.exe')
if (!existsSync(bun)) throw new Error('Bun is not installed. Run npm ci at the repository root.')
const directory = join(root, 'ui-desktop', 'src-tauri', 'binaries')
const extension = triple.includes('windows') ? '.exe' : ''
const output = join(directory, `friday-ts-app-server-${triple}${extension}`)
mkdirSync(directory, { recursive: true })

const result = spawnSync(bun, [
  'build',
  join(root, 'packages', 'harness', 'dist', 'sidecar.js'),
  '--compile',
  `--target=${target}`,
  `--outfile=${output}`,
  '--minify'
], { cwd: root, stdio: 'inherit' })
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
if (!existsSync(output)) throw new Error(`Bun did not produce the expected sidecar: ${output}`)
process.stdout.write(`${output}\n`)
