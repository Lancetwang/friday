import { readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { Tool } from 'friday-agent-core'

import { fridayHome } from './config.js'

/**
 * Friday plugins keep the runtime core a plain executor: everything a plugin
 * adds travels through the same seams the built-in capabilities use - the
 * tool list the Agent receives and the system prompt the session composes.
 *
 * A plugin is one ES module whose default export describes the extension:
 *
 *   export default {
 *     name: 'ticket-lookup',
 *     version: '1.0.0',
 *     description: 'Looks tickets up in the local tracker.',
 *     instructions: 'Use the Ticket tool when the user names a ticket id.',
 *     tools({ workspace }) { return [{ name: 'Ticket', ... }] },
 *     wrapTool({ workspace }, tool) { return { ...tool, execute: ... } }
 *   }
 *
 * Plugins are local code executed with Friday's own privileges, exactly like
 * anything else on the user's machine; they are trusted by installation, not
 * sandboxed. The verifier tool set never includes plugin tools so Goal-mode
 * verification keeps its read-only guarantee.
 */
export type PluginApi = {
  workspace: string
}

export type FridayPluginModule = {
  name: string
  version?: string
  description?: string
  /** Appended to the system prompt as a `## Plugin: <name>` section. */
  instructions?: string
  /** Extra tools for the agent. Built-in names win collisions. */
  tools?: (api: PluginApi) => Tool[]
  /**
   * Middleware over every tool, built-in and plugin alike. The wrapper must
   * preserve the tool's name and schema; a wrapper that changes either is
   * discarded and recorded as a plugin error.
   */
  wrapTool?: (api: PluginApi, tool: Tool) => Tool
}

export type LoadedPlugin = {
  name: string
  version: string
  description: string
  scope: 'project' | 'user'
  source: string
  instructions: string
  toolNames: string[]
  errors: string[]
  module: FridayPluginModule | undefined
}

export function pluginRoots(workspace: string): Array<['project' | 'user', string]> {
  return [
    ['project', join(resolve(workspace), '.friday', 'plugins')],
    ['user', join(fridayHome(), 'plugins')]
  ]
}

/**
 * Load every plugin module for a workspace. A broken plugin never breaks the
 * session: its failure is captured on the entry and the rest keep loading.
 * Project plugins shadow user plugins with the same name.
 */
export async function loadPlugins(workspace: string): Promise<LoadedPlugin[]> {
  if (process.env.FRIDAY_DISABLE_PLUGINS === '1') return []
  const found = new Map<string, LoadedPlugin>()
  for (const [scope, root] of pluginRoots(workspace)) {
    let entries: string[]
    try {
      entries = readdirSync(root).filter(name => /\.(mjs|js)$/.test(name)).sort()
    } catch {
      continue
    }
    for (const entry of entries) {
      const source = join(root, entry)
      const loaded = await loadPlugin(source, scope)
      const key = loaded.name.toLowerCase()
      if (!found.has(key)) found.set(key, loaded)
    }
  }
  return [...found.values()].sort((left, right) => left.name.localeCompare(right.name))
}

async function loadPlugin(source: string, scope: 'project' | 'user'): Promise<LoadedPlugin> {
  const fallbackName = source.split(/[\\/]/).pop()!.replace(/\.(mjs|js)$/, '')
  const entry: LoadedPlugin = {
    name: fallbackName,
    version: '',
    description: '',
    scope,
    source,
    instructions: '',
    toolNames: [],
    errors: [],
    module: undefined
  }
  try {
    // The mtime query defeats the ESM module cache so a fresh session sees
    // edited plugin code without restarting the gateway process.
    const stamp = statSync(source).mtimeMs
    const imported: unknown = await import(`${pathToFileURL(source).href}?mtime=${stamp}`)
    const module = (imported as { default?: unknown }).default
    if (!module || typeof module !== 'object') throw new Error('default export must be a plugin object')
    const plugin = module as Partial<FridayPluginModule>
    if (typeof plugin.name !== 'string' || !plugin.name.trim()) throw new Error('plugin.name must be a non-empty string')
    if (plugin.tools !== undefined && typeof plugin.tools !== 'function') throw new Error('plugin.tools must be a function returning tools')
    if (plugin.wrapTool !== undefined && typeof plugin.wrapTool !== 'function') throw new Error('plugin.wrapTool must be a function')
    entry.name = plugin.name.trim()
    entry.version = typeof plugin.version === 'string' ? plugin.version : ''
    entry.description = typeof plugin.description === 'string' ? plugin.description : ''
    entry.instructions = typeof plugin.instructions === 'string' ? plugin.instructions.trim() : ''
    entry.module = plugin as FridayPluginModule
  } catch (error) {
    entry.errors.push(error instanceof Error ? error.message : String(error))
  }
  return entry
}

/**
 * Apply the loaded plugins to the built-in tool list: first every plugin's
 * `wrapTool` middleware over every tool, then each plugin's own tools. The
 * result is what the Agent receives. Name collisions resolve toward whatever
 * is already registered - built-ins cannot be replaced, and earlier plugins
 * cannot be replaced by later ones - because silently swapping a tool the
 * model already knows is how prompt-injection-shaped bugs are born.
 */
export function applyPlugins(builtins: Tool[], plugins: LoadedPlugin[], api: PluginApi): Tool[] {
  let tools = builtins
  for (const plugin of plugins) {
    const wrap = plugin.module?.wrapTool
    if (!wrap) continue
    tools = tools.map(tool => {
      try {
        const wrapped = wrap(api, tool)
        if (!wrapped || typeof wrapped.execute !== 'function') throw new Error('wrapper returned no executable tool')
        if (wrapped.name !== tool.name || wrapped.description !== tool.description || wrapped.parameters !== tool.parameters) {
          throw new Error('wrapper changed the tool name or schema')
        }
        return wrapped
      } catch (error) {
        plugin.errors.push(`wrapTool(${tool.name}): ${error instanceof Error ? error.message : String(error)}`)
        return tool
      }
    })
  }
  const known = new Set(tools.map(tool => tool.name))
  for (const plugin of plugins) {
    const factory = plugin.module?.tools
    if (!factory) continue
    let contributed: Tool[]
    try {
      contributed = factory(api)
      if (!Array.isArray(contributed)) throw new Error('tools() must return an array')
    } catch (error) {
      plugin.errors.push(`tools(): ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    for (const tool of contributed) {
      if (!tool || typeof tool.name !== 'string' || !tool.name || typeof tool.execute !== 'function') {
        plugin.errors.push('tools(): every tool needs a name and an execute function')
        continue
      }
      if (known.has(tool.name)) {
        plugin.errors.push(`tools(): tool name already registered: ${tool.name}`)
        continue
      }
      known.add(tool.name)
      tools = [...tools, tool]
      plugin.toolNames.push(tool.name)
    }
  }
  return tools
}

/** System prompt sections contributed by plugins, ready for buildInstructions. */
export function pluginInstructionSections(plugins: LoadedPlugin[]): Array<[string, string]> {
  return plugins.flatMap(plugin =>
    plugin.instructions ? [[`Plugin: ${plugin.name}`, plugin.instructions] as [string, string]] : []
  )
}

/** Metadata for the gateway and UIs; the live module stays private. */
export function pluginInfo(plugins: LoadedPlugin[]): Array<Record<string, unknown>> {
  return plugins.map(plugin => ({
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
    scope: plugin.scope,
    source: plugin.source,
    tools: [...plugin.toolNames],
    has_instructions: !!plugin.instructions,
    errors: [...plugin.errors]
  }))
}
