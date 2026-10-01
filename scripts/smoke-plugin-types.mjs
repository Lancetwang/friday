import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const declaration = join(root, 'dist', 'plugin.d.ts')
assert.doesNotMatch(await readFile(declaration, 'utf8'), /from ['"]friday-agent-protocol['"]/, 'Published plugin types must not require a private workspace package.')
const temporary = await mkdtemp(join(tmpdir(), 'friday-plugin-types-'))
try {
  const consumer = join(temporary, 'consumer.ts')
  await writeFile(consumer, `import type { FridayPlugin, PluginModelConfig } from 'friday-agent/plugin'
const capabilities: PluginModelConfig['capabilities'] = { api: 'responses', tools: true, reasoning: { mode: 'effort', options: ['low', 'high'], default: 'low' } }
const plugin: FridayPlugin = { name: 'portable-contract', memory: { async prepare() { return { warnings: ['optional capture failed'] } } } }
void capabilities; void plugin
`)
  const options = { strict: true, noEmit: true, skipLibCheck: false, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: ['node'], typeRoots: [join(root, 'node_modules', '@types')] }
  const host = ts.createCompilerHost(options)
  host.resolveModuleNames = (names, containing) => names.map(name => {
    if (name === 'friday-agent-protocol') return undefined // Deliberately unavailable in a consumer install.
    if (name === 'friday-agent/plugin') return { resolvedFileName: declaration, extension: ts.Extension.Dts }
    return ts.resolveModuleName(name, containing, options, host).resolvedModule
  })
  const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([consumer], options, host))
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCurrentDirectory: () => root, getCanonicalFileName: value => value, getNewLine: () => '\n' }))
  console.log('Published plugin types compile without the internal protocol package.')
} finally { await rm(temporary, { recursive: true, force: true }) }
