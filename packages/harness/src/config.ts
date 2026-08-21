import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import type {
  CompactionSettings,
  DiscoveredModel,
  ModelCatalog,
  ModelProfile,
  ModelProvider
} from 'friday-agent-protocol'

import { writeJsonAtomic } from './storage.js'
import { localTimestamp } from './time.js'

export type { CompactionSettings, DiscoveredModel, ModelCatalog, ModelProfile, ModelProvider } from 'friday-agent-protocol'

export type ModelConfig = {
  profileId: string
  profileName: string
  provider: string
  model: string
  baseUrl: string
  /** Advisory positive hint; the provider remains the authority for images. */
  vision?: boolean
  contextWindow: number
  maxOutputTokens: number
  apiKey: string
}

type StoredProfile = {
  id?: unknown
  name?: unknown
  provider?: unknown
  model?: unknown
  base_url?: unknown
  vision?: unknown
  context_window?: unknown
  max_output_tokens?: unknown
  run_token_budget?: unknown
  auto?: unknown
}

type ProviderDefinition = Omit<ModelProvider, 'api_key_configured' | 'enabled'>
type ValidProfile = Omit<ModelProfile, 'api_key_configured' | 'enabled'>

const PROVIDERS: readonly ProviderDefinition[] = [
  {
    id: 'deepseek', label: 'DeepSeek', builtin: true, base_url: 'https://api.deepseek.com',
    models: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }]
  },
  {
    id: 'mimo', label: 'Xiaomi MiMo', builtin: true, base_url: 'https://api.xiaomimimo.com/v1',
    models: [{ id: 'mimo-v2.5', vision: true }, { id: 'mimo-v2.5-pro' }]
  },
  {
    id: 'openai', label: 'OpenAI', builtin: true, base_url: 'https://api.openai.com/v1',
    models: [{ id: 'gpt-5.1', vision: true }, { id: 'gpt-5-mini', vision: true }, { id: 'gpt-4.1', vision: true }]
  },
  {
    id: 'anthropic', label: 'Anthropic', builtin: true, base_url: 'https://api.anthropic.com',
    models: [{ id: 'claude-sonnet-4-20250514', vision: true }, { id: 'claude-opus-4-20250514', vision: true }]
  },
  {
    id: 'opencode-go', label: 'OpenCode Go', builtin: true, base_url: 'https://opencode.ai/zen/go/v1',
    models: [
      ['grok-4.5', true], ['gpt-5.6-luna', true], ['glm-5.2', false], ['glm-5.1', false],
      ['kimi-k3', true], ['kimi-k2.7-code', true], ['kimi-k2.6', true],
      ['deepseek-v4-pro', false], ['deepseek-v4-flash', false], ['mimo-v2.5', true],
      ['mimo-v2.5-pro', false], ['minimax-m3', true], ['minimax-m2.7', false],
      ['minimax-m2.5', false], ['qwen3.8-max', true], ['qwen3.7-max', false],
      ['qwen3.7-plus', true], ['qwen3.6-plus', true], ['hy3', false]
    ].map(([id, vision]) => ({ id: String(id), ...(vision ? { vision: true } : {}) }))
  },
  { id: 'openai-compatible', label: 'OpenAI Compatible', builtin: false, base_url: '', models: [] }
]

const DEFAULTS = {
  provider: 'deepseek', model: 'deepseek-v4-flash', base_url: 'https://api.deepseek.com',
  context_window: 1_000_000, max_output_tokens: 65_536, run_token_budget: 40_000_000
}
const DEFAULT_COMPACTION: CompactionSettings = {
  automatic: true,
  threshold_percent: 85,
  strategy: 'insert'
}
const modelWrites = new Map<string, Promise<void>>()

export function fridayHome(): string {
  return resolve(process.env.FRIDAY_HOME || join(homedir(), '.friday'))
}

export function loadModelConfig(workspace: string, requestedProfile?: string): ModelConfig {
  const catalog = loadModelCatalog(workspace)
  const available = catalog.profiles.filter(profile => profile.enabled)
  const candidates = available.length ? available : catalog.profiles
  const profile = candidates.find(value => value.id === (requestedProfile || catalog.active)) ?? candidates[0]
  if (!profile) throw new Error('Friday needs at least one model configuration.')
  const credentials = credentialsObject()
  return {
    profileId: profile.id,
    profileName: profile.name,
    provider: profile.provider,
    model: profile.model,
    baseUrl: profile.base_url,
    ...(profile.vision === true ? { vision: true } : {}),
    contextWindow: profile.context_window,
    maxOutputTokens: profile.max_output_tokens,
    apiKey: text(credentials[profile.id], providerKey(profile.provider))
  }
}

export function loadModelCatalog(workspace: string): ModelCatalog {
  const base = baseConfig(workspace)
  const saved = readObject(join(fridayHome(), 'models.json'))
  const raw = Array.isArray(saved.profiles) ? saved.profiles.filter(isObject) as StoredProfile[] : []
  const profiles = raw.flatMap(value => {
    try { return [validateProfile(value, base)] } catch { return [] }
  })
  if (!profiles.length) profiles.push(defaultProfile(base))
  const credentials = credentialsObject()
  const disabled = new Set(strings(saved.disabled))
  const decorated: ModelProfile[] = profiles.map(profile => {
    const configured = !!text(credentials[profile.id], providerKey(profile.provider))
    return {
      ...profile,
      api_key_configured: configured,
      enabled: configured && !disabled.has(profileTarget(profile)) && !disabled.has(`profile:${profile.id}`)
    }
  })
  const enabled = decorated.filter(profile => profile.enabled)
  let active = text(saved.active)
  if (enabled.length && !enabled.some(profile => profile.id === active)) active = enabled[0]!.id
  else if (!decorated.some(profile => profile.id === active)) active = decorated[0]!.id
  return {
    active,
    disabled: [...disabled].sort(),
    profiles: decorated,
    providers: PROVIDERS.map(provider => {
      const providerProfiles = decorated.filter(profile => profile.provider === provider.id)
      const configured = providerProfiles.some(profile => profile.api_key_configured) || !!providerKey(provider.id)
      return {
        ...provider,
        models: provider.models.map(model => ({ ...model })),
        api_key_configured: configured,
        enabled: configured && (provider.builtin
          ? !disabled.has(`provider:${provider.id}`)
          : providerProfiles.some(profile => profile.enabled))
      }
    })
  }
}

export async function saveModelProfile(
  workspace: string,
  value: Record<string, unknown>,
  options: { apiKey?: string; clearApiKey?: boolean; activate?: boolean } = {}
): Promise<ModelCatalog> {
  return withModelWrite(async () => {
    const base = baseConfig(workspace)
    const catalog = loadModelCatalog(workspace)
    const id = profileId(text(value.id) || randomUUID().replaceAll('-', '').slice(0, 12))
    const profile = validateProfile({ ...value, id }, base)
    const provider = providerDefinition(profile.provider)
    const key = options.apiKey?.trim() || ''
    let profiles = catalog.profiles.map(storedProfile)
    const credentials = credentialsObject()
    const disabled = new Set(catalog.disabled)
    const explicit = !!profile.model

    if (explicit) {
      const index = profiles.findIndex(item => item.id === profile.id)
      if (index < 0) profiles.push(profile)
      else profiles[index] = profile
    }
    if (provider.builtin && key) {
      let models: DiscoveredModel[] | undefined
      try {
        models = await fetchProviderModels(provider.id, provider.base_url, key)
      } catch (error) {
        if (isRejectedKey(error)) throw error
      }
      profiles = syncBuiltin(provider, models, profiles, base, credentials, key).profiles
    } else if (provider.builtin && options.clearApiKey) {
      for (const item of profiles) if (item.provider === provider.id) delete credentials[item.id]
    } else if (options.clearApiKey) delete credentials[profile.id]
    else if (key) credentials[profile.id] = key

    const target = profileTarget(profile)
    if (key) {
      disabled.delete(target)
      disabled.delete(`profile:${profile.id}`)
    }
    else if (options.clearApiKey) disabled.add(target)
    if (!profiles.length) profiles = [defaultProfile(base)]
    for (const stored of Object.keys(credentials)) {
      if (!profiles.some(profile => profile.id === stored)) delete credentials[stored]
    }
    let active = catalog.active
    if (options.activate !== false) {
      active = explicit
        ? profile.id
        : profiles.find(item => item.provider === profile.provider)?.id ?? active
    }
    if (!profiles.some(item => item.id === active)) active = profiles[0]!.id
    await writeModelState(active, profiles, disabled, credentials)
    return loadModelCatalog(workspace)
  })
}

export async function selectModelProfile(workspace: string, id: string): Promise<ModelCatalog> {
  return withModelWrite(async () => {
    const catalog = loadModelCatalog(workspace)
    const selected = catalog.profiles.find(profile => profile.id === id)
    if (!selected) throw new Error(`Unknown Friday model configuration: ${id}`)
    if (!selected.enabled) throw new Error('Enable this model provider before selecting it.')
    await writeModelState(id, catalog.profiles.map(storedProfile), new Set(catalog.disabled), credentialsObject())
    return loadModelCatalog(workspace)
  })
}

export async function deleteModelProfile(workspace: string, id: string): Promise<ModelCatalog> {
  return withModelWrite(async () => {
    const catalog = loadModelCatalog(workspace)
    const profiles = catalog.profiles.filter(profile => profile.id !== id).map(storedProfile)
    if (profiles.length === catalog.profiles.length) throw new Error(`Unknown Friday model configuration: ${id}`)
    if (!profiles.length) throw new Error('Friday needs at least one model configuration.')
    const credentials = credentialsObject()
    delete credentials[id]
    const disabled = new Set(catalog.disabled)
    disabled.delete(`profile:${id}`)
    const active = catalog.active === id ? profiles[0]!.id : catalog.active
    await writeModelState(active, profiles, disabled, credentials)
    return loadModelCatalog(workspace)
  })
}

export function readModelCredential(workspace: string, provider = '', profile = ''): string {
  const catalog = loadModelCatalog(workspace)
  const matches = profile
    ? catalog.profiles.filter(item => item.id === profile)
    : catalog.profiles.filter(item => item.provider === provider)
  if (!provider && !profile) throw new Error('A model provider or profile is required.')
  if (profile && !matches.length) throw new Error(`Unknown Friday model configuration: ${profile}`)
  const credentials = credentialsObject()
  return matches.map(item => text(credentials[item.id])).find(Boolean)
    || providerKey(provider || matches[0]?.provider || '')
}

export async function clearModelCredential(workspace: string, provider = '', profile = ''): Promise<ModelCatalog> {
  return withModelWrite(async () => {
    const catalog = loadModelCatalog(workspace)
    const targets = profile
      ? catalog.profiles.filter(item => item.id === profile)
      : catalog.profiles.filter(item => item.provider === provider)
    if (!provider && !profile) throw new Error('A model provider or profile is required.')
    if (profile && !targets.length) throw new Error(`Unknown Friday model configuration: ${profile}`)
    const credentials = credentialsObject()
    for (const item of targets) delete credentials[item.id]
    const disabled = new Set(catalog.disabled)
    disabled.add(profile ? `profile:${profile}` : `provider:${provider}`)
    const targetIds = new Set(targets.map(item => item.id))
    const remaining = catalog.profiles.filter(item => item.enabled && !targetIds.has(item.id))
    const active = targetIds.has(catalog.active) && remaining.length ? remaining[0]!.id : catalog.active
    await writeModelState(active, catalog.profiles.map(storedProfile), disabled, credentials)
    return loadModelCatalog(workspace)
  })
}

export async function setModelEnabled(
  workspace: string,
  enabled: boolean,
  provider = '',
  profile = ''
): Promise<ModelCatalog> {
  return withModelWrite(async () => {
    const catalog = loadModelCatalog(workspace)
    const targets = profile
      ? catalog.profiles.filter(item => item.id === profile)
      : catalog.profiles.filter(item => item.provider === provider)
    const providerInfo = catalog.providers.find(item => item.id === provider)
    if (!provider && !profile) throw new Error('A model provider or profile is required.')
    if (profile && !targets.length) throw new Error(`Unknown Friday model configuration: ${profile}`)
    if (provider && (!providerInfo || !providerInfo.builtin)) throw new Error(`Unknown built-in model provider: ${provider}`)
    const configured = profile ? !!targets[0]?.api_key_configured : !!providerInfo?.api_key_configured
    if (enabled && !configured) throw new Error('Add an API key before enabling this provider.')
    const target = profile ? `profile:${profile}` : `provider:${provider}`
    const disabled = new Set(catalog.disabled)
    let active = catalog.active
    if (enabled) disabled.delete(target)
    else {
      const targetIds = new Set(targets.map(item => item.id))
      const remaining = catalog.profiles.filter(item => item.enabled && !targetIds.has(item.id))
      if (targetIds.has(active) && !remaining.length) throw new Error('Enable another provider before disabling the active model.')
      disabled.add(target)
      if (targetIds.has(active)) active = remaining[0]!.id
    }
    await writeModelState(active, catalog.profiles.map(storedProfile), disabled, credentialsObject())
    return loadModelCatalog(workspace)
  })
}

export async function refreshModelProfiles(
  workspace: string,
  provider = '',
  profile = ''
): Promise<{ catalog: ModelCatalog; models: string[] }> {
  return withModelWrite(async () => {
    const catalog = loadModelCatalog(workspace)
    const selected = profile ? catalog.profiles.find(item => item.id === profile) : undefined
    if (profile && !selected) throw new Error(`Unknown Friday model configuration: ${profile}`)
    const definition = providerDefinition(provider || selected?.provider || '')
    const key = readModelCredential(workspace, provider, profile)
    if (!key) throw new Error('Add an API key before refreshing models.')
    const baseUrl = selected?.base_url || definition.base_url
    const discovered = await fetchProviderModels(definition.id, baseUrl, key)
    const models = discovered.map(model => model.id)
    if (profile) return { catalog, models }
    if (!definition.builtin) throw new Error(`Unknown built-in model provider: ${provider}`)
    const base = baseConfig(workspace)
    const synced = syncBuiltin(
      definition, discovered, catalog.profiles.map(storedProfile), base, credentialsObject(), key
    )
    await writeModelState(catalog.active, synced.profiles, new Set(catalog.disabled), synced.credentials)
    return { catalog: loadModelCatalog(workspace), models }
  })
}

export async function fetchProviderModels(provider: string, baseUrl: string, apiKey: string): Promise<DiscoveredModel[]> {
  const anthropic = provider === 'anthropic'
  const base = baseUrl.replace(/\/$/, '')
  const endpoint = anthropic
    ? `${base.replace(/\/v1$/, '')}/v1/models`
    : `${base}/models`
  const response = await fetch(endpoint, {
    headers: anthropic
      ? { 'anthropic-version': '2023-06-01', 'x-api-key': apiKey }
      : { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000)
  })
  if (response.status === 401 || response.status === 403) {
    const error = new Error(`API key rejected by ${providerDefinition(provider).label} (HTTP ${response.status}).`)
    error.name = 'AuthenticationError'
    throw error
  }
  if (!response.ok) throw new Error(`Could not list models from ${provider} (HTTP ${response.status}).`)
  const value: unknown = await response.json()
  if (!isObject(value) || !Array.isArray(value.data)) throw new Error(`Invalid model list returned by ${provider}.`)
  const models = new Map<string, DiscoveredModel>()
  for (const item of value.data) {
    if (!isObject(item) || typeof item.id !== 'string' || !item.id.trim()) continue
    const id = item.id.trim()
    const vision = discoveredVision(item)
    const existing = models.get(id)
    if (!existing || vision) models.set(id, { id, ...(vision ? { vision: true } : {}) })
  }
  return [...models.values()].sort((left, right) => left.id.localeCompare(right.id))
}

export function projectStateDir(workspace: string): string {
  const root = resolveWorkspace(workspace)
  const projects = join(fridayHome(), 'projects')
  const direct = join(projects, workspaceKey(root))
  if (existsSync(direct)) return direct
  if (existsSync(projects)) {
    for (const entry of readdirSync(projects, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const record = readObjectOrEmpty(join(projects, entry.name, 'project.json'))
      if (typeof record.workspace === 'string' && samePath(record.workspace, root)) return join(projects, entry.name)
    }
  }
  return direct
}

export async function recordProject(workspace: string, opened?: boolean): Promise<void> {
  const root = resolveWorkspace(workspace)
  const path = join(projectStateDir(root), 'project.json')
  const existing = readObjectOrEmpty(path)
  const inherited = typeof existing.open === 'boolean' ? existing.open : !!existing.workspace
  await writeJsonAtomic(path, {
    workspace: root,
    created: text(existing.created, localTimestamp()),
    updated: localTimestamp(),
    open: opened ?? inherited
  })
}

export function listProjects(openOnly = true): Array<{ workspace: string; updated: string; open: boolean }> {
  const directory = join(fridayHome(), 'projects')
  if (!existsSync(directory)) return []
  const newest = new Map<string, { workspace: string; updated: string; open: boolean }>()
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const value = readObjectOrEmpty(join(directory, entry.name, 'project.json'))
    const stored = text(value.workspace).trim()
    if (!stored) continue
    let workspace: string
    try { workspace = resolveWorkspace(stored) } catch { continue }
    const item = { workspace, updated: text(value.updated), open: value.open !== false }
    const key = workspace.toLowerCase()
    const prior = newest.get(key)
    if (!prior || prior.updated < item.updated) newest.set(key, item)
  }
  return [...newest.values()]
    .filter(item => !openOnly || item.open)
    .sort((left, right) => right.updated.localeCompare(left.updated))
}

export async function closeProject(workspace: string): Promise<void> {
  await recordProject(workspace, false)
}

export function workspaceKey(workspace: string): string {
  return createHash('sha256').update(resolveWorkspace(workspace).toLowerCase()).digest('hex').slice(0, 20)
}

export function resolveWorkspace(workspace: string): string {
  const value = realpathSync.native(resolve(workspace))
  if (value.startsWith('\\\\?\\UNC\\')) return `\\\\${value.slice(8)}`
  return value.startsWith('\\\\?\\') ? value.slice(4) : value
}

/**
 * Plugins the user turned off, by name: `disabled_plugins` in the global or
 * project config.json plus the FRIDAY_DISABLED_PLUGINS environment list.
 * Built-in capabilities (web, memory, skills, compaction) and external plugins share
 * this one switch; the required workspace pack ignores it.
 */
export function disabledPlugins(workspace: string): Set<string> {
  const configured = [
    readObject(join(fridayHome(), 'config.json')),
    readObject(join(projectStateDir(workspace), 'config.json'))
  ].flatMap(config => Array.isArray(config.disabled_plugins) ? config.disabled_plugins : [])
  const environment = String(process.env.FRIDAY_DISABLED_PLUGINS || '').split(',')
  return new Set(
    [...configured, ...environment].map(value => String(value).trim().toLowerCase()).filter(Boolean)
  )
}

/**
 * Persist one plugin's on/off switch. Enabling removes the name from both
 * config layers so a global entry cannot silently win over the user's
 * choice; disabling records it in the global config, which every workspace
 * reads.
 */
export async function setPluginEnabled(workspace: string, name: string, enabled: boolean): Promise<Set<string>> {
  const key = name.trim().toLowerCase()
  if (!key) throw new Error('Plugin name is required.')
  const layers = [join(fridayHome(), 'config.json'), join(projectStateDir(workspace), 'config.json')]
  for (const [index, path] of layers.entries()) {
    const config = readObject(path)
    const current = Array.isArray(config.disabled_plugins)
      ? config.disabled_plugins.map(value => String(value).trim().toLowerCase()).filter(Boolean)
      : []
    const next = enabled
      ? current.filter(value => value !== key)
      : index === 0 ? [...new Set([...current, key])] : current
    if (next.length === current.length && next.every((value, position) => value === current[position])) continue
    await writeJsonAtomic(path, { ...config, disabled_plugins: next })
  }
  return disabledPlugins(workspace)
}

/** Effective Harness compaction policy: global defaults, then project overrides. */
export function loadCompactionSettings(workspace: string): CompactionSettings {
  let settings = { ...DEFAULT_COMPACTION }
  for (const path of [join(fridayHome(), 'config.json'), join(projectStateDir(workspace), 'config.json')]) {
    const config = readObject(path)
    if (config.compaction === undefined) continue
    if (!isObject(config.compaction)) throw new Error(`Friday compaction settings must be an object in ${path}.`)
    settings = compactionSettings(config.compaction, settings)
  }
  return settings
}

/** Persist a workspace policy while retaining global values as its defaults. */
export async function saveCompactionSettings(
  workspace: string,
  value: Record<string, unknown>
): Promise<CompactionSettings> {
  const settings = compactionSettings(value, loadCompactionSettings(workspace))
  const path = join(projectStateDir(workspace), 'config.json')
  const config = readObject(path)
  await writeJsonAtomic(path, { ...config, compaction: settings })
  return settings
}

function baseConfig(workspace: string): typeof DEFAULTS {
  const value = {
    ...DEFAULTS,
    ...readObject(join(fridayHome(), 'config.json')),
    ...readObject(join(projectStateDir(workspace), 'config.json'))
  }
  const provider = text(value.provider)
  const model = text(value.model)
  const baseUrl = text(value.base_url)
  if (!provider || !model) throw new Error("Friday config 'provider' and 'model' cannot be empty.")
  providerDefinition(provider)
  validateUrl(baseUrl)
  const contextWindow = positive(value.context_window, 0)
  const maxOutputTokens = positive(value.max_output_tokens, 0)
  const runTokenBudget = positive(value.run_token_budget, 0)
  if (!contextWindow || !maxOutputTokens || !runTokenBudget) throw new Error('Friday model limits must be positive integers.')
  if (maxOutputTokens > contextWindow) throw new Error('Maximum output tokens cannot exceed the context window.')
  return {
    provider,
    model,
    base_url: baseUrl,
    context_window: contextWindow === 353_000 ? DEFAULTS.context_window : contextWindow,
    max_output_tokens: maxOutputTokens,
    run_token_budget: runTokenBudget
  }
}

function validateProfile(value: StoredProfile | Record<string, unknown>, base: typeof DEFAULTS): ValidProfile {
  const id = profileId(text(value.id))
  const provider = text(value.provider).trim().toLowerCase()
  const name = text(value.name).trim()
  const model = text(value.model).trim()
  const definition = providerDefinition(provider)
  const baseUrl = (text(value.base_url) || definition.base_url).trim().replace(/\/$/, '')
  if (!id || !name) throw new Error('Model configuration id and name are required.')
  if (!definition.builtin && !model) throw new Error('Model configuration model is required.')
  validateUrl(baseUrl)
  const contextWindow = positive(value.context_window, base.context_window)
  const maxOutputTokens = positive(value.max_output_tokens, base.max_output_tokens)
  const runTokenBudget = positive(value.run_token_budget, base.run_token_budget)
  if (maxOutputTokens > contextWindow) throw new Error('Maximum output tokens cannot exceed the context window.')
  const vision = value.vision === true || supportsVision(provider, model) === true
  return {
    id,
    name,
    provider,
    model,
    base_url: baseUrl,
    ...(vision ? { vision: true } : {}),
    context_window: contextWindow === 353_000 ? base.context_window : contextWindow,
    max_output_tokens: maxOutputTokens,
    run_token_budget: runTokenBudget,
    ...(value.auto ? { auto: true } : {})
  }
}

function defaultProfile(base: typeof DEFAULTS): ValidProfile {
  const provider = providerDefinition(base.provider)
  return validateProfile({ id: 'default', name: provider.label, ...base }, base)
}

function syncBuiltin(
  provider: ProviderDefinition,
  modelIds: DiscoveredModel[] | undefined,
  profiles: ValidProfile[],
  base: typeof DEFAULTS,
  credentials: Record<string, string>,
  apiKey: string
): { profiles: ValidProfile[]; credentials: Record<string, string> } {
  const served = [...new Map((modelIds ?? provider.models).map(model => [model.id, model])).values()]
    .sort((left, right) => left.id.localeCompare(right.id))
  const removed = profiles.filter(profile => profile.auto && profile.provider === provider.id)
  const next = profiles.filter(profile => !(profile.auto && profile.provider === provider.id))
  for (const profile of removed) delete credentials[profile.id]
  for (const discovered of served) {
    const model = discovered.id
    const vision = discovered.vision === true || supportsVision(provider.id, model) === true
    let profile = next.find(item => item.provider === provider.id && item.model === model)
    if (profile) {
      const { vision: _oldVision, ...rest } = profile
      profile = {
        ...rest,
        auto: true,
        name: model,
        base_url: provider.base_url,
        ...(vision ? { vision: true } : {})
      }
      next[next.findIndex(item => item.id === profile!.id)] = profile
    } else {
      profile = validateProfile({
        id: profileId(`${provider.id}-${model}`), name: model, provider: provider.id, model,
        base_url: provider.base_url, auto: true, ...(vision ? { vision: true } : {})
      }, base)
      next.push(profile)
    }
    credentials[profile.id] = apiKey
  }
  return { profiles: next, credentials }
}

function storedProfile(profile: ModelProfile | ValidProfile): ValidProfile {
  const { api_key_configured: _configured, enabled: _enabled, ...stored } = profile as ModelProfile
  return stored
}

async function writeModelState(
  active: string,
  profiles: ValidProfile[],
  disabled: Set<string>,
  credentials: Record<string, string>
): Promise<void> {
  await writeJsonAtomic(join(fridayHome(), 'models.json'), {
    active,
    disabled: [...disabled].sort(),
    profiles
  })
  await writeJsonAtomic(join(fridayHome(), 'model-credentials.json'), credentials, true)
}

async function withModelWrite<T>(work: () => Promise<T>): Promise<T> {
  const key = fridayHome().toLowerCase()
  const previous = modelWrites.get(key) ?? Promise.resolve()
  let release = () => {}
  const gate = new Promise<void>(resolveGate => { release = resolveGate })
  const tail = previous.then(() => gate)
  modelWrites.set(key, tail)
  await previous
  try {
    return await work()
  } finally {
    release()
    if (modelWrites.get(key) === tail) modelWrites.delete(key)
  }
}

function credentialsObject(): Record<string, string> {
  const value = readObject(join(fridayHome(), 'model-credentials.json'))
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => typeof item === 'string' && item ? [[key, item]] : []))
}

function providerDefinition(id: string): ProviderDefinition {
  const provider = PROVIDERS.find(item => item.id === id)
  if (!provider) throw new Error(`Unsupported model provider: ${id}`)
  return provider
}

function profileTarget(profile: Pick<ValidProfile, 'id' | 'provider'>): string {
  return profile.provider === 'openai-compatible' ? `profile:${profile.id}` : `provider:${profile.provider}`
}

function profileId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
}

function supportsVision(provider: string, model: string): true | undefined {
  const known = providerDefinition(provider).models.find(item => item.id === model)
  if (known?.vision === true) return true
  const lower = model.toLowerCase()
  if (provider === 'anthropic' && lower.startsWith('claude-')) return true
  if (provider === 'mimo' && lower === 'mimo-v2.5') return true
  if (provider === 'openai' && /^(gpt-4o|gpt-4\.1|gpt-5)/.test(lower)) return true
  if (/(^|[-_.])(vision|vl\d*|omni|image|ocr)([-_.]|$)/.test(lower)) return true
  return undefined
}

/**
 * Provider catalogs have no common capability schema. Accept positive image
 * evidence from the shapes used by common OpenAI-compatible catalogs, but do
 * not turn an absent (or stale negative) field into a local rejection. The
 * provider is the only reliable authority for a newly released model.
 */
function discoveredVision(model: Record<string, unknown>): true | undefined {
  const architecture = isObject(model.architecture) ? model.architecture : undefined
  const capabilities = isObject(model.capabilities) ? model.capabilities : undefined
  if (
    model.vision === true
    || model.supports_vision === true
    || model.supports_image_input === true
    || capabilities?.vision === true
    || capabilities?.image === true
  ) return true

  const modalities = [
    model.input_modalities,
    model.supported_input_modalities,
    model.modalities,
    Array.isArray(model.capabilities) ? model.capabilities : undefined,
    architecture?.input_modalities,
    architecture?.modalities
  ]
  for (const values of modalities) {
    if (Array.isArray(values) && values.some(value => /^(image|vision)$/i.test(String(value)))) return true
  }

  const modality = typeof architecture?.modality === 'string' ? architecture.modality.split('->')[0] ?? '' : ''
  return /(^|[+,/\s])(image|vision)([+,/\s]|$)/i.test(modality) ? true : undefined
}

function validateUrl(value: string): void {
  let protocol = ''
  try { protocol = new URL(value).protocol } catch {}
  if (protocol !== 'http:' && protocol !== 'https:') throw new Error(`Model Base URL must use HTTP or HTTPS: ${value}`)
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item.trim()) : []
}

function isRejectedKey(error: unknown): boolean {
  return error instanceof Error && error.name === 'AuthenticationError'
}

function samePath(left: string, right: string): boolean {
  try {
    return resolveWorkspace(left).toLowerCase() === right.toLowerCase()
  } catch {
    return resolve(left).toLowerCase() === right.toLowerCase()
  }
}

function providerKey(provider: string): string {
  const name = `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
  return process.env[name]
    || process.env.LLM_API_KEY
    || (provider === 'openai' ? process.env.OPENAI_API_KEY : '')
    || (provider === 'deepseek' ? process.env.DEEPSEEK_API_KEY : '')
    || (provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : '')
    || (provider === 'mimo' ? process.env.MIMO_API_KEY : '')
    || (provider === 'opencode-go' ? process.env.OPENCODE_API_KEY : '')
    || ''
}

function readObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isObject(value)) throw new Error(`Expected a JSON object in ${path}.`)
  return value
}

function readObjectOrEmpty(path: string): Record<string, unknown> {
  try {
    return readObject(path)
  } catch {
    return {}
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value ? value : fallback
}

function positive(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : fallback
}

function compactionSettings(value: Record<string, unknown>, base: CompactionSettings): CompactionSettings {
  const automatic = value.automatic === undefined ? base.automatic : value.automatic
  if (typeof automatic !== 'boolean') throw new Error('Compaction automatic must be true or false.')
  const threshold = value.threshold_percent === undefined ? base.threshold_percent : value.threshold_percent
  if (!Number.isSafeInteger(threshold) || (threshold as number) < 50 || (threshold as number) > 95) {
    throw new Error('Compaction threshold_percent must be an integer from 50 to 95.')
  }
  const strategy = value.strategy === undefined ? base.strategy : value.strategy
  if (strategy !== 'insert' && strategy !== 'two-stage') {
    throw new Error("Compaction strategy must be 'insert' or 'two-stage'.")
  }
  return { automatic, threshold_percent: threshold as number, strategy }
}
