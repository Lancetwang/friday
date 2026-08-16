import React from 'react'
import { Box, Text } from 'ink'
import TextInput from 'ink-text-input'

import type { Theme } from './markdown.js'

export const COMMANDS = [
  { name: '/help', detail: 'Show available commands' },
  { name: '/new', detail: 'Start a new conversation' },
  { name: '/login', detail: 'Configure a model provider API key' },
  { name: '/model', detail: 'Choose a configured model and thinking level' },
  { name: '/search', detail: 'Configure a Web Search provider API key' },
  { name: '/memory', detail: 'Browse, view, and delete stored memories' },
  { name: '/plugins', detail: 'Switch plugins on or off' },
  { name: '/context', detail: 'Show current context usage' },
  { name: '/trace', detail: 'Toggle the Trace Workbench' },
  { name: '/compact', detail: 'Compact the current conversation' },
  { name: '/clear', detail: 'Delete and clear the current conversation' },
  { name: '/resume', detail: 'Switch to or delete a saved conversation' },
  { name: '/permission', detail: 'Choose approval behavior' },
  { name: '/fork', detail: 'Fork from the latest Friday response' },
  { name: '/branches', detail: 'Navigate the fork map with ↑↓←→, Enter, Ctrl+D' },
  { name: '/goal', detail: 'Run a strongly verified goal' },
  { name: '/queue', detail: 'Run a message after the current turn finishes' },
  { name: '/exit', detail: 'Close Friday' },
] as const

export type CommandChoice = typeof COMMANDS[number]

export type MenuKind =
  | 'login'
  | 'memory'
  | 'memory-delete'
  | 'model'
  | 'permission'
  | 'plugins'
  | 'resume'
  | 'resume-delete'
  | 'search'
  | 'thinking'

export type MenuOption = {
  data?: unknown
  detail?: string
  id: string
  keywords?: string
  label: string
}

export type PickerMenu = {
  footer?: string
  index: number
  kind: MenuKind
  options: MenuOption[]
  parent?: PickerMenu
  query: string
  title: string
}

export function commandChoices(input: string): CommandChoice[] {
  if (!input.startsWith('/')) return []
  const value = input.trimStart()
  if (/\s/.test(value)) return []
  const head = value.toLowerCase()
  return COMMANDS.filter(command => command.name.startsWith(head))
}

export function filteredOptions(menu: PickerMenu): MenuOption[] {
  const query = menu.query.trim().toLowerCase()
  if (!query) return menu.options
  return menu.options.filter(option =>
    `${option.label} ${option.id} ${option.keywords || ''}`
      .toLowerCase()
      .split(/\s+/)
      .some(part => part.startsWith(query))
  )
}

export function selectedOption(menu: PickerMenu): MenuOption | undefined {
  const options = filteredOptions(menu)
  return options[Math.min(menu.index, Math.max(0, options.length - 1))]
}

export function moveSelection(menu: PickerMenu, delta: number): PickerMenu {
  const count = filteredOptions(menu).length
  if (!count) return { ...menu, index: 0 }
  return { ...menu, index: (menu.index + delta + count) % count }
}

export function updateQuery(menu: PickerMenu, query: string): PickerMenu {
  return { ...menu, index: 0, query }
}

export function CommandPalette({ choices, index, theme }: { choices: CommandChoice[]; index: number; theme: Theme }) {
  if (!choices.length) return null
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {choices.map((choice, itemIndex) => {
        const selected = itemIndex === Math.min(index, choices.length - 1)
        return (
          <Text key={choice.name} color={selected ? theme.accent : theme.dim} wrap="truncate-end">
            <Text bold={selected}>{choice.name}</Text>  {choice.detail}
          </Text>
        )
      })}
    </Box>
  )
}

export function PickerView({
  menu,
  onQuery,
  onSubmit,
  theme,
}: {
  menu: PickerMenu
  onQuery: (query: string) => void
  onSubmit: () => void
  theme: Theme
}) {
  const options = filteredOptions(menu)
  const index = Math.min(menu.index, Math.max(0, options.length - 1))
  const start = Math.max(0, Math.min(index - 4, options.length - 9))
  const shown = options.slice(start, start + 9)
  return (
    <Box borderColor={theme.dim} borderStyle="round" flexDirection="column" marginTop={1} paddingX={1}>
      <Text>
        <Text bold color={theme.accent}>{menu.title}</Text>
        <Text color={theme.dim}>  ↑↓ choose · enter confirm · esc back</Text>
      </Text>
      <Box>
        <Text color={theme.dim}>search › </Text>
        <TextInput focus onChange={onQuery} onSubmit={onSubmit} placeholder="type a prefix" value={menu.query} />
      </Box>
      {shown.length ? shown.map((option, shownIndex) => {
        const selected = start + shownIndex === index
        return (
          <Text color={selected ? theme.accent : theme.dim} key={option.id} wrap="truncate-end">
            {selected ? '[•]' : '[ ]'} <Text bold={selected}>{option.label}</Text>{option.detail ? `  ${option.detail}` : ''}
          </Text>
        )
      }) : <Text color={theme.warn}>No matching items</Text>}
      {menu.footer ? <Text color={theme.dim}>{menu.footer}</Text> : null}
    </Box>
  )
}
