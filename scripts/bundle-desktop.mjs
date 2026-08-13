import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = { darwin: 'dmg', linux: 'deb', win32: 'nsis' }[process.platform]
if (!bundle) throw new Error(`Unsupported desktop platform: ${process.platform}`)

const desktop = join(root, 'ui-desktop')
const tauri = join(desktop, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')
const result = spawnSync(process.execPath, [
  tauri, 'build', '--features', 'typescript-sidecar',
  '--config', 'src-tauri/tauri.typescript.conf.json', '--bundles', bundle
], { cwd: desktop, stdio: 'inherit' })
if (result.error) throw result.error
process.exit(result.status ?? 1)
