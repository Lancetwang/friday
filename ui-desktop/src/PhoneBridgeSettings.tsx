import { useEffect, useRef, useState, type FormEvent } from 'react'

import { t } from './i18n'
import { SaveFooter, SecretField, SettingsMessage, useSettingsSave } from './SettingsForm'

export type FeishuSettings = {
  allow_group: boolean
  allowed_users: string[]
  app_id: string
  app_secret_configured: boolean
}

export type BridgeStatus = {
  exit_code: number | null
  log: string[]
  pid: number | null
  running: boolean
  workspace: string
}

const POLL_INTERVAL_MS = 4000

function lastLine(log: string[]) {
  return log.length ? log[log.length - 1] : ''
}

export function PhoneBridgeSettings({
  initial,
  initialStatus,
  onRefresh,
  onSave,
  onToggle
}: {
  initial: FeishuSettings
  initialStatus: BridgeStatus
  onRefresh: () => Promise<BridgeStatus>
  onSave: (value: Record<string, unknown>) => Promise<FeishuSettings>
  onToggle: (running: boolean) => Promise<BridgeStatus>
}) {
  const [saved, setSaved] = useState(initial)
  const [status, setStatus] = useState(initialStatus)
  const [appId, setAppId] = useState(initial.app_id)
  const [appSecret, setAppSecret] = useState('')
  const [clearSecret, setClearSecret] = useState(false)
  const [users, setUsers] = useState(initial.allowed_users.join('\n'))
  const [allowGroup, setAllowGroup] = useState(initial.allow_group)
  const form = useSettingsSave()
  const { report } = form

  // The caller rebuilds these on every render of the page above, so the poll reads
  // the latest through a ref rather than restarting its timer for a new identity.
  const refresh = useRef(onRefresh)
  useEffect(() => { refresh.current = onRefresh }, [onRefresh])

  // A bridge can die on its own, for example when Feishu rejects the credentials,
  // so the switch is driven by the process state rather than by what was clicked.
  useEffect(() => {
    if (!status.running) return
    let live = true
    const timer = setInterval(() => {
      void refresh.current()
        .then(value => {
          if (!live) return
          setStatus(value)
          // It went down without being asked to, so the switch owes an explanation.
          if (!value.running) report({ failed: true, message: lastLine(value.log) })
        })
        .catch(() => undefined)
    }, POLL_INTERVAL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [status.running, report])

  const ready = Boolean(saved.app_id) && saved.app_secret_configured

  const save = (event: FormEvent) => {
    event.preventDefault()
    const write = onSave({
      allow_group: allowGroup,
      allowed_users: users,
      app_id: appId,
      app_secret: appSecret || undefined,
      clear_app_secret: clearSecret
    })
    form.submit(write, value => {
      setSaved(value)
      setAppId(value.app_id)
      setUsers(value.allowed_users.join('\n'))
      setAllowGroup(value.allow_group)
      setAppSecret('')
      setClearSecret(false)
      return t('phone.saved')
    })
  }

  // A bridge that refuses to start explains itself in its own output, so the switch
  // reports the child's last line rather than a success of its own. Being switched
  // off is not a failure, whatever the SDK logged on its way out.
  const toggle = () => {
    const starting = !status.running
    form.submit(
      onToggle(starting),
      value => {
        setStatus(value)
        const refused = starting && !value.running
        return { failed: refused, message: refused ? lastLine(value.log) : '' }
      },
      'bridge'
    )
  }

  return (
    <div className="settings-form-stack">
      <div className={`phone-switch ${status.running ? 'on' : ''}`}>
        <div className="phone-switch-copy">
          <strong>{status.running ? t('phone.on') : t('phone.off')}</strong>
          <small>{status.running ? t('phone.onHint') : ready ? t('phone.offHint') : t('phone.needsSetup')}</small>
        </div>
        <button
          aria-pressed={status.running}
          className="phone-action"
          disabled={form.pending !== '' || (!ready && !status.running)}
          onClick={toggle}
          type="button"
        >
          {form.pending === 'bridge' ? t('settings.saving') : status.running ? t('phone.stop') : t('phone.start')}
        </button>
      </div>

      {saved.allowed_users.length === 0 && (
        <div className="settings-message">{t('phone.pairing')}</div>
      )}

      <form className="settings-form" onSubmit={save}>
        <label className="line-field">
          <span>{t('phone.appId')}</span>
          <span className="field-line">
            <input
              autoComplete="off"
              onChange={event => setAppId(event.target.value)}
              placeholder={t('phone.appIdHint')}
              value={appId}
            />
          </span>
        </label>
        <SecretField
          cleared={clearSecret}
          configured={saved.app_secret_configured}
          label={t('phone.appSecret')}
          onChange={setAppSecret}
          onToggleClear={() => setClearSecret(value => !value)}
          placeholderEmpty={t('web.keyEmpty')}
          placeholderSaved={t('web.keySaved')}
          removeArmedLabel={t('phone.removeSecretArmed')}
          removeLabel={t('phone.removeSecret')}
          value={appSecret}
        />
        <label className="line-field area">
          <span>{t('phone.allowedUsers')}</span>
          <span className="field-line">
            <textarea
              onChange={event => setUsers(event.target.value)}
              placeholder={t('phone.allowedUsersPlaceholder')}
              rows={3}
              value={users}
            />
          </span>
        </label>
        <small className="settings-hint">{t('phone.allowedUsersHint')}</small>
        <button
          aria-pressed={allowGroup}
          className={`phone-flag ${allowGroup ? 'on' : ''}`}
          onClick={() => setAllowGroup(value => !value)}
          type="button"
        >
          <svg aria-hidden="true" fill="none" viewBox="0 0 10 10">
            {allowGroup ? <path d="M1.6 5.4 4 7.8 8.4 2.6" /> : <circle cx="5" cy="5" r="3.4" />}
          </svg>
          {allowGroup ? t('phone.groupOn') : t('phone.groupOff')}
        </button>
        <SettingsMessage failed={form.failed} message={form.message} />
        <SaveFooter saving={form.pending === 'save'} />
      </form>

      {status.log.length > 0 && (
        <details className="phone-log">
          <summary>{t('phone.log')}</summary>
          <pre>{status.log.join('\n')}</pre>
        </details>
      )}
    </div>
  )
}
