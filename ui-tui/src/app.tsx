import React, { useEffect, useState } from 'react'
import { Box, Newline, Static, Text, useApp, useInput } from 'ink'
import TextInput from 'ink-text-input'

import type { GatewayClient } from './gatewayClient.js'
import type { GatewayEvent, Message, SessionInfo } from './types.js'

const accent = '#39c5bb'
const blue = '#2f81f7'

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

  useInput((_, key) => {
    if (key.ctrl && _.toLowerCase() === 'c') {
      if (input) {
        setInput('')
      } else {
        gateway.kill()
        app.exit()
      }
    }
  })

  const submit = (value: string) => {
    const text = value.trim()
    if (!text || busy) {
      return
    }
    setInput('')
    if (text === '/exit' || text === '/quit') {
      gateway.kill()
      app.exit()
      return
    }
    if (text === '/help') {
      setMessages(items => [...items, { role: 'system', text: '/help /details /memory /reset /exit' }])
      return
    }
    if (text === '/details') {
      setDetails(value => !value)
      setMessages(items => [...items, { role: 'system', text: `tool details ${details ? 'off' : 'on'}` }])
      return
    }
    if (text === '/memory') {
      void gateway.request<{ text: string }>('prompt.get').then(result =>
        setMessages(items => [...items, { role: 'system', text: result.text }])
      )
      return
    }
    if (text === '/reset') {
      void gateway.request('session.reset').then(() => setMessages(items => [...items, { role: 'system', text: 'reset Friday' }]))
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
    <Box flexDirection="column">
      <Header info={info} busy={busy} details={details} />
      <Box flexDirection="column" marginTop={1}>
        <Static items={messages}>
          {(message, index) => <MessageLine key={index} message={message} />}
        </Static>
        {streaming ? <MessageLine message={{ role: 'assistant', text: streaming }} /> : null}
      </Box>
      {activity ? <Text color="yellow">{activity}</Text> : null}
      <Box marginTop={1}>
        <Text color={busy ? 'yellow' : blue}>{busy ? '… ' : '> '}</Text>
        <TextInput focus={!busy} onChange={setInput} onSubmit={submit} placeholder="Ask Friday" value={input} />
      </Box>
    </Box>
  )
}

function Header({ info, busy, details }: { busy: boolean; details: boolean; info: SessionInfo | null }) {
  const cwd = info?.cwd ?? process.cwd()
  const tools = info?.tools.length ?? 0
  return (
    <Box flexDirection="column">
      <Text color={accent}>
        Friday TUI <Text color={busy ? 'yellow' : 'green'}>{busy ? 'busy' : 'ready'}</Text>
        <Text color="gray"> · {info?.model ?? 'loading model'} · {tools} tools · details {details ? 'on' : 'off'}</Text>
      </Text>
      <Text color="gray">{cwd}</Text>
      <Text color="gray">/help /details /memory /reset /exit</Text>
    </Box>
  )
}

function MessageLine({ message }: { message: Message }) {
  const color = message.role === 'user' ? blue : message.role === 'assistant' ? 'white' : message.role === 'tool' ? 'yellow' : 'gray'
  const label = message.role === 'user' ? 'you' : message.role
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={color}>{label}</Text>
      <Text>{message.text}</Text>
      <Newline />
    </Box>
  )
}
