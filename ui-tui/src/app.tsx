import React, { useEffect, useMemo, useState } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import TextInput from 'ink-text-input'

import type { GatewayClient } from './gatewayClient.js'
import { Markdown, type Theme } from './markdown.js'
import type { GatewayEvent, Message, SessionInfo } from './types.js'

const theme: Theme = {
  accent: '#2F81F7',
  code: '#93C5FD',
  dim: '#7AA2D6',
  error: '#F85149',
  ok: '#3FB950',
  panelBg: '#E5E7EB',
  panelText: '#111827',
  text: '#DBEAFE',
  warn: '#D29922'
}

const primary = '#1D4ED8'

const HELP_TEXT = `# Friday commands

| Command | What it does |
| --- | --- |
| \`/help\` | Show this command reference. |
| \`/details\` | Toggle verbose tool arguments in the status line. |
| \`/memory\` | Print the effective prompt, including user, project, and memory context. |
| \`/compact\` | Summarize the live conversation into a fresh context. |
| \`/reset\` | Clear Friday project state and global Friday user state. |
| \`/exit\` | Close the TUI. \`/quit\` works too. |
`

export function App({ gateway }: { gateway: GatewayClient }) {
  const app = useApp()
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [details, setDetails] = useState(false)
  const [info, setInfo] = useState<SessionInfo | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [streaming, setStreaming] = useState('')
  const [activity, setActivity] = useState('')

  useEffect(() => {
    const onEvent = (event: GatewayEvent) => {
      if (event.type === 'gateway.ready') {
        void gateway.request<SessionInfo>('session.info').then(setInfo)
      } else if (event.type === 'message.delta') {
        setStreaming(text => text + event.payload.text)
      } else if (event.type === 'message.complete') {
        setMessages(items => [...items, { metrics: event.payload.metrics, role: 'assistant', text: event.payload.text }])
        setStreaming('')
        setBusy(false)
      } else if (event.type === 'tool.start') {
        const suffix = details && event.payload.arguments ? ` ${JSON.stringify(event.payload.arguments)}` : ''
        setActivity(`tool ${event.payload.name}${suffix}`)
      } else if (event.type === 'tool.complete') {
        setActivity(event.payload.error ? `tool ${event.payload.name} failed` : '')
      } else if (event.type === 'gateway.stderr') {
        setActivity(event.payload.line)
      } else if (event.type === 'gateway.protocol_error') {
        setActivity(`protocol noise: ${event.payload.preview}`)
      }
    }

    gateway.on('event', onEvent)
    gateway.on('exit', () => app.exit())
    return () => {
      gateway.off('event', onEvent)
    }
  }, [app, details, gateway])

  useInput((char, key) => {
    if (key.ctrl && char.toLowerCase() === 'c') {
      if (input) {
        setInput('')
      } else {
        gateway.kill()
        app.exit()
      }
    }
  })

  const commandContext = useMemo(
    () => ({ app, details, gateway, setDetails, setMessages }),
    [app, details, gateway]
  )

  const submit = (value: string) => {
    const text = cleanInput(value)
    if (!text || busy) {
      return
    }
    setInput('')
    if (runCommand(text, commandContext)) {
      return
    }

    setBusy(true)
    setStreaming('')
    setMessages(items => [...items, { role: 'user', text }])
    void gateway.request('chat.send', { text }).catch(error => {
      setBusy(false)
      setMessages(items => [...items, { role: 'system', text: error.message }])
    })
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Header info={info} />
      <Box flexDirection="column" marginTop={1}>
        {messages.slice(-10).map((message, index) => <MessageLine key={index} message={message} />)}
        {streaming ? <MessageLine message={{ role: 'assistant', text: streaming }} streaming /> : null}
      </Box>
      <StatusRule activity={activity} busy={busy} details={details} info={info} />
      <Composer busy={busy} input={input} onChange={setInput} onSubmit={submit} />
    </Box>
  )
}

function cleanInput(value: string) {
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
}

function runCommand(
  text: string,
  {
    app,
    details,
    gateway,
    setDetails,
    setMessages,
  }: {
    app: ReturnType<typeof useApp>
    details: boolean
    gateway: GatewayClient
    setDetails: React.Dispatch<React.SetStateAction<boolean>>
    setMessages: React.Dispatch<React.SetStateAction<Message[]>>
  }
) {
  if (!text.startsWith('/')) {
    return false
  }
  const command = text.split(/\s+/, 1)[0].toLowerCase()
  if (command.startsWith('/exit') || command.startsWith('/quit')) {
    gateway.kill()
    app.exit()
  } else if (command.startsWith('/help')) {
    setMessages(items => [...items, { role: 'system', text: HELP_TEXT }])
  } else if (command.startsWith('/details')) {
    setDetails(value => !value)
    setMessages(items => [...items, { role: 'system', text: `Tool details ${details ? 'off' : 'on'}.` }])
  } else if (command.startsWith('/memory')) {
    void gateway.request<{ text: string }>('prompt.get').then(result =>
      setMessages(items => [...items, { role: 'system', text: result.text }])
    )
  } else if (command.startsWith('/compact')) {
    void gateway.request<{ text: string }>('session.compact').then(result =>
      setMessages(items => [...items, { role: 'system', text: `Compacted conversation:\n\n${result.text}` }])
    )
  } else if (command.startsWith('/reset')) {
    void gateway.request('session.reset').then(() => setMessages(items => [...items, { role: 'system', text: 'Reset Friday.' }]))
  } else {
    setMessages(items => [...items, { role: 'system', text: `Unknown command: ${command}. Try /help.` }])
  }
  return true
}

function Header({ info }: { info: SessionInfo | null }) {
  const cwd = info?.cwd ?? process.cwd()
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color={primary}>Friday</Text>
        <Text color={theme.dim}> agent </Text>
        <Text color={theme.accent}>/help</Text>
        <Text color={theme.dim}> for commands</Text>
      </Box>
      <Text color={theme.dim} wrap="truncate-end">{cwd}</Text>
    </Box>
  )
}

function MessageLine({ message, streaming = false }: { message: Message; streaming?: boolean }) {
  const role = roleMeta(message.role)
  const assistantTheme = message.role === 'assistant'
    ? { ...theme, accent: primary, code: primary, dim: '#4B5563', text: theme.panelText }
    : theme
  return (
    <Box flexDirection="column" marginBottom={message.role === 'user' ? 1 : 0} marginTop={message.role === 'user' ? 1 : 0}>
      <Box>
        <Box width={4}>
          <Text bold={message.role === 'user'} color={role.color}>{role.glyph}</Text>
        </Box>
        <Box flexDirection="column">
          {streaming ? <Text color={theme.dim}>streaming...</Text> : null}
          {message.role === 'user' ? (
            <Text color={role.color}>{message.text}</Text>
          ) : (
            <>
              {message.role === 'assistant' ? (
                <Box backgroundColor={theme.panelBg} flexDirection="column" paddingX={1}>
                  <Markdown text={message.text} theme={assistantTheme} />
                </Box>
              ) : (
                <Markdown text={message.text} theme={assistantTheme} />
              )}
              {message.metrics ? <Metrics metrics={message.metrics} /> : null}
            </>
          )}
        </Box>
      </Box>
    </Box>
  )
}

function roleMeta(role: Message['role']) {
  if (role === 'user') {
    return { color: primary, glyph: 'YOU' }
  }
  if (role === 'assistant') {
    return { color: theme.text, glyph: 'FRI' }
  }
  if (role === 'tool') {
    return { color: theme.warn, glyph: 'TOO' }
  }
  return { color: theme.dim, glyph: 'SYS' }
}

function StatusRule({ activity, busy, details, info }: { activity: string; busy: boolean; details: boolean; info: SessionInfo | null }) {
  const left = activity || (busy ? 'thinking' : 'ready')
  const model = info?.model ?? 'loading model'
  const tools = info?.tools.length ?? 0
  return (
    <Box height={1} marginTop={1}>
      <Text color={theme.dim}>-- </Text>
      <Text color={busy ? theme.warn : theme.ok}>{left}</Text>
      <Text color={theme.dim}> | {shortModel(model)} | {tools} tools | details {details ? 'on' : 'off'}</Text>
    </Box>
  )
}

function Composer({ busy, input, onChange, onSubmit }: { busy: boolean; input: string; onChange: (value: string) => void; onSubmit: (value: string) => void }) {
  const rule = '━'.repeat(Math.max(20, (process.stdout.columns ?? 80) - 2))
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.dim}>{rule}</Text>
      <Box>
        <Text color={busy ? theme.warn : theme.accent}>{busy ? '...' : '>'} </Text>
        <TextInput focus={!busy} onChange={onChange} onSubmit={onSubmit} placeholder="Ask Friday or type /help" value={input} />
      </Box>
      <Text color={theme.dim}>{rule}</Text>
    </Box>
  )
}

function Metrics({ metrics }: { metrics: NonNullable<Message['metrics']> }) {
  const mark = metrics.estimated_tokens ? '~' : ''
  const input = metrics.input_tokens == null ? 'n/a' : `${mark}${metrics.input_tokens}`
  const output = metrics.output_tokens == null ? 'n/a' : `${mark}${metrics.output_tokens}`
  const seconds = metrics.elapsed_ms == null ? 'n/a' : `${(metrics.elapsed_ms / 1000).toFixed(1)}s`
  return (
    <Text color={theme.dim}>
      in {input} | out {output} | {seconds}
    </Text>
  )
}

function shortModel(model: string) {
  return model.split('/').pop()?.replace(/[-_]/g, ' ') || model
}
