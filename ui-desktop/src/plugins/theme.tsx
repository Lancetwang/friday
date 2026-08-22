import {
  createContext,
  type Dispatch,
  type PropsWithChildren,
  type SetStateAction,
  useContext,
  useEffect,
  useLayoutEffect,
  useState
} from 'react'

import { t } from '../i18n'
import type { DesktopPlugin } from './types'

export type ThemeMode = 'dark' | 'light'

type ThemePalette = {
  accent: string
  canvas: string
}

type ThemeContextValue = {
  mode: ThemeMode
  palette: ThemePalette
  setMode: Dispatch<SetStateAction<ThemeMode>>
  setPalette: Dispatch<SetStateAction<ThemePalette>>
}

const THEME_KEY = 'friday.desktop.theme'
const PALETTE_KEY = 'friday.desktop.palette'
const DEFAULT_PALETTE: ThemePalette = { accent: '#91CAFF', canvas: '#FFFFFF' }
const PRESETS = [
  { accent: '#91CAFF', canvas: '#FFFFFF', id: 'fridaySky' },
  { accent: '#7CE2FE', canvas: '#F9FEFF', id: 'radixSky' },
  { accent: '#A6C8FF', canvas: '#FFFFFF', id: 'carbonBlue' },
  { accent: '#7DD3FC', canvas: '#F8FAFC', id: 'tailwindAir' },
  { accent: '#B8C4FF', canvas: '#FFFBFE', id: 'irisMist' },
  { accent: '#9CCEB7', canvas: '#FCFDFC', id: 'sageStudio' }
] as const

const ThemeContext = createContext<ThemeContextValue | null>(null)

function normalizeHex(input: string): string | null {
  const value = input.trim().replace(/^#/, '')
  if (/^[\da-f]{3}$/i.test(value)) {
    return `#${[...value].map(character => character.repeat(2)).join('').toUpperCase()}`
  }
  return /^[\da-f]{6}$/i.test(value) ? `#${value.toUpperCase()}` : null
}

function loadMode(): ThemeMode {
  try {
    return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

function loadPalette(): ThemePalette {
  try {
    const stored = JSON.parse(localStorage.getItem(PALETTE_KEY) || 'null') as Partial<ThemePalette> | null
    const canvas = normalizeHex(stored?.canvas || '')
    const accent = normalizeHex(stored?.accent || '')
    if (canvas && accent) return { accent, canvas }
  } catch {
    // A malformed local preference should simply fall back to Friday's palette.
  }
  return DEFAULT_PALETTE
}

function channel(value: number) {
  const normalized = value / 255
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string) {
  const value = Number.parseInt(hex.slice(1), 16)
  return 0.2126 * channel(value >> 16) + 0.7152 * channel((value >> 8) & 255) + 0.0722 * channel(value & 255)
}

function contrast(left: string, right: string) {
  const [lighter, darker] = [luminance(left), luminance(right)].sort((a, b) => b - a)
  return (lighter! + 0.05) / (darker! + 0.05)
}

function textOn(color: string) {
  const dark = '#132238'
  return contrast(color, dark) >= contrast(color, '#FFFFFF') ? dark : '#FFFFFF'
}

function ThemeProvider({ children }: PropsWithChildren) {
  const [mode, setMode] = useState<ThemeMode>(loadMode)
  const [palette, setPalette] = useState<ThemePalette>(loadPalette)

  useLayoutEffect(() => {
    const root = document.documentElement
    root.dataset.theme = mode
    root.style.setProperty('--theme-canvas', palette.canvas)
    root.style.setProperty('--theme-accent', palette.accent)
    root.style.setProperty('--theme-on-accent', textOn(palette.accent))
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', mode === 'dark' ? '#151719' : palette.canvas)
    try {
      localStorage.setItem(THEME_KEY, mode)
      localStorage.setItem(PALETTE_KEY, JSON.stringify(palette))
    } catch {
      // The live theme still works when storage is unavailable.
    }
  }, [mode, palette])

  return <ThemeContext.Provider value={{ mode, palette, setMode, setPalette }}>{children}</ThemeContext.Provider>
}

export function useThemePlugin() {
  const value = useContext(ThemeContext)
  if (!value) throw new Error('ThemePlugin must be registered before Friday renders')
  return value
}

function ThemeColorField({
  color,
  hint,
  label,
  onChange
}: {
  color: string
  hint: string
  label: string
  onChange: (color: string) => void
}) {
  const [draft, setDraft] = useState(color)
  const valid = normalizeHex(draft)

  useEffect(() => setDraft(color), [color])

  return (
    <div className="theme-color-field">
      <input
        aria-label={t('theme.pickColor', { label })}
        className="theme-color-picker"
        onChange={event => onChange(event.target.value.toUpperCase())}
        type="color"
        value={color}
      />
      <span className="theme-color-copy">
        <strong>{label}</strong>
        <small>{hint}</small>
      </span>
      <input
        aria-invalid={!valid}
        aria-label={t('theme.colorCode', { label })}
        className="theme-color-code"
        maxLength={7}
        onBlur={() => {
          const normalized = normalizeHex(draft)
          if (normalized) onChange(normalized)
          else setDraft(color)
        }}
        onChange={event => {
          const next = event.target.value.toUpperCase()
          setDraft(next)
          const normalized = normalizeHex(next)
          if (normalized && /^#?[\da-f]{6}$/i.test(next.trim())) onChange(normalized)
        }}
        spellCheck={false}
        value={draft}
      />
    </div>
  )
}

function ThemeSettings() {
  const { palette, setPalette } = useThemePlugin()
  const activePreset = PRESETS.find(preset => preset.canvas === palette.canvas && preset.accent === palette.accent)?.id

  return (
    <section className="theme-plugin-settings" data-desktop-plugin="theme">
      <header className="theme-plugin-head">
        <div>
          <h3>{t('theme.settingsTitle')}</h3>
          <p>{t('theme.settingsDesc')}</p>
        </div>
        <button
          className="theme-reset"
          disabled={palette.canvas === DEFAULT_PALETTE.canvas && palette.accent === DEFAULT_PALETTE.accent}
          onClick={() => setPalette(DEFAULT_PALETTE)}
          type="button"
        >
          {t('theme.reset')}
        </button>
      </header>

      <div aria-label={t('theme.presets')} className="theme-presets">
        {PRESETS.map(preset => (
          <button
            aria-pressed={activePreset === preset.id}
            className={`theme-preset ${activePreset === preset.id ? 'active' : ''}`}
            key={preset.id}
            onClick={() => setPalette({ accent: preset.accent, canvas: preset.canvas })}
            title={`${preset.canvas} · ${preset.accent}`}
            type="button"
          >
            <span className="theme-preset-swatches" style={{ background: preset.canvas }}>
              <span style={{ background: preset.accent }} />
            </span>
            <span>{t(`theme.preset.${preset.id}`)}</span>
          </button>
        ))}
      </div>

      <div className="theme-color-fields">
        <ThemeColorField
          color={palette.canvas}
          hint={t('theme.canvasHint')}
          label={t('theme.canvas')}
          onChange={canvas => setPalette(current => ({ ...current, canvas }))}
        />
        <ThemeColorField
          color={palette.accent}
          hint={t('theme.accentHint')}
          label={t('theme.accent')}
          onChange={accent => setPalette(current => ({ ...current, accent }))}
        />
      </div>
    </section>
  )
}

export const themePlugin: DesktopPlugin = {
  id: 'theme',
  Provider: ThemeProvider,
  settings: { Component: ThemeSettings, slot: 'general' }
}
