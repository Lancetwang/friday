import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadPlugins, pluginRoots, trustPlugin } from './plugins.js'

/** Test fixture installation is an explicit trusted-code action. */
export async function installFixturePlugins(workspace: string): Promise<void> {
  for (const [, root] of pluginRoots(workspace)) {
    for (const file of await readdir(root).catch(() => [])) {
      if (!/\.(mjs|js)$/.test(file)) continue
      const name = file.replace(/\.(mjs|js)$/, '')
      await writeFile(join(root, `${name}.plugin.json`), JSON.stringify({ api_version: 1, name }))
    }
  }
  for (const plugin of await loadPlugins(workspace, false)) if (plugin.digest && plugin.trusted === false) await trustPlugin(workspace, plugin.name, plugin.digest)
}
