import { createRoot } from 'react-dom/client'
import '@fontsource/jetbrains-mono/latin-400.css'
import '@fontsource/noto-serif-sc/latin-400.css'
import '@fontsource/noto-serif-sc/chinese-simplified-400.css'
import 'katex/dist/katex.min.css'

import App from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(<App />)
