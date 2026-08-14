import { readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { Tool } from 'friday-agent-core'

import { fridayHome } from './config.js'

/**
 * In Friday, everything outside the core model/tool loop is a plugin. The
 * built-in capabilities - workspace tools, web access, memory, skills - are
 * plugins Friday ships with; external plugins are the same shape loaded from
 * disk. Both reach the agent through the only two seams that exist: the tool
 * list the loop receives and the system prompt the session composes. The
 * difference between "shipped with Friday" and "added by you" is packaging,
 * not architecture.
 *
 * An external plugin is one ES module whose default export is this shape:
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
 * sandboxed. The Goal-mode verifier assembles only from built-in plugins and
 * their declared read-only tools, so verification cannot be steered by the
 * code it is checking.
 */
export type PluginApi = {
  workspace: string
}

export type FridayPluginModule = {
  name: string
  version?: string
  description?: string
  /**
   * A system prompt section. A function is re-evaluated every time the
   * prompt is rebuilt, so a plugin can reflect current on-disk state - the
   * built-in skills plugin uses this to keep its routing list fresh.
   */
  instructions?: string | ((api: PluginApi) => string)
  /** Extra tools for the agent. Names already registered win collisions. */
  tools?: (api: PluginApi) => Tool[]
  /**
   * Middleware over every assembled tool. The wrapper must preserve the
   * tool's name and schema; a wrapper that changes either is discarded and
   * recorded as a plugin error.
   */
  wrapTool?: (api: PluginApi, tool: Tool) => Tool
  /** Built-in only: the plugin cannot be disabled (the workspace tools). */
  required?: boolean
  /** Built-in only: tool names safe for the read-only Goal verifier. */
  verifierTools?: readonly string[]
}

export type LoadedPlugin = {
  name: string
  version: string
  description: string
  scope: 'builtin' | 'project' | 'user'
  source: string
  disabled: boolean
  toolNames: string[]
  errors: string[]
  module: FridayPluginModule | undefined
}

/** Wrap a built-in capability module as a registered plugin. */
export function builtinPlugin(module: FridayPluginModule): LoadedPlugin {
  return {
    name: module.name,
    version: module.version ?? '',
    description: module.description ?? '',
    scope: 'builtin',
    source: 'builtin',
    disabled: false,
    toolNames: [],
    errors: [],
    module
  }
}

export function pluginRoots(workspace: string): Array<['project' | 'user', string]> {
  return [
    ['project', join(resolve(workspace), '.friday', 'plugins')],
    ['user', join(fridayHome(), 'plugins')]
  ]
}

/**
 * Load every external plugin module for a workspace. A broken plugin never
 * breaks the session: its failure is captured on the entry and the rest keep
 * loading. Project plugins shadow user plugins with the same name.
 * FRIDAY_DISABLE_PLUGINS=1 skips external plugins entirely (built-ins are
 * governed by the disabled-plugins list instead).
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
    disabled: false,
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
    if (plugin.instructions !== undefined && typeof plugin.instructions !== 'string' && typeof plugin.instructions !== 'function') {
      throw new Error('plugin.instructions must be a string or a function')
    }
    entry.name = plugin.name.trim()
    entry.version = typeof plugin.version === 'string' ? plugin.version : ''
    entry.description = typeof plugin.description === 'string' ? plugin.description : ''
    // `required` and `verifierTools` are host guarantees, not plugin claims.
    const { required: _required, verifierTools: _verifier, ...kept } = plugin
    entry.module = kept as FridayPluginModule
  } catch (error) {
    entry.errors.push(error instanceof Error ? error.message : String(error))
  }
  return entry
}

/**
 * Mark plugins the user turned off. Required built-ins refuse: the refusal is
 * recorded on the plugin so /plugins shows why the switch did nothing.
 */
export function markDisabled(plugins: LoadedPlugin[], disabled: ReadonlySet<string>): LoadedPlugin[] {
  for (const plugin of plugins) {
    if (!disabled.has(plugin.name.toLowerCase())) continue
    if (plugin.module?.required) {
      plugin.errors.push('this plugin is required and cannot be disabled')
      continue
    }
    plugin.disabled = true
  }
  return plugins
}

/**
 * Assemble the agent's tool list from the plugin registry: collect every
 * enabled plugin's tools in registration order, then apply every enabled
 * plugin's `wrapTool` middleware over the whole set. Name collisions resolve
 * toward whatever registered first - built-ins precede external plugins, so
 * a plugin cannot shadow a tool the model already knows; silently swapping
 * one is how prompt-injection-shaped bugs are born.
 */
export function assembleTools(plugins: LoadedPlugin[], api: PluginApi): Tool[] {
  let tools: Tool[] = []
  const known = new Set<string>()
  for (const plugin of plugins) {
    const factory = plugin.module?.tools
    plugin.toolNames = []
    if (plugin.disabled || !factory) continue
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
      tools.push(tool)
      plugin.toolNames.push(tool.name)
    }
  }
  for (const plugin of plugins) {
    const wrap = plugin.module?.wrapTool
    if (plugin.disabled || !wrap) continue
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
  return tools
}

/**
 * System prompt sections from enabled plugins, in registration order.
 * Built-in sections keep their plain product names ("Skills"); external
 * sections are prefixed so the model can tell whose voice it is reading.
 */
export function pluginSections(plugins: LoadedPlugin[], api: PluginApi): Array<[string, string]> {
  return plugins.flatMap(plugin => {
    const instructions = plugin.module?.instructions
    if (plugin.disabled || instructions === undefined) return []
    let body: string
    try {
      body = typeof instructions === 'function' ? instructions(api) : instructions
    } catch (error) {
      plugin.errors.push(`instructions(): ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
    if (typeof body !== 'string' || !body.trim()) return []
    const title = plugin.scope === 'builtin'
      ? plugin.name[0]!.toUpperCase() + plugin.name.slice(1)
      : `Plugin: ${plugin.name}`
    return [[title, body.trim()] as [string, string]]
  })
}

/** Metadata for the gateway and UIs; the live module stays private. */
export function pluginInfo(plugins: LoadedPlugin[]): Array<Record<string, unknown>> {
  return plugins.map(plugin => ({
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
    scope: plugin.scope,
    source: plugin.source,
    disabled: plugin.disabled,
    required: plugin.module?.required === true,
    tools: [...plugin.toolNames],
    has_instructions: plugin.module?.instructions !== undefined,
    errors: [...plugin.errors]
  }))
}
