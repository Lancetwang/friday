import { FormEvent, useEffect, useRef, useState } from 'react'
import type { AppSettings, CompactionSettings, MemoryFileDetail, MemoryFileInfo, MemoryFileScope, ModelCatalog, ModelProfile, ModelProvider, PluginInfo, UserProfileSettings, WebSearchSettings } from 'friday-agent-protocol'
import { getLanguage, t, type Language } from './i18n'
import { ChevronIcon, CloseIcon, EyeIcon, MinusIcon, PlusIcon, RefreshIcon, TrashIcon } from './Icons'
import { ModelCapabilityFields } from './ModelCapabilityFields'
import { ExecutionSettingsForm } from './ExecutionSettingsForm'
import type { ExecutionSettings } from 'friday-agent-protocol'
import { DesktopPluginSettings } from './plugins'
import { SaveFooter, SettingsMessage, SettingsSwitch, useSettingsSave } from './SettingsForm'
import { hostOf } from './sources'
import { ProviderIcon } from './RemoteIcon'
const CUSTOM_NEW = 'openai-compatible:new'


export type ModelDraft = Pick<
  ModelProfile,
  'base_url' | 'context_window' | 'id' | 'max_output_tokens' | 'model' | 'name' | 'provider' | 'capabilities' | 'vision' | 'run_token_budget'
>

export type ModelTarget = { profile?: string; provider?: string }


export type SettingsSection = 'general' | 'models' | 'web' | 'memory' | 'compaction' | 'plugins'


const SETTINGS_SECTIONS: ReadonlyArray<{ hintKey: string; id: SettingsSection; labelKey: string }> = [
  { hintKey: 'settings.general.hint', id: 'general', labelKey: 'settings.general' },
  { hintKey: 'settings.models.hint', id: 'models', labelKey: 'settings.models' },
  { hintKey: 'settings.web.hint', id: 'web', labelKey: 'settings.web' },
  { hintKey: 'settings.memory.hint', id: 'memory', labelKey: 'settings.memory' },
  { hintKey: 'settings.compaction.hint', id: 'compaction', labelKey: 'settings.compaction' },
  { hintKey: 'settings.plugins.hint', id: 'plugins', labelKey: 'settings.plugins' }
]


function pluginContribution(plugin: PluginInfo): string {
  const values = plugin.tools.length ? [t('plugins.tools', { tools: plugin.tools.join(', ') })] : []
  if (plugin.capabilities?.includes('prompt')) values.push(t('plugins.prompt'))
  if (plugin.capabilities?.includes('tool-wrapper')) values.push(t('plugins.wrapper'))
  if (plugin.capabilities?.includes('memory')) values.push(t('plugins.memory'))
  if (plugin.capabilities?.includes('compaction')) values.push(t('plugins.compaction'))
  return values.join(' · ') || t('plugins.noTools')
}


function pluginCopy(plugin: PluginInfo): { description: string; name: string } {
  if (plugin.scope !== 'builtin') {
    return { description: plugin.description || plugin.source, name: plugin.name }
  }
  const nameKey = `plugins.builtin.${plugin.name}.name`
  const descriptionKey = `plugins.builtin.${plugin.name}.description`
  const name = t(nameKey)
  const description = t(descriptionKey)
  return {
    description: description === descriptionKey ? plugin.description || plugin.source : description,
    name: name === nameKey ? plugin.name : name
  }
}


/**
 * The plugin registry with one switch per row - the same on/off the TUI's
 * /plugins picker offers, persisted through the same gateway call.
 */
function PluginsSettings({
  plugins,
  onReload,
  onToggle
}: {
  plugins: PluginInfo[]
  onReload: () => Promise<{ plugins: PluginInfo[] }>
  onToggle: (name: string, enabled: boolean, trustDigest?: string) => Promise<{ plugins: PluginInfo[] }>
}) {
  const form = useSettingsSave()

  const toggle = (plugin: PluginInfo, enabled: boolean) => {
    form.submit(
      onToggle(plugin.name, enabled),
      () => t(enabled ? 'plugins.enabled' : 'plugins.disabled', { name: plugin.name }),
      plugin.name
    )
  }

  return (
    <div className="plugin-list">
      {plugins.map(plugin => {
        const copy = pluginCopy(plugin)
        return (
          <div className={`model-provider ${plugin.disabled ? '' : 'enabled'}`} key={plugin.name}>
            <div className="model-provider-identity">
              <span className="model-provider-name">
                <strong title={plugin.name}>{copy.name}</strong>
                <small>{copy.description}</small>
              </span>
            </div>
            <div className="model-provider-meta">
              <span>
                {plugin.required ? `${t('plugins.required')} · ` : ''}
                {t(`plugins.scope.${plugin.scope}`)} · {pluginContribution(plugin)}
              </span>
              {plugin.errors.length ? <span className="plugin-error">{t('plugins.error', { error: plugin.errors[0]! })}</span> : null}
            </div>
            {plugin.trusted === false ? <button disabled={!plugin.digest || form.pending === plugin.name}
              onClick={() => form.submit(onToggle(plugin.name, true, plugin.digest), () => t('plugins.enabled', { name: plugin.name }), plugin.name)}>
              {t('plugins.trust')}
            </button> : <SettingsSwitch
              checked={!plugin.disabled}
              disabled={plugin.required || form.pending === plugin.name}
              label={`${copy.name}: ${plugin.disabled ? t('plugins.off') : t('plugins.on')}`}
              onChange={enabled => toggle(plugin, enabled)}
            />}
          </div>
        )
      })}
      <p className="settings-note">{t('plugins.external')}</p>
      <button className="line-action" disabled={!!form.pending} onClick={() => form.submit(onReload(), () => t('plugins.reloaded'), 'reload')}>{t('plugins.reload')}</button>
      <SettingsMessage failed={form.failed} message={form.message} />
    </div>
  )
}


function ModelCredentialRow({
  configured,
  draft,
  enabled,
  label,
  modelCount,
  onClear,
  onEdit,
  onEnable,
  onRefresh,
  onReveal,
  onSave,
  provider,
  subtitle,
  target
}: {
  configured: boolean
  draft: ModelDraft
  enabled: boolean
  label: string
  modelCount: number
  onClear: (target: ModelTarget) => Promise<ModelCatalog>
  onEdit?: () => void
  onEnable: (target: ModelTarget, enabled: boolean) => Promise<ModelCatalog>
  onRefresh: (target: ModelTarget) => Promise<{ catalog: ModelCatalog; models: string[] }>
  onReveal: (target: ModelTarget) => Promise<string>
  onSave: (profile: ModelDraft, apiKey: string) => Promise<ModelCatalog>
  provider: string
  subtitle: string
  target: ModelTarget
}) {
  const [apiKey, setApiKey] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [available, setAvailable] = useState(modelCount)
  const input = useRef<HTMLInputElement>(null)
  const form = useSettingsSave()

  useEffect(() => setAvailable(modelCount), [modelCount])

  const save = (event: FormEvent) => {
    event.preventDefault()
    const value = apiKey.trim()
    if (!value) {
      input.current?.focus()
      return
    }
    form.submit(onSave(draft, value), () => {
      setApiKey('')
      setRevealed(false)
      return t('models.saved')
    })
  }

  const reveal = () => {
    if (revealed) {
      setRevealed(false)
      return
    }
    if (apiKey) {
      setRevealed(true)
      return
    }
    if (!configured) return
    form.submit(onReveal(target), value => {
      setApiKey(value)
      setRevealed(true)
      return ''
    }, 'reveal')
  }

  const refresh = () => form.submit(onRefresh(target), result => {
    setAvailable(result.models.length)
    return t('models.refreshed').replace('{n}', String(result.models.length))
  }, 'refresh')

  const clear = () => form.submit(onClear(target), () => {
    setApiKey('')
    setRevealed(false)
    return t('models.keyRemoved')
  }, 'clear')

  const toggle = (next: boolean) => {
    if (next && !configured) {
      input.current?.focus()
      form.report({ failed: true, message: t('models.enableNeedsKey') })
      return
    }
    form.submit(onEnable(target, next), () => next ? t('models.enabled') : t('models.disabled'), 'toggle')
  }

  const busy = Boolean(form.pending)
  return (
    <div className={`model-provider ${enabled ? 'enabled' : ''}`}>
      <div className="model-provider-identity">
        <ProviderIcon label={label} provider={provider} />
        {onEdit ? (
          <button className="model-provider-name model-provider-edit" onClick={onEdit} type="button">
            <strong>{label}</strong>
            <small>{subtitle}</small>
          </button>
        ) : (
          <span className="model-provider-name">
            <strong>{label}</strong>
            <small>{subtitle}</small>
          </span>
        )}
      </div>
      <form className="credential-input" onSubmit={save}>
        <input
          aria-label={`${label} ${t('models.apiKey')}`}
          autoComplete="off"
          disabled={busy}
          onChange={event => setApiKey(event.target.value)}
          placeholder={configured ? '••••••••••••' : t('models.keyEmptyShort')}
          ref={input}
          spellCheck={false}
          type={revealed ? 'text' : 'password'}
          value={apiKey}
        />
        <div className="credential-actions">
          <button
            aria-label={revealed ? t('secret.hide') : t('secret.show')}
            className="credential-icon"
            disabled={busy || (!configured && !apiKey)}
            onClick={reveal}
            title={revealed ? t('secret.hide') : t('secret.show')}
            type="button"
          ><EyeIcon open={!revealed} /></button>
          <button
            aria-label={t('models.refresh')}
            className={`credential-icon ${form.pending === 'refresh' ? 'spinning' : ''}`}
            disabled={busy || !configured}
            onClick={refresh}
            title={t('models.refresh')}
            type="button"
          ><RefreshIcon /></button>
          <button
            aria-label={t('models.removeKey')}
            className="credential-icon danger"
            disabled={busy || !configured}
            onClick={clear}
            title={t('models.removeKey')}
            type="button"
          ><TrashIcon /></button>
          <SettingsSwitch
            checked={enabled}
            disabled={busy}
            label={`${label}: ${enabled ? t('models.disable') : t('models.enable')}`}
            onChange={toggle}
          />
        </div>
      </form>
      <div className="model-provider-meta">
        <span>{configured ? t('models.modelCount').replace('{n}', String(available)) : t('badge.unconfigured')}</span>
        <SettingsMessage failed={form.failed} message={form.message} />
      </div>
    </div>
  )
}


export function SettingsPage({
  catalog,
  initialSection,
  language,
  onClearKey,
  onClose,
  onCompact,
  onDelete,
  onEnable,
  onLanguageChange,
  onListPlugins,
  onLoad,
  onReadMemory,
  onRefreshModels,
  onRevealKey,
  onRevealWebKey,
  onSave,
  onSaveCompaction,
  onSaveExecution,
  onSaveMemory,
  onSaveProfile,
  onSaveWeb,
  onTogglePlugin
}: {
  catalog: ModelCatalog
  initialSection: SettingsSection
  language: Language
  onClearKey: (target: ModelTarget) => Promise<ModelCatalog>
  onClose: () => void
  onCompact: () => Promise<{ text: string }>
  onDelete: (profileId: string) => Promise<ModelCatalog>
  onEnable: (target: ModelTarget, enabled: boolean) => Promise<ModelCatalog>
  onLanguageChange: (language: Language) => void
  onListPlugins: (reload?: boolean) => Promise<{ plugins: PluginInfo[] }>
  onLoad: () => Promise<AppSettings>
  onReadMemory: (file: MemoryFileScope) => Promise<MemoryFileDetail>
  onRefreshModels: (target: ModelTarget) => Promise<{ catalog: ModelCatalog; models: string[] }>
  onRevealKey: (target: ModelTarget) => Promise<string>
  onRevealWebKey: (provider: string) => Promise<string>
  onSave: (profile: ModelDraft, apiKey: string) => Promise<ModelCatalog>
  onSaveCompaction: (value: CompactionSettings) => Promise<CompactionSettings>
  onSaveExecution: (value: ExecutionSettings) => Promise<ExecutionSettings>
  onSaveMemory: (file: MemoryFileScope, content: string) => Promise<MemoryFileInfo>
  onSaveProfile: (profile: Partial<UserProfileSettings>) => Promise<UserProfileSettings>
  onSaveWeb: (value: Record<string, unknown>) => Promise<WebSearchSettings>
  onTogglePlugin: (name: string, enabled: boolean, trustDigest?: string) => Promise<{ plugins: PluginInfo[] }>
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [settingsError, setSettingsError] = useState('')
  const [draft, setDraft] = useState<ModelDraft | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [expandedProvider, setExpandedProvider] = useState('')
  const [editingFile, setEditingFile] = useState<MemoryFileScope | null>(null)
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null)
  const [pluginsError, setPluginsError] = useState('')
  const modelForm = useSettingsSave()

  useEffect(() => {
    let active = true
    void onLoad()
      .then(value => {
        if (active) setSettings(value)
      })
      .catch(value => {
        if (active) setSettingsError(String(value))
      })
    return () => { active = false }
  }, [])

  useEffect(() => {
    let active = true
    void onListPlugins()
      .then(value => {
        if (active) setPlugins(value.plugins)
      })
      .catch(value => {
        if (active) setPluginsError(String(value))
      })
    return () => { active = false }
  }, [])

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !editingFile) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, editingFile])

  const openCustom = (profile: ModelProfile | null) => {
    modelForm.clear()
    const key = profile?.id || CUSTOM_NEW
    if (expandedProvider === key) {
      setExpandedProvider('')
      return
    }
    const custom = catalog.providers.find(entry => entry.id === 'openai-compatible')
    setExpandedProvider(key)
    setDraft(profile
      ? { ...modelDraft(profile, custom), name: profile.name }
      : { ...modelDraft(undefined, custom), name: '' })
    setApiKey('')
  }

  const removeCustom = (profileId: string) => {
    modelForm.submit(onDelete(profileId), () => {
      setExpandedProvider('')
      return t('models.deleted')
    })
  }

  const save = (event: FormEvent) => {
    event.preventDefault()
    if (!draft) return
    modelForm.submit(onSave(draft, apiKey), () => {
      setApiKey('')
      setExpandedProvider('')
      return t('models.saved')
    })
  }

  const persistWeb = (value: Record<string, unknown>) => onSaveWeb(value).then(webSearch => {
    setSettings(current => current ? { ...current, web_search: webSearch } : current)
    return webSearch
  })

  const persistProfile = (profile: Partial<UserProfileSettings>) => onSaveProfile(profile).then(userProfile => {
    setSettings(current => current ? { ...current, user_profile: userProfile } : current)
    return userProfile
  })

  const persistCompaction = (value: CompactionSettings) => onSaveCompaction(value).then(compaction => {
    setSettings(current => current ? { ...current, compaction } : current)
    return compaction
  })

  const persistPlugin = (name: string, enabled: boolean, trustDigest?: string) => onTogglePlugin(name, enabled, trustDigest).then(result => {
    setPlugins(result.plugins)
    return result
  })

  const compactionPluginEnabled = plugins
    ? plugins.some(plugin => !plugin.disabled && plugin.capabilities.includes('compaction'))
    : null

  return (
    <div className="settings-page">
      <aside className="settings-nav">
        <button className="settings-back" onClick={onClose} title="Back (Esc)" type="button">
          <ChevronIcon className="back-chevron" />
          <span>{t('settings.back')}</span>
        </button>
        <div className="settings-nav-group">
          {SETTINGS_SECTIONS.map(item => (
            <button
              className={`settings-section ${section === item.id ? 'active' : ''}`}
              key={item.id}
              onClick={() => setSection(item.id)}
              type="button"
            >
              <strong>{t(item.labelKey)}</strong>
              <small>{t(item.hintKey)}</small>
            </button>
          ))}
        </div>
      </aside>
      <section className="settings-content">
          {section === 'general' && (
            <div className="settings-section-wrap">
              <header className="settings-head">
                <h2>{t('general.title')}</h2>
                <p>{t('general.desc')}</p>
              </header>
              <div className="general-preferences">
                <div className="language-field">
                  <span className="language-label">{t('general.uiLanguage')}</span>
                  <div className="language-options" role="radiogroup">
                    {(['zh', 'en'] as const).map(option => (
                      <button
                        aria-checked={language === option}
                        className={`language-option ${language === option ? 'active' : ''}`}
                        key={option}
                        onClick={() => onLanguageChange(option)}
                        role="radio"
                        type="button"
                      >
                        {option === 'zh' ? '中文' : 'English'}
                      </button>
                    ))}
                  </div>
                  <p className="language-note">{t('general.uiLanguageNote')}</p>
                </div>
                <DesktopPluginSettings slot="general" />
                {settings && <ExecutionSettingsForm initial={settings.execution} onSave={value => onSaveExecution(value).then(execution => { setSettings(current => current ? { ...current, execution } : current); return execution })} />}
                <div className="profile-settings">
                  <p>{t('general.profileNote')}</p>
                  {settings
                    ? <UserProfileSettingsForm initial={settings.user_profile} onSave={persistProfile} />
                    : <SettingsLoading error={settingsError} />}
                </div>
              </div>
            </div>
          )}
          {section === 'models' && <div className="settings-section-wrap">
            <header className="settings-head">
              <h2>{t('models.title')}</h2>
            </header>
            <div className="model-provider-list">
              {catalog.providers.filter(item => item.builtin).map(item => {
                const providerProfiles = catalog.profiles.filter(entry => entry.provider === item.id)
                return (
                  <ModelCredentialRow
                    configured={item.api_key_configured}
                    draft={{ ...modelDraft(providerProfiles[0], item), id: providerProfiles[0]?.id || item.id, model: '', name: item.label }}
                    enabled={item.enabled}
                    key={item.id}
                    label={item.label}
                    modelCount={providerProfiles.length}
                    onClear={onClearKey}
                    onEnable={onEnable}
                    onRefresh={onRefreshModels}
                    onReveal={onRevealKey}
                    onSave={onSave}
                    provider={item.id}
                    subtitle={hostOf(item.base_url) || item.base_url}
                    target={{ provider: item.id }}
                  />
                )
              })}
            </div>
            <section className="custom-models">
              <header>
                <div>
                  <h3>{t('models.configTitle')}</h3>
                  <p>{t('models.configNote')}</p>
                </div>
                <button aria-label={t('models.addCustom')} className="custom-add" onClick={() => openCustom(null)} title={t('models.addCustom')} type="button">
                  <PlusIcon />
                  <span>{t('models.add')}</span>
                </button>
              </header>
              {catalog.profiles.map(profile => (
                <div key={profile.id}>
                  <ModelCredentialRow
                    configured={profile.api_key_configured}
                    draft={modelDraft(profile, catalog.providers.find(item => item.id === 'openai-compatible'))}
                    enabled={profile.enabled}
                    label={profile.name}
                    modelCount={1}
                    onClear={onClearKey}
                    onEdit={() => openCustom(profile)}
                    onEnable={onEnable}
                    onRefresh={onRefreshModels}
                    onReveal={onRevealKey}
                    onSave={onSave}
                    provider={profile.provider}
                    subtitle={`${hostOf(profile.base_url) || profile.base_url} · ${profile.model}`}
                    target={{ profile: profile.id }}
                  />
                </div>
              ))}
              {expandedProvider && draft && (
                <form className="custom-model-editor settings-form" onSubmit={save}>
                  <label className="line-field">
                    <span>{t('models.name')}</span>
                    <span className="field-line">
                      <input required value={draft.name} onChange={event => setDraft(current => current && { ...current, name: event.target.value })} />
                    </span>
                  </label>
                  <label className="line-field">
                    <span>{t('models.baseUrl')}</span>
                    <span className="field-line">
                      <input required type="url" value={draft.base_url} onChange={event => setDraft(current => current && { ...current, base_url: event.target.value })} />
                    </span>
                  </label>
                  <label className="line-field">
                    <span>{t('models.model')}</span>
                    <span className="field-line">
                      <input required value={draft.model} onChange={event => setDraft(current => current && { ...current, model: event.target.value })} />
                    </span>
                  </label>
                  <label className="line-field">
                    <span>{t('models.apiKey')}</span>
                    <span className="field-line">
                      <input
                        autoComplete="off"
                        onChange={event => setApiKey(event.target.value)}
                        placeholder={expandedProvider === CUSTOM_NEW ? t('models.keyEmptyShort') : t('models.keyOptional')}
                        required={expandedProvider === CUSTOM_NEW}
                        type="password"
                        value={apiKey}
                      />
                    </span>
                  </label>
                  <SettingsMessage failed={modelForm.failed} message={modelForm.message} />
                  <ModelCapabilityFields draft={draft} onChange={setDraft} />
                  <div className="settings-actions">
                    <SaveFooter label={t('settings.save')} saving={modelForm.pending === 'save'} />
                    {expandedProvider !== CUSTOM_NEW && draft.provider === 'openai-compatible' && (
                      <button className="line-action remove-entry" onClick={() => removeCustom(expandedProvider)} type="button">
                        {t('models.removeEntry')}
                      </button>
                    )}
                  </div>
                </form>
              )}
            </section>
          </div>}
          {section === 'web' && (
            <div className="settings-section-wrap">
              <header className="settings-head">
                <h2>{t('web.title')}</h2>
                <p>{t('web.desc')}</p>
              </header>
              {settings
                ? <WebSearchSettings initial={settings.web_search} onReveal={onRevealWebKey} onSave={persistWeb} />
                : <SettingsLoading error={settingsError} />}
            </div>
          )}
          {section === 'memory' && (
            <div className="settings-section-wrap">
              <header className="settings-head">
                <h2>{t('memory.title')}</h2>
                <p>{t('memory.desc')}</p>
              </header>
              {settings
                ? (
                  <div className="memory-files">
                      {(['user', 'global'] as const).map(file => {
                        const info = settings.memory_files[file]
                        return (
                          <button className="memory-file" key={file} onClick={() => setEditingFile(file)} type="button">
                            <span aria-hidden="true" className="artifact-icon markdown">MD</span>
                            <span className="memory-file-meta">
                              <strong>{file === 'user' ? 'USER.md' : 'MEMORY.md'}</strong>
                              <small>{file === 'user' ? t('memory.userFile') : t('memory.globalFile')} · {t('memory.chars', { chars: info.chars, limit: info.limit })}</small>
                            </span>
                            <ChevronIcon className="memory-file-chevron" />
                          </button>
                        )
                      })}
                    </div>
                )
                : <SettingsLoading error={settingsError} />}
              {editingFile && settings && (
                <MemoryEditor
                  file={editingFile}
                  info={settings.memory_files[editingFile]}
                  onClose={() => setEditingFile(null)}
                  onRead={onReadMemory}
                  onSave={(file, content) => onSaveMemory(file, content).then(info => {
                    setSettings(current => current
                      ? { ...current, memory_files: { ...current.memory_files, [file]: info } }
                      : current)
                    return info
                  })}
                />
              )}
            </div>
          )}
          {section === 'compaction' && (
            <div className="settings-section-wrap">
              <header className="settings-head">
                <h2>{t('compaction.title')}</h2>
                <p>{t('compaction.desc')}</p>
              </header>
              {settings
                ? <CompactionSettingsForm
                    initial={settings.compaction}
                    onCompact={onCompact}
                    onSave={persistCompaction}
                    pluginEnabled={compactionPluginEnabled}
                  />
                : <SettingsLoading error={settingsError} />}
            </div>
          )}
          {section === 'plugins' && (
            <div className="settings-section-wrap">
              <header className="settings-head">
                <h2>{t('plugins.title')}</h2>
                <p>{t('plugins.desc')}</p>
              </header>
              {plugins
                ? <PluginsSettings plugins={plugins} onToggle={persistPlugin} onReload={() => onListPlugins(true).then(result => { setPlugins(result.plugins); return result })} />
                : <SettingsLoading error={pluginsError} />}
            </div>
          )}
      </section>
    </div>
  )
}


function CompactionSettingsForm({
  initial,
  onCompact,
  onSave,
  pluginEnabled
}: {
  initial: CompactionSettings
  onCompact: () => Promise<{ text: string }>
  onSave: (value: CompactionSettings) => Promise<CompactionSettings>
  pluginEnabled: boolean | null
}) {
  const [draft, setDraft] = useState(initial)
  const saveForm = useSettingsSave()
  const compactForm = useSettingsSave()
  useEffect(() => setDraft(initial), [initial])
  const busy = Boolean(saveForm.pending || compactForm.pending)
  const dirty = draft.automatic !== initial.automatic
    || draft.strategy !== initial.strategy
    || draft.threshold_percent !== initial.threshold_percent
  const save = (event: FormEvent) => {
    event.preventDefault()
    if (busy || !dirty) return
    saveForm.submit(
      onSave(draft).then(value => setDraft(value)),
      () => t('compaction.saved')
    )
  }
  const compact = () => {
    if (busy || pluginEnabled === false) return
    const settings = dirty
      ? onSave(draft).then(value => {
          setDraft(value)
          return value
        })
      : Promise.resolve(draft)
    compactForm.submit(
      settings.then(() => onCompact()),
      result => result.text,
      'compact'
    )
  }
  const moveThreshold = (amount: number) => setDraft(current => ({
    ...current,
    threshold_percent: Math.min(95, Math.max(50, current.threshold_percent + amount))
  }))

  return (
    <div className="compaction-settings">
      <form className="compaction-policy settings-form" onSubmit={save}>
        <div className="compaction-controls">
          <div className="compaction-control">
            <span className="compaction-copy">
              <strong>{t('compaction.automatic')}</strong>
              <small>{t('compaction.automaticNote')}</small>
            </span>
            <SettingsSwitch
              checked={draft.automatic}
              label={t('compaction.automatic')}
              onChange={automatic => setDraft(current => ({ ...current, automatic }))}
            />
          </div>
          <div className="compaction-control">
            <span className="compaction-copy">
              <strong>{t('compaction.threshold')}</strong>
              <small>{t('compaction.thresholdNote')}</small>
            </span>
            <div className="threshold-stepper">
              <button
                aria-label={t('compaction.decreaseThreshold')}
                disabled={draft.threshold_percent <= 50}
                onClick={() => moveThreshold(-1)}
                type="button"
              >
                <MinusIcon />
              </button>
              <output aria-live="polite">{draft.threshold_percent}<small>%</small></output>
              <button
                aria-label={t('compaction.increaseThreshold')}
                disabled={draft.threshold_percent >= 95}
                onClick={() => moveThreshold(1)}
                type="button"
              >
                <PlusIcon />
              </button>
            </div>
          </div>
          <div className="compaction-control compaction-strategy">
            <span className="compaction-copy">
              <strong>{t('compaction.strategy')}</strong>
            </span>
            <div className="compaction-strategy-choice">
              <div aria-label={t('compaction.strategy')} className="language-options" role="radiogroup">
                {(['insert', 'two-stage'] as const).map(strategy => {
                  const tip = `compaction-${strategy}-tip`
                  return (
                    <span className="compaction-strategy-option" key={strategy}>
                      <button
                        aria-checked={draft.strategy === strategy}
                        aria-describedby={tip}
                        className={`language-option ${draft.strategy === strategy ? 'active' : ''}`}
                        onClick={() => setDraft(current => ({ ...current, strategy }))}
                        role="radio"
                        type="button"
                      >
                        {t(strategy === 'insert' ? 'compaction.insert' : 'compaction.twoStage')}
                      </button>
                      <span className="compaction-strategy-tooltip" id={tip} role="tooltip">
                        {t(strategy === 'insert' ? 'compaction.insertNote' : 'compaction.twoStageNote')}
                      </span>
                    </span>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
        <footer className="compaction-save-footer">
          <SettingsMessage failed={saveForm.failed} message={saveForm.message} />
          <button className="save-model" disabled={busy || !dirty} type="submit">
            {saveForm.pending ? t('settings.saving') : t('compaction.saveSettings')}
          </button>
        </footer>
      </form>
      <section className={`compact-now-panel ${pluginEnabled === false ? 'unavailable' : ''}`}>
        <span className="compaction-copy">
          <strong>{t('compaction.manualTitle')}</strong>
          <small>{t(pluginEnabled === false ? 'compaction.pluginUnavailable' : 'compaction.manualNote')}</small>
        </span>
        <button
          className="compact-now-button"
          disabled={busy || pluginEnabled === false}
          onClick={compact}
          type="button"
        >
          {compactForm.pending ? t('compaction.compacting') : t('compaction.compactNow')}
        </button>
        {compactForm.message ? (
          <div className="compact-now-message">
            <SettingsMessage failed={compactForm.failed} message={compactForm.message} />
          </div>
        ) : null}
      </section>
    </div>
  )
}


function MemoryEditor({
  file,
  info,
  onClose,
  onRead,
  onSave
}: {
  file: MemoryFileScope
  info: MemoryFileInfo
  onClose: () => void
  onRead: (file: MemoryFileScope) => Promise<MemoryFileDetail>
  onSave: (file: MemoryFileScope, content: string) => Promise<MemoryFileInfo>
}) {
  const [text, setText] = useState<string | null>(null)
  const [original, setOriginal] = useState('')
  const [loadError, setLoadError] = useState('')
  const form = useSettingsSave()

  useEffect(() => {
    let active = true
    void onRead(file)
      .then(detail => {
        if (!active) return
        setOriginal(detail.content)
        setText(detail.content)
      })
      .catch(value => {
        if (active) setLoadError(String(value))
      })
    return () => { active = false }
  }, [file])

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const save = () => {
    if (text === null) return
    form.submit(onSave(file, text), () => {
      setOriginal(text)
      return t('settings.saved')
    })
  }

  return (
    <div className="memory-editor-backdrop" onMouseDown={onClose}>
      <section aria-modal="true" className="memory-editor" onMouseDown={event => event.stopPropagation()} role="dialog">
        <header>
          <div>
            <h3>{file === 'user' ? 'USER.md' : 'MEMORY.md'}</h3>
            <p>{info.path}</p>
          </div>
          <button aria-label="Close editor" onClick={onClose} title="Close" type="button"><CloseIcon /></button>
        </header>
        {text !== null
          ? (
            <textarea
              autoFocus
              onChange={event => {
                setText(event.target.value)
                form.clear()
              }}
              spellCheck={false}
              value={text}
            />
          )
          : <div className={`settings-loading ${loadError ? 'error' : ''}`}>{loadError || t('settings.loading')}</div>}
        <footer>
          <span className="memory-editor-count">{(text ?? '').length} / {info.limit}</span>
          {form.message && (
            <span className={form.failed ? 'settings-error' : 'settings-saved'}>{form.message}</span>
          )}
          <button
            className="save-model"
            disabled={form.pending === 'save' || text === null || text === original}
            onClick={save}
            type="button"
          >
            {form.pending === 'save' ? t('settings.saving') : t('settings.save')}
          </button>
        </footer>
      </section>
    </div>
  )
}


function SettingsLoading({ error }: { error: string }) {
  return <div className={`settings-loading ${error ? 'error' : ''}`}>{error || t('settings.loading')}</div>
}


const WEB_PROVIDERS: ReadonlyArray<{
  flag: 'clear_anysearch' | 'clear_tavily'
  host: string
  id: 'anysearch' | 'tavily'
  keyField: 'anysearch_api_key' | 'tavily_api_key'
  label: string
}> = [
  { flag: 'clear_tavily', host: 'api.tavily.com', id: 'tavily', keyField: 'tavily_api_key', label: 'Tavily' },
  { flag: 'clear_anysearch', host: 'api.anysearch.com', id: 'anysearch', keyField: 'anysearch_api_key', label: 'AnySearch' }
]


function WebSearchSettings({
  initial,
  onReveal,
  onSave
}: {
  initial: WebSearchSettings
  onReveal: (provider: string) => Promise<string>
  onSave: (value: Record<string, unknown>) => Promise<WebSearchSettings>
}) {
  const [configured, setConfigured] = useState(initial)

  return (
    <div className="model-provider-list">
      {WEB_PROVIDERS.map(provider => (
        <WebCredentialRow
          configured={configured[`${provider.id}_configured`]}
          key={provider.id}
          onReveal={onReveal}
          onSave={value => onSave(value).then(result => {
            setConfigured(result)
            return result
          })}
          provider={provider}
        />
      ))}
    </div>
  )
}


function WebCredentialRow({
  configured,
  onReveal,
  onSave,
  provider
}: {
  configured: boolean
  onReveal: (provider: string) => Promise<string>
  onSave: (value: Record<string, unknown>) => Promise<WebSearchSettings>
  provider: (typeof WEB_PROVIDERS)[number]
}) {
  const [apiKey, setApiKey] = useState('')
  const [revealed, setRevealed] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const form = useSettingsSave()
  const busy = Boolean(form.pending)

  const save = (event: FormEvent) => {
    event.preventDefault()
    if (!apiKey.trim()) {
      input.current?.focus()
      return
    }
    form.submit(onSave({ [provider.keyField]: apiKey.trim() }), () => {
      setApiKey('')
      setRevealed(false)
      return t('web.saved')
    })
  }

  const reveal = () => {
    if (revealed) {
      setRevealed(false)
      return
    }
    if (apiKey) {
      setRevealed(true)
      return
    }
    if (!configured) return
    form.submit(onReveal(provider.id), value => {
      setApiKey(value)
      setRevealed(true)
      return ''
    }, 'reveal')
  }

  const clear = () => form.submit(onSave({ [provider.flag]: true }), () => {
    setApiKey('')
    setRevealed(false)
    return t('models.keyRemoved')
  }, 'clear')

  return (
    <div className="model-provider web-provider">
      <div className="model-provider-identity">
        <ProviderIcon label={provider.label} provider={provider.id} />
        <span className="model-provider-name">
          <strong>{provider.label}</strong>
          <small>{provider.host}</small>
        </span>
      </div>
      <form className="credential-input" onSubmit={save}>
        <input
          aria-label={`${provider.label} ${t('models.apiKey')}`}
          autoComplete="off"
          disabled={busy}
          onChange={event => setApiKey(event.target.value)}
          placeholder={configured ? '••••••••••••' : t('models.keyEmptyShort')}
          ref={input}
          spellCheck={false}
          type={revealed ? 'text' : 'password'}
          value={apiKey}
        />
        <div className="credential-actions">
          <button aria-label={revealed ? t('secret.hide') : t('secret.show')} className="credential-icon" disabled={busy || (!configured && !apiKey)} onClick={reveal} title={revealed ? t('secret.hide') : t('secret.show')} type="button">
            <EyeIcon open={!revealed} />
          </button>
          <button aria-label={t('models.removeKey')} className="credential-icon danger" disabled={busy || !configured} onClick={clear} title={t('models.removeKey')} type="button">
            <TrashIcon />
          </button>
        </div>
      </form>
      <div className="model-provider-meta">
        <span>{configured ? t('badge.configured') : t('badge.unconfigured')}</span>
        <SettingsMessage failed={form.failed} message={form.message} />
      </div>
    </div>
  )
}


function UserProfileSettingsForm({
  initial,
  onSave
}: {
  initial: UserProfileSettings
  onSave: (profile: Partial<UserProfileSettings>) => Promise<UserProfileSettings>
}) {
  const [name, setName] = useState(initial.preferred_name)
  const [preferredLanguage, setPreferredLanguage] = useState(initial.preferred_language)
  const form = useSettingsSave()

  const save = (event: FormEvent) => {
    event.preventDefault()
    form.submit(
      onSave({ preferred_language: preferredLanguage, preferred_name: name }),
      () => t('memory.saved')
    )
  }

  return (
    <form className="settings-form" onSubmit={save}>
      <label className="line-field">
        <span>{t('general.name')}</span>
        <span className="field-line"><input maxLength={100} onChange={event => setName(event.target.value)} placeholder={t('general.namePlaceholder')} value={name} /></span>
      </label>
      <label className="line-field">
        <span>{t('general.responseLanguage')}</span>
        <span className="field-line"><input maxLength={100} onChange={event => setPreferredLanguage(event.target.value)} placeholder={t('general.responseLanguagePlaceholder')} value={preferredLanguage} /></span>
      </label>
      <SettingsMessage failed={form.failed} message={form.message} />
      <SaveFooter saving={form.pending === 'save'} />
    </form>
  )
}


export function modelDraft(profile?: ModelProfile, provider?: ModelProvider): ModelDraft {
  return {
    base_url: profile?.base_url || provider?.base_url || '',
    context_window: profile?.context_window || 32768,
    id: profile?.id || '',
    max_output_tokens: profile?.max_output_tokens || 4096,
    model: profile?.model || provider?.models[0]?.id || '',
    name: profile?.name || '',
    provider: profile?.provider || provider?.id || '',
    run_token_budget: profile?.run_token_budget || 40000000,
    capabilities: profile?.capabilities,
    vision: profile?.vision
  }
}
