import { createRoot } from 'react-dom/client'
import '@fontsource/jetbrains-mono/latin-400.css'
import '@fontsource/noto-serif-sc/latin-400.css'
import '@fontsource/noto-serif-sc/chinese-simplified-400.css'
import 'katex/dist/katex.min.css'

import App from './App'
import { DesktopPluginProviders } from './plugins'
import './styles.css'

const splash = document.getElementById('boot-splash')
let fallback = 0
const revealApp = () => {
  window.clearTimeout(fallback)
  if (!splash || splash.classList.contains('leaving')) return
  splash.classList.add('leaving')
  window.setTimeout(() => splash.remove(), 240)
}

window.addEventListener('friday:ready', revealApp, { once: true })
fallback = window.setTimeout(revealApp, 15_000)
createRoot(document.getElementById('root')!).render(
  <DesktopPluginProviders>
    <App />
  </DesktopPluginProviders>
)
