import React from 'react'
import { Box, Text } from 'ink'

const FENCE_RE = /^\s*```(.*)$/
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*)$/
const BULLET_RE = /^(\s*)[-*+]\s+(.*)$/
const NUMBER_RE = /^(\s*)\d+[.)]\s+(.*)$/
const QUOTE_RE = /^\s*>\s?(.*)$/
const HR_RE = /^\s*([-*_])(?:\s*\1){2,}\s*$/
const TABLE_DIVIDER_RE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/
const INLINE_RE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|https?:\/\/\S+)/g

export interface Theme {
  accent: string
  dim: string
  text: string
  panelBg: string
  panelText: string
  code: string
  ok: string
  warn: string
  error: string
}

export function Markdown({ text, theme }: { text: string; theme: Theme }) {
  const lines = text.split('\n')
  const nodes: React.ReactNode[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i] ?? ''
    const key = nodes.length

    if (!line.trim()) {
      nodes.push(<Text key={key}> </Text>)
      i++
      continue
    }

    if (line.includes('|') && TABLE_DIVIDER_RE.test(lines[i + 1] ?? '')) {
      const rows = [splitTableRow(line)]
      for (i += 2; i < lines.length && lines[i]!.includes('|') && lines[i]!.trim(); i++) {
        rows.push(splitTableRow(lines[i]!))
      }
      nodes.push(<Table key={key} rows={rows} theme={theme} />)
      continue
    }

    const fence = line.match(FENCE_RE)
    if (fence) {
      const lang = fence[1]?.trim()
      const block: string[] = []
      for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i] ?? ''); i++) {
        block.push(lines[i] ?? '')
      }
      if (i < lines.length) {
        i++
      }
      nodes.push(
        <Box flexDirection="column" key={key} paddingLeft={2}>
          {lang ? <Text color={theme.dim}>-- {lang}</Text> : null}
          {block.map((row, index) => <CodeLine key={index} line={row} theme={theme} />)}
        </Box>
      )
      continue
    }

    const heading = line.match(HEADING_RE)?.[2]
    if (heading) {
      nodes.push(
        <Text bold color={theme.accent} key={key} wrap="wrap">
          {renderInline(heading, theme)}
        </Text>
      )
      i++
      continue
    }

    if (HR_RE.test(line)) {
      nodes.push(<Text color={theme.dim} key={key}>------------------------------------</Text>)
      i++
      continue
    }

    const quote = line.match(QUOTE_RE)?.[1]
    if (quote != null) {
      nodes.push(
        <Text color={theme.dim} key={key} wrap="wrap">
          | {renderInline(quote, theme)}
        </Text>
      )
      i++
      continue
    }

    const bullet = line.match(BULLET_RE)
    if (bullet) {
      nodes.push(
        <Box key={key} paddingLeft={indent(bullet[1] ?? '')}>
          <Text wrap="wrap">
            <Text color={theme.dim}>- </Text>
            {renderInline(bullet[2] ?? '', theme)}
          </Text>
        </Box>
      )
      i++
      continue
    }

    const numbered = line.match(NUMBER_RE)
    if (numbered) {
      nodes.push(
        <Box key={key} paddingLeft={indent(numbered[1] ?? '')}>
          <Text wrap="wrap">
            <Text color={theme.dim}># </Text>
            {renderInline(numbered[2] ?? '', theme)}
          </Text>
        </Box>
      )
      i++
      continue
    }

    nodes.push(
      <Text key={key} wrap="wrap">
        {renderInline(line, theme)}
      </Text>
    )
    i++
  }

  return <Box flexDirection="column">{nodes}</Box>
}

function CodeLine({ line, theme }: { line: string; theme: Theme }) {
  const color = line.startsWith('+') ? theme.ok : line.startsWith('-') ? theme.error : line.startsWith('@@') ? theme.warn : theme.code
  return <Text color={color}>{line || ' '}</Text>
}

function Table({ rows, theme }: { rows: string[][]; theme: Theme }) {
  if (!rows.length) {
    return null
  }
  const cols = rows[0]?.length ?? 0
  const widths = Array.from({ length: cols }, (_, index) =>
    Math.max(...rows.map(row => display(stripInline(row[index] ?? ''))), 3)
  )

  const [head, ...body] = rows.map(row => row.map((cell, index) => pad(stripInline(cell), widths[index] ?? 3)).join('  '))

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text bold color={theme.accent}>{head}</Text>
      {body.length ? <Text color={theme.text}>{body.join('\n')}</Text> : null}
    </Box>
  )
}

function indent(value: string) {
  return Math.floor(value.replace(/\t/g, '  ').length / 2) * 2
}

function splitTableRow(row: string) {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(cell => cell.trim())
}

function stripInline(value: string) {
  return value
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
}

function display(value: string) {
  return [...value].length
}

function pad(value: string, width: number) {
  return value + ' '.repeat(Math.max(0, width - display(value)))
}

function renderInline(text: string, theme: Theme) {
  const nodes: React.ReactNode[] = []
  let last = 0

  for (const match of text.matchAll(INLINE_RE)) {
    const start = match.index ?? 0
    const raw = match[0]
    if (start > last) {
      nodes.push(text.slice(last, start))
    }
    if (raw.startsWith('`')) {
      nodes.push(<Text color={theme.code} key={nodes.length}>{raw.slice(1, -1)}</Text>)
    } else if (raw.startsWith('**')) {
      nodes.push(<Text bold key={nodes.length}>{raw.slice(2, -2)}</Text>)
    } else if (raw.startsWith('*')) {
      nodes.push(<Text italic key={nodes.length}>{raw.slice(1, -1)}</Text>)
    } else {
      nodes.push(<Text color={theme.accent} underline key={nodes.length}>{raw}</Text>)
    }
    last = start + raw.length
  }

  if (last < text.length) {
    nodes.push(text.slice(last))
  }

  return nodes.length ? nodes : text
}
