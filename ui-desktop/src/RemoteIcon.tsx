import { useEffect, useState } from 'react'
import { hostOf, safeIconUrl } from './sources'


const PROVIDER_ICON_URLS: Readonly<Record<string, string>> = {
  anthropic: 'https://www.anthropic.com/favicon.ico',
  anysearch: 'https://www.anysearch.com/favicon.ico',
  deepseek: 'https://www.deepseek.com/favicon.ico',
  mimo: 'https://mimo.mi.com/favicon.png',
  'opencode-go': 'https://opencode.ai/favicon.ico',
  openai: 'https://openai.com/favicon.ico',
  tavily: 'https://tavily.com/favicon.ico'
}


export function ProviderIcon({ label, provider }: { label: string; provider: string }) {
  return <RemoteIcon className="provider-icon" label={label} src={PROVIDER_ICON_URLS[provider.toLowerCase()] || ''} />
}


export function SiteIcon({ icon, url }: { icon?: string; url: string }) {
  let fallback = ''
  try {
    fallback = new URL('/favicon.ico', url).toString()
  } catch {
    // Invalid source URLs keep the quiet text fallback.
  }
  return <RemoteIcon className="source-icon" label={hostOf(url)} src={safeIconUrl(icon) || safeIconUrl(fallback)} />
}


function RemoteIcon({ className, label, src }: { className: string; label: string; src: string }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [src])
  return (
    <span aria-hidden="true" className={`${className} ${failed || !src ? 'fallback' : ''}`}>
      {src && !failed
        ? <img alt="" draggable={false} onError={() => setFailed(true)} referrerPolicy="no-referrer" src={src} />
        : <span>{label.trim().charAt(0).toUpperCase() || '·'}</span>}
    </span>
  )
}
