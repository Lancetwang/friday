import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

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
    external: name === 'gateway.js' ? ['friday-agent-core'] : [],
    plugins: name === 'friday.js' ? [devtoolsStub] : []
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
  if (!existsSync(target)) throw new Error(`Bun did not produce ${target}`)
  if (process.platform !== 'win32') chmodSync(target, 0o755)
}

copyFileSync(join(root, 'packages', 'harness', 'dist', 'plugin-api.js'), join(output, 'plugin.js'))

// Protocol is an internal workspace package. Inline its referenced wire aliases
// so the published plugin contract needs only the public Core dependency.
let declaration = readFileSync(join(root, 'packages', 'harness', 'dist', 'plugin-api.d.ts'), 'utf8')
const protocol = readFileSync(join(root, 'packages', 'protocol', 'src', 'index.ts'), 'utf8')
const protocolAst = ts.createSourceFile('protocol.ts', protocol, ts.ScriptTarget.Latest, true)
const aliases = new Map(protocolAst.statements.filter(ts.isTypeAliasDeclaration).map(node => [node.name.text, node]))
const imported = new Set()
const declarationAst = ts.createSourceFile('plugin.d.ts', declaration, ts.ScriptTarget.Latest, true)
const imports = declarationAst.statements.filter(node => ts.isImportDeclaration(node) && node.moduleSpecifier.text === 'friday-agent-protocol')
for (const node of imports) {
  for (const element of node.importClause?.namedBindings?.elements ?? []) imported.add(element.name.text)
}
const inlined = new Map()
function inline(name) {
  if (inlined.has(name)) return
  const node = aliases.get(name)
  if (!node) throw new Error(`Cannot inline protocol type: ${name}`)
  inlined.set(name, node.getText(protocolAst))
  function visit(child) {
    if (ts.isTypeReferenceNode(child) && ts.isIdentifier(child.typeName) && aliases.has(child.typeName.text)) inline(child.typeName.text)
    ts.forEachChild(child, visit)
  }
  visit(node)
}
for (const name of imported) inline(name)
for (const node of [...imports].reverse()) declaration = declaration.slice(0, node.getFullStart()) + declaration.slice(node.getEnd())
writeFileSync(join(output, 'plugin.d.ts'), [...inlined.values()].join('\n') + '\n' + declaration)
