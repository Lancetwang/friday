import { useCallback, useEffect, useRef, useState } from 'react'

import { t } from './i18n'

/** What a finished write should say, and whether it went wrong. */
type Outcome = string | { failed: boolean; message: string }

/** Write state shared by every settings form: one write at a time, one outcome line.
 *
 * Choosing another settings section unmounts the form that is still saving, which
 * is easy to do because a save is a network round trip; the guard here is what
 * keeps that from resolving into a component that no longer exists.
 *
 * `pending` names the action rather than counting one, so a pane with more than one
 * button can tell which is working and still refuse to run them at the same time.
 */
export function useSettingsSave() {
  const [pending, setPending] = useState('')
  const [failed, setFailed] = useState(false)
  const [message, setMessage] = useState('')
  const live = useRef(true)

  useEffect(() => () => { live.current = false }, [])

  const clear = () => {
    setFailed(false)
    setMessage('')
  }

  /** Say how something turned out. Stable, so a poll can call it from an effect. */
  const report = useCallback((outcome: Outcome) => {
    if (!live.current) return
    const settled = typeof outcome === 'string' ? { failed: false, message: outcome } : outcome
    setFailed(settled.failed)
    setMessage(settled.message)
  }, [])

  /** Run one write. `done` applies the result and says what to report. */
  const submit = <T,>(work: Promise<T>, done: (value: T) => Outcome, action = 'save') => {
    setPending(action)
    clear()
    void work
      .then(value => { if (live.current) report(done(value)) })
      .catch(reason => { if (live.current) { setFailed(true); setMessage(String(reason)) } })
      .finally(() => { if (live.current) setPending('') })
  }

  return { clear, failed, message, pending, report, submit }
}

export function SettingsMessage({ failed, message }: { failed: boolean; message: string }) {
  if (!message) return null
  return <div className={`settings-message ${failed ? 'error' : ''}`}>{message}</div>
}

export function SaveFooter({
  label,
  note = '',
  saving
}: {
  label?: string
  note?: string
  saving: boolean
}) {
  return (
    <footer>
      <span className="settings-saved">{note}</span>
      <button className="save-model" disabled={saving} type="submit">
        {saving ? t('settings.saving') : label || t('settings.save')}
      </button>
    </footer>
  )
}
