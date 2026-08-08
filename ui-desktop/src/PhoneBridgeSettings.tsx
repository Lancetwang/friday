import { useEffect, useRef, useState, type FormEvent } from 'react'

import { t } from './i18n'
import { EyeIcon, TrashIcon } from './Icons'
import { SaveFooter, SettingsMessage, useSettingsSave } from './SettingsForm'

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
  onRevealSecret,
  onSave,
  onToggle
}: {
  initial: FeishuSettings
  initialStatus: BridgeStatus
  onRefresh: () => Promise<BridgeStatus>
  onRevealSecret: () => Promise<string>
  onSave: (value: Record<string, unknown>) => Promise<FeishuSettings>
  onToggle: (running: boolean) => Promise<BridgeStatus>
}) {
  const [saved, setSaved] = useState(initial)
  const [status, setStatus] = useState(initialStatus)
  const [appId, setAppId] = useState(initial.app_id)
  const [appSecret, setAppSecret] = useState('')
  const [secretVisible, setSecretVisible] = useState(false)
  const [users, setUsers] = useState(initial.allowed_users.join('\n'))
  const [allowGroup, setAllowGroup] = useState(initial.allow_group)
  const secretInput = useRef<HTMLInputElement>(null)
  const form = useSettingsSave()
  const secretForm = useSettingsSave()
  const { report } = secretForm

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
      app_id: appId
    })
    form.submit(write, value => {
      setSaved(value)
      setAppId(value.app_id)
      setUsers(value.allowed_users.join('\n'))
      setAllowGroup(value.allow_group)
      return t('phone.saved')
    })
  }

  // A bridge that refuses to start explains itself in its own output, so the switch
  // reports the child's last line rather than a success of its own. Being switched
  // off is not a failure, whatever the SDK logged on its way out.
  const toggle = (starting: boolean) => {
    secretForm.submit(
      onToggle(starting),
      value => {
        setStatus(value)
        const refused = starting && !value.running
        return { failed: refused, message: refused ? lastLine(value.log) : '' }
      },
      'bridge'
    )
  }

  const saveSecret = () => {
    const value = appSecret.trim()
    if (!value) {
      secretInput.current?.focus()
      return
    }
    secretForm.submit(onSave({ app_id: appId, app_secret: value }), result => {
      setSaved(result)
      setAppId(result.app_id)
      setAppSecret('')
      setSecretVisible(false)
      return t('phone.secretSaved')
    })
  }

  const revealSecret = () => {
    if (secretVisible) {
      setSecretVisible(false)
      return
    }
    if (appSecret) {
      setSecretVisible(true)
      return
    }
    if (!saved.app_secret_configured) return
    secretForm.submit(onRevealSecret(), value => {
      setAppSecret(value)
      setSecretVisible(true)
      return ''
    }, 'reveal')
  }

  const removeSecret = () => secretForm.submit(onSave({ clear_app_secret: true }), result => {
    setSaved(result)
    setAppSecret('')
    setSecretVisible(false)
    return t('phone.secretRemoved')
  }, 'clear')

  return (
    <div className="settings-form-stack">
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
        <div className="line-field phone-secret-field">
          <span>{t('phone.appSecret')}</span>
          <span className="credential-input">
            <input
              aria-label={t('phone.appSecret')}
              autoComplete="off"
              disabled={Boolean(secretForm.pending)}
              onChange={event => setAppSecret(event.target.value)}
              onKeyDown={event => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                saveSecret()
              }}
              placeholder={saved.app_secret_configured ? '••••••••••••' : t('phone.secretPlaceholder')}
              ref={secretInput}
              spellCheck={false}
              type={secretVisible ? 'text' : 'password'}
              value={appSecret}
            />
            <span className="credential-actions">
              <button aria-label={secretVisible ? t('secret.hide') : t('secret.show')} className="credential-icon" disabled={Boolean(secretForm.pending) || (!saved.app_secret_configured && !appSecret)} onClick={revealSecret} title={secretVisible ? t('secret.hide') : t('secret.show')} type="button">
                <EyeIcon open={!secretVisible} />
              </button>
              <button aria-label={t('phone.removeSecret')} className="credential-icon danger" disabled={Boolean(secretForm.pending) || !saved.app_secret_configured} onClick={removeSecret} title={t('phone.removeSecret')} type="button">
                <TrashIcon />
              </button>
              <label className="settings-switch" title={status.running ? t('phone.stop') : t('phone.start')}>
                <input
                  checked={status.running}
                  disabled={Boolean(secretForm.pending) || form.pending !== '' || (!ready && !status.running)}
                  onChange={event => toggle(event.target.checked)}
                  type="checkbox"
                />
                <span aria-hidden="true" />
              </label>
            </span>
          </span>
        </div>
        <div className="phone-secret-message"><SettingsMessage failed={secretForm.failed} message={secretForm.message} /></div>
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
        <div className="phone-switch phone-group-setting">
          <div className="phone-switch-copy">
            <strong>{t('phone.groupChats')}</strong>
            <small>{allowGroup ? t('phone.groupOn') : t('phone.groupOff')}</small>
          </div>
          <label className="settings-switch" title={t('phone.groupChats')}>
            <input checked={allowGroup} onChange={event => setAllowGroup(event.target.checked)} type="checkbox" />
            <span aria-hidden="true" />
          </label>
        </div>
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
