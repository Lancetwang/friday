import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, 'dist')
mkdirSync(output, { recursive: true })

const devtoolsStub = {
  name: 'omit-ink-devtools',
  setup(builder) {
    builder.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: 'devtools', namespace: 'friday-empty' }))
    builder.onLoad({ filter: /.*/, namespace: 'friday-empty' }, () => ({
      contents: 'export default { initialize() {}, connectToDevTools() {} }',
      loader: 'js'
    }))
  }
}

for (const [entry, name] of [
  [join(root, 'ui-tui', 'dist', 'entry.js'), 'friday.js'],
  [join(root, 'packages', 'harness', 'dist', 'gateway.js'), 'gateway.js']
]) {
  const target = join(output, name)
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: output,
    naming: name,
    target: 'node',
    minify: true,
    plugins: name === 'friday.js' ? [devtoolsStub] : []
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
  if (!existsSync(target)) throw new Error(`Bun did not produce ${target}`)
  if (process.platform !== 'win32') chmodSync(target, 0o755)
}
