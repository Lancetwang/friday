import React, { useEffect, useState } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import TextInput from 'ink-text-input'

import type { GatewayClient } from './gatewayClient.js'
import type { GatewayEvent, Message, SessionInfo } from './types.js'

const accent = '#39c5bb'
const blue = '#2f81f7'
const dim = '#9aa4b2'
const white = '#f0f6fc'
const dark = '#30363d'

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
        setMessages(items => [...items, { role: 'assistant', text: event.payload.text }])
        setStreaming('')
        setBusy(false)
      } else if (event.type === 'tool.start') {
        const suffix = details && event.payload.arguments ? ` ${JSON.stringify(event.payload.arguments)}` : ''
        setActivity(`Tool ${event.payload.name}${suffix}`)
      } else if (event.type === 'tool.complete') {
        setActivity(event.payload.error ? `Tool ${event.payload.name} failed` : '')
      } else if (event.type === 'gateway.stderr') {
        setActivity(event.payload.line)
      } else if (event.type === 'gateway.protocol_error') {
        setActivity(`Protocol noise: ${event.payload.preview}`)
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

  const submit = (value: string) => {
    const text = cleanInput(value)
    if (!text || busy) {
      return
    }
    setInput('')
    if (runCommand(text, { app, details, gateway, setDetails, setMessages })) {
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
      <Header info={info} busy={busy} details={details} />
      <Box flexDirection="column" marginTop={1} minHeight={8}>
        {messages.slice(-8).map((message, index) => <MessageLine key={index} message={message} />)}
        {streaming ? <MessageLine message={{ role: 'assistant', text: streaming }} /> : null}
      </Box>
      <StatusLine activity={activity} busy={busy} />
      <Box borderColor={busy ? 'yellow' : accent} borderStyle="round" marginTop={1} paddingX={1}>
        <Text color={busy ? 'yellow' : blue}>{busy ? 'wait ' : '> '}</Text>
        <TextInput focus={!busy} onChange={setInput} onSubmit={submit} placeholder="Ask Friday" value={input} />
      </Box>
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
    setMessages(items => [...items, { role: 'system', text: 'Commands: /help /details /memory /reset /exit' }])
  } else if (command.startsWith('/details')) {
    setDetails(value => !value)
    setMessages(items => [...items, { role: 'system', text: `Tool details ${details ? 'off' : 'on'}` }])
  } else if (command.startsWith('/memory')) {
    void gateway.request<{ text: string }>('prompt.get').then(result =>
      setMessages(items => [...items, { role: 'system', text: result.text }])
    )
  } else if (command.startsWith('/reset')) {
    void gateway.request('session.reset').then(() => setMessages(items => [...items, { role: 'system', text: 'Reset Friday' }]))
  } else {
    setMessages(items => [...items, { role: 'system', text: `Unknown command: ${command}` }])
  }
  return true
}

function Header({ info, busy, details }: { busy: boolean; details: boolean; info: SessionInfo | null }) {
  const cwd = info?.cwd ?? process.cwd()
  const tools = info?.tools.length ?? 0
  return (
    <Box borderColor={accent} borderStyle="round" flexDirection="column" paddingX={2} paddingY={1}>
      <Box>
        <Text bold color={blue}>Friday</Text>
        <Text color={dim}> | </Text>
        <Text color={busy ? 'yellow' : 'green'}>{busy ? 'busy' : 'ready'}</Text>
        <Text color={dim}> | {info?.model ?? 'loading model'} | {tools} tools | details {details ? 'on' : 'off'}</Text>
      </Box>
      <Text color={white}>{cwd}</Text>
      <Box marginTop={1}>
        <Text color={dim}>/help</Text>
        <Text color={dim}>  /details</Text>
        <Text color={dim}>  /memory</Text>
        <Text color={dim}>  /reset</Text>
        <Text color={dim}>  /exit</Text>
      </Box>
    </Box>
  )
}

function MessageLine({ message }: { message: Message }) {
  const color = message.role === 'user' ? blue : message.role === 'assistant' ? white : message.role === 'tool' ? 'yellow' : dim
  const label = message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Friday' : message.role === 'system' ? 'System' : message.role
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={color}>{label}</Text>
      <Box borderColor={message.role === 'system' ? dark : color} borderStyle="single" paddingX={1}>
        <Text color={message.role === 'system' ? dim : white}>{message.text}</Text>
      </Box>
    </Box>
  )
}

function StatusLine({ activity, busy }: { activity: string; busy: boolean }) {
  const text = activity || (busy ? 'Friday is thinking...' : 'Ready')
  return (
    <Box>
      <Text backgroundColor={dark} color={busy ? 'yellow' : white}> {text} </Text>
    </Box>
  )
}
