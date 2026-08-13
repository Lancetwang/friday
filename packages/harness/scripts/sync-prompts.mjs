import { readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = resolve(packageRoot, '../../src/friday/prompt_templates')
const output = join(packageRoot, 'src/prompt-assets.ts')
const assets = Object.fromEntries(readdirSync(sourceRoot)
  .filter(name => name.endsWith('.md'))
  .sort()
  .map(name => [name, readFileSync(join(sourceRoot, name), 'utf8')]))
const generated = `// Generated from src/friday/prompt_templates by scripts/sync-prompts.mjs.\nexport const promptAssets: Readonly<Record<string, string>> = ${JSON.stringify(assets, null, 2)}\n`

if (process.argv.includes('--check')) {
  if (readFileSync(output, 'utf8') !== generated) {
    throw new Error('Bundled prompt assets are stale. Run npm run prompts -w friday-agent-harness.')
  }
} else {
  const temporary = `${output}.${process.pid}.tmp`
  writeFileSync(temporary, generated)
  renameSync(temporary, output)
}
