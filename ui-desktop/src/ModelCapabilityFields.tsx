import { useEffect, useState } from 'react'
import type { ModelApi, ModelCapabilities, ModelReasoning } from 'friday-agent-protocol'
import type { ModelDraft } from './SettingsPage'
import { t } from './i18n'

export function ModelCapabilityFields({ draft, onChange }: { draft: ModelDraft; onChange: (draft: ModelDraft) => void }) {
  const capabilities = draft.capabilities ?? {}
  const reasoning = capabilities.reasoning
  const [options, setOptions] = useState(reasoning?.options.join(', ') ?? '')
  useEffect(() => setOptions(reasoning?.options.join(', ') ?? ''), [draft.id, reasoning?.mode])
  const update = <K extends keyof ModelCapabilities,>(key: K, value: ModelCapabilities[K]) => {
    const next = { ...capabilities }
    if (value === undefined) delete next[key]
    else next[key] = value
    onChange({ ...draft, capabilities: Object.keys(next).length ? next : undefined })
  }
  const selectMode = (mode: string) => {
    if (!mode) return update('reasoning', undefined)
    const values = mode === 'none' ? [] : mode.includes('toggle') ? ['off', 'on'] : ['low', 'medium', 'high']
    update('reasoning', { mode: mode as ModelReasoning['mode'], options: values, ...(values.length ? { default: values.at(-1) } : {}) })
  }
  return (
    <details className="model-capabilities" open>
      <summary>{t('models.capabilities')}</summary>
      <p>{t('models.capabilityNote')}</p>
      <label className="line-field"><span>{t('models.api')}</span><select value={capabilities.api ?? ''} onChange={event => update('api', event.target.value ? event.target.value as ModelApi : undefined)}>
        <option value="">{t('models.inherit')}</option><option value="chat-completions">Chat Completions</option><option value="responses">Responses</option><option value="anthropic">Anthropic Messages</option>
      </select></label>
      <label className="line-field"><span>{t('models.reasoningMode')}</span><select value={reasoning?.mode ?? ''} onChange={event => selectMode(event.target.value)}>
        <option value="">{t('models.inherit')}</option>{['none', 'effort', 'adaptive', 'toggle', 'disabled-toggle'].map(mode => <option key={mode} value={mode}>{t(`models.reasoning.${mode}`)}</option>)}
      </select></label>
      {reasoning && reasoning.mode !== 'none' && <>
        <label className="line-field"><span>{t('models.reasoningOptions')}</span><input value={options} onChange={event => {
          setOptions(event.target.value)
          update('reasoning', { ...reasoning, options: event.target.value.split(/[\s,]+/).filter(Boolean) })
        }} /></label>
        <label className="line-field"><span>{t('models.reasoningDefault')}</span><input value={reasoning.default ?? ''} onChange={event => update('reasoning', { ...reasoning, default: event.target.value || undefined })} /></label>
      </>}
      <label className="line-field"><span>{t('models.tools')}</span><select value={capabilities.tools === undefined ? '' : String(capabilities.tools)} onChange={event => update('tools', event.target.value ? event.target.value === 'true' : undefined)}>
        <option value="">{t('models.inherit')}</option><option value="true">{t('models.supported')}</option><option value="false">{t('models.unsupported')}</option>
      </select></label>
      <label className="line-field"><span>{t('models.vision')}</span><select value={draft.vision === undefined ? '' : String(draft.vision)} onChange={event => onChange({ ...draft, vision: event.target.value ? event.target.value === 'true' : undefined })}>
        <option value="">{t('models.inherit')}</option><option value="true">{t('models.supported')}</option><option value="false">{t('models.unsupported')}</option>
      </select></label>
      <label className="line-field"><span>{t('models.outputField')}</span><select value={capabilities.max_tokens_field ?? ''} onChange={event => update('max_tokens_field', event.target.value ? event.target.value as ModelCapabilities['max_tokens_field'] : undefined)}>
        <option value="">{t('models.inherit')}</option><option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option>
      </select></label>
      {(['context_window', 'max_output_tokens', 'run_token_budget'] as const).map(key => <label className="line-field" key={key}><span>{t(`models.${key}`)}</span><input min="1" required type="number" value={draft[key]} onChange={event => onChange({ ...draft, [key]: Number(event.target.value) })} /></label>)}
    </details>
  )
}
