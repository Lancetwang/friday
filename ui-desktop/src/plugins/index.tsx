import { type PropsWithChildren, type ReactNode } from 'react'

import { themePlugin } from './theme'
import type { DesktopPlugin, DesktopSettingsSlot } from './types'

const plugins: DesktopPlugin[] = [themePlugin]

export function DesktopPluginProviders({ children }: PropsWithChildren) {
  return plugins.reduceRight<ReactNode>((content, plugin) => {
    const Provider = plugin.Provider
    return Provider ? <Provider>{content}</Provider> : content
  }, children)
}

export function DesktopPluginSettings({ slot }: { slot: DesktopSettingsSlot }) {
  return plugins.map(plugin => {
    const settings = plugin.settings
    if (!settings || settings.slot !== slot) return null
    const Component = settings.Component
    return <Component key={plugin.id} />
  })
}

export { useThemePlugin } from './theme'
