import { readFile } from 'node:fs/promises'

const root = await json('package.json')
const version = String(root.version)
const manifests = [
  'packages/core/package.json',
  'packages/harness/package.json',
  'packages/protocol/package.json',
  'ui-tui/package.json',
  'ui-desktop/package.json',
  'ui-desktop/src-tauri/tauri.conf.json'
]

for (const path of manifests) {
  const value = await json(path)
  if (value.version !== version) fail(path)
}

const harness = await json('packages/harness/package.json')
const tui = await json('ui-tui/package.json')
if (root.dependencies?.['friday-agent-core'] !== version) fail('package.json dependency')
if (harness.dependencies?.['friday-agent-core'] !== version) fail('packages/harness/package.json core dependency')
if (harness.dependencies?.['friday-agent-protocol'] !== version) fail('packages/harness/package.json protocol dependency')
if (tui.dependencies?.['friday-agent-protocol'] !== version) fail('ui-tui/package.json protocol dependency')

const checks = [
  ['ui-tui/src/cli.ts', new RegExp(`VERSION = ['\"]${escape(version)}['\"]`)],
  ['ui-desktop/src-tauri/Cargo.toml', new RegExp(`version = ['\"]${escape(version)}['\"]`)],
  ['integrations/harbor/friday.py', new RegExp(`friday-agent@${escape(version)}`)]
]
for (const [path, pattern] of checks) {
  if (!pattern.test(await text(path))) fail(path)
}

async function json(path) {
  return JSON.parse(await text(path))
}

function text(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8')
}

function fail(path) {
  throw new Error(`${path} does not match package version ${version}.`)
}

function escape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
