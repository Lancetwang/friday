import type { ComponentType, PropsWithChildren } from 'react'

export type DesktopSettingsSlot = 'general'

export type DesktopPlugin = {
  id: string
  Provider?: ComponentType<PropsWithChildren>
  settings?: {
    Component: ComponentType
    slot: DesktopSettingsSlot
  }
}
