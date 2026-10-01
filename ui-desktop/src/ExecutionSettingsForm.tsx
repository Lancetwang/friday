import { useEffect, useState } from 'react'
import type { ExecutionSettings } from 'friday-agent-protocol'
import { t } from './i18n'
import { SaveFooter, SettingsMessage, useSettingsSave } from './SettingsForm'

export function ExecutionSettingsForm({ initial, onSave }: { initial: ExecutionSettings; onSave: (value: ExecutionSettings) => Promise<ExecutionSettings> }) {
  const [draft, setDraft] = useState(initial)
  const form = useSettingsSave()
  useEffect(() => setDraft(initial), [initial])
  const disabled = !!form.pending || !!initial.managed_by
  return <form className="settings-form" onSubmit={event => { event.preventDefault(); form.submit(onSave(draft), () => t('settings.saved')) }}>
    <h3>{t('execution.title')}</h3><p>{t('execution.note')}</p>
    {initial.managed_by && <p>{t('execution.environment')}</p>}
    <label className="line-field"><span>{t('execution.backend')}</span><select disabled={disabled} value={draft.backend} onChange={event => setDraft({ ...draft, backend: event.target.value as ExecutionSettings['backend'] })}><option value="native">{t('execution.native')}</option><option value="docker">Docker</option></select></label>
    {draft.backend === 'docker' && <>
      <label className="line-field"><span>{t('execution.image')}</span><input required disabled={disabled} value={draft.image} onChange={event => setDraft({ ...draft, image: event.target.value })} /></label>
      <label className="line-field"><span>{t('execution.network')}</span><select disabled={disabled} value={draft.network} onChange={event => setDraft({ ...draft, network: event.target.value as ExecutionSettings['network'] })}><option value="none">{t('execution.none')}</option><option value="bridge">{t('execution.bridge')}</option></select></label>
    </>}
    <SettingsMessage failed={form.failed} message={form.message} />
    {!initial.managed_by && <SaveFooter saving={!!form.pending} />}
  </form>
}
