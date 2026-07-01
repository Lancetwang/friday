import React, { useEffect, useMemo, useRef, useState } from 'react'
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
| \`/memory\` | Print the effective prompt, including user, project, and memory context. |
| \`/compact\` | Summarize the live conversation into a fresh context. |
| \`/resume\` | Resume recent Friday session context. |
| \`/approve\` | Run the pending dangerous shell command. |
| \`/reject\` | Reject the pending dangerous shell command. |
| \`/reset\` | Clear Friday project state and global Friday user state. |
| \`/exit\` | Close the TUI. \`/quit\` works too. |
`

export function App({ gateway }: { gateway: GatewayClient }) {
  const app = useApp()
  const activeTurn = useRef<string | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [toolsExpanded, setToolsExpanded] = useState(false)
  const [info, setInfo] = useState<SessionInfo | null>(null)
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [resumePicker, setResumePicker] = useState<ResumePicker | null>(null)
  const [streaming, setStreaming] = useState('')
  const [activity, setActivity] = useState('')
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const onEvent = (event: GatewayEvent) => {
      if (event.type === 'gateway.ready') {
        void gateway.request<SessionInfo>('session.info').then(setInfo)
      } else if (event.type === 'message.delta') {
        setStreaming(text => text + event.payload.text)
      } else if (event.type === 'message.complete') {
        setMessages(items => [...items, { metrics: event.payload.metrics, role: 'assistant', text: event.payload.text }])
        activeTurn.current = null
        setStreaming('')
        setBusy(false)
      } else if (event.type === 'tool.start') {
        const startMs = Date.now()
        setMessages(items => addToolRun(items, activeTurn.current, { arguments: event.payload.arguments, id: `${startMs}-${items.length}`, name: event.payload.name, startMs }))
        setActivity(`tool ${event.payload.name}`)
      } else if (event.type === 'tool.complete') {
        const endMs = Date.now()
        setMessages(items => updateToolRun(items, activeTurn.current, event.payload.name, { content: event.payload.content, endMs, error: event.payload.error }))
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
  }, [app, gateway])

  useEffect(() => {
    if (!messages.some(message => message.tools?.some(run => !run.endMs))) {
      return
    }
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [messages])

  useInput((char, key) => {
    if (resumePicker) {
      if (key.upArrow || char === 'k') {
        setResumePicker(picker => picker && { ...picker, index: Math.max(0, picker.index - 1) })
      } else if (key.downArrow || char === 'j') {
        setResumePicker(picker => picker && { ...picker, index: Math.min(picker.choices.length - 1, picker.index + 1) })
      } else if (key.return) {
        const choice = resumePicker.choices[resumePicker.index]
        if (choice) {
          setResumePicker(null)
          void gateway.request<{ count: number }>('session.resume', { id: choice.id }).then(result =>
            setMessages(items => [...items, { role: 'system', text: `Resumed session (${result.count} turns): ${choice.user}` }])
          )
        }
      } else if (key.escape) {
        setResumePicker(null)
      }
      return
    }
    if (key.ctrl && (char.toLowerCase() === 'o' || char === '\u000f')) {
      setToolsExpanded(value => !value)
      setTimeout(() => setInput(value => value.endsWith('o') ? value.slice(0, -1) : value), 0)
      return
    }
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
    () => ({ app, gateway, setMessages, setResumePicker }),
    [app, gateway]
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
    const turnId = `turn-${Date.now()}`
    activeTurn.current = turnId
    setMessages(items => [...items, { role: 'user', text, turnId }])
    void gateway.request('chat.send', { text }).catch(error => {
      activeTurn.current = null
      setBusy(false)
      setMessages(items => [...items, { role: 'system', text: error.message }])
    })
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Header activity={activity} busy={busy} info={info} />
      <Box flexDirection="column" marginTop={1}>
        {messages.slice(-10).map((message, index) => <MessageLine toolsExpanded={toolsExpanded} key={index} message={message} now={now} />)}
        {streaming ? <MessageLine message={{ role: 'assistant', text: streaming }} streaming /> : null}
      </Box>
      {resumePicker ? <ResumePickerView picker={resumePicker} /> : null}
      <Composer busy={busy || Boolean(resumePicker)} input={input} onChange={setInput} onSubmit={submit} />
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
    gateway,
    setMessages,
    setResumePicker,
  }: {
    app: ReturnType<typeof useApp>
    gateway: GatewayClient
    setMessages: React.Dispatch<React.SetStateAction<UiMessage[]>>
    setResumePicker: React.Dispatch<React.SetStateAction<ResumePicker | null>>
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
  } else if (command.startsWith('/memory')) {
    void gateway.request<{ text: string }>('prompt.get').then(result =>
      setMessages(items => [...items, { role: 'system', text: result.text }])
    )
  } else if (command.startsWith('/compact')) {
    void gateway.request<{ text: string }>('session.compact').then(result =>
      setMessages(items => [...items, { role: 'system', text: `Compacted conversation:\n\n${result.text}` }])
    )
  } else if (command.startsWith('/resume')) {
    void gateway.request<{ choices: ResumeChoice[] }>('session.resume_choices').then(result => {
      if (result.choices.length) {
        setResumePicker({ choices: result.choices, index: 0 })
      } else {
        setMessages(items => [...items, { role: 'system', text: 'No recent sessions to resume.' }])
      }
    })
  } else if (command.startsWith('/approve')) {
    void gateway.request('approval.approve').then(result =>
      setMessages(items => [...items, { role: 'system', text: `Approval result:\n\n${JSON.stringify(result, null, 2)}` }])
    )
  } else if (command.startsWith('/reject')) {
    void gateway.request('approval.reject').then(result =>
      setMessages(items => [...items, { role: 'system', text: `Approval rejected:\n\n${JSON.stringify(result, null, 2)}` }])
    )
  } else if (command.startsWith('/reset')) {
    void gateway.request('session.reset').then(() => {
      setMessages(items => [...items, { role: 'system', text: 'Reset Friday.' }])
    })
  } else {
    setMessages(items => [...items, { role: 'system', text: `Unknown command: ${command}. Try /help.` }])
  }
  return true
}

type UiMessage = Message & {
  tools?: ToolRun[]
  turnId?: string
}

type ResumeChoice = {
  assistant: string
  id: string
  time: string
  turns: string
  user: string
}

type ResumePicker = {
  choices: ResumeChoice[]
  index: number
}

type ToolRun = {
  arguments?: unknown
  content?: string
  endMs?: number
  error?: boolean
  id: string
  name: string
  startMs: number
}

function addToolRun(messages: UiMessage[], turnId: string | null, run: ToolRun) {
  const index = turnIndex(messages, turnId)
  if (index === -1) {
    return messages
  }
  const next = [...messages]
  const message = next[index]!
  next[index] = { ...message, tools: [...(message.tools ?? []), run] }
  return next
}

function updateToolRun(messages: UiMessage[], turnId: string | null, name: string, patch: Partial<ToolRun>) {
  const index = turnIndex(messages, turnId)
  if (index === -1) {
    return messages
  }
  const next = [...messages]
  const message = next[index]!
  const tools = [...(message.tools ?? [])]
  const toolIndex = tools.map(run => !run.endMs && (!name || run.name === name)).lastIndexOf(true)
  if (toolIndex === -1) {
    return messages
  }
  tools[toolIndex] = { ...tools[toolIndex]!, ...patch }
  next[index] = { ...message, tools }
  return next
}

function turnIndex(messages: UiMessage[], turnId: string | null) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (turnId ? message.turnId === turnId : message.role === 'user') {
      return index
    }
  }
  return -1
}

function Header({ activity, busy, info }: { activity: string; busy: boolean; info: SessionInfo | null }) {
  const cwd = info?.cwd ?? process.cwd()
  const left = activity || (busy ? 'thinking' : 'ready')
  const model = info?.model ?? 'loading model'
  const tools = info?.tools.length ?? 0
  return (
    <Box borderColor={theme.accent} borderStyle="round" flexDirection="column" paddingX={2} paddingY={1}>
      <Box>
        <Text bold color={primary}>Friday</Text>
        <Text color={theme.dim}> agent </Text>
        <Text color={theme.dim}>/help commands | Ctrl+O tools</Text>
      </Box>
      <Text color={theme.dim} wrap="truncate-end">{cwd}</Text>
      <Text color={theme.dim}> </Text>
      <Box>
        <Text color={busy ? theme.warn : theme.ok}>{left}</Text>
        <Text color={theme.dim}> | {shortModel(model)} | {tools} tools</Text>
      </Box>
    </Box>
  )
}

function MessageLine({ toolsExpanded = false, message, now = Date.now(), streaming = false }: { toolsExpanded?: boolean; message: UiMessage; now?: number; streaming?: boolean }) {
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
            <>
              <Text color={role.color}>{message.text}</Text>
              <ToolPanel toolsExpanded={toolsExpanded} now={now} runs={message.tools ?? []} />
            </>
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

function ToolPanel({ toolsExpanded, now, runs }: { toolsExpanded: boolean; now: number; runs: ToolRun[] }) {
  if (!runs.length) {
    return null
  }
  return (
    <Box backgroundColor="#EAF2FF" flexDirection="column" marginTop={1} paddingX={1}>
      <Text color="#315A8A">tools (Ctrl+O)</Text>
      {runs.slice(-6).map(run => {
        const done = Boolean(run.endMs)
        const color = !done ? theme.warn : run.error ? theme.error : theme.ok
        const seconds = formatSeconds(((run.endMs ?? now) - run.startMs) / 1000)
        return (
          <Box flexDirection="column" key={run.id}>
            <Text color={color}>{done ? (run.error ? 'failed' : 'done') : 'running'} {run.name} {seconds} {toolBrief(run)}</Text>
            {toolsExpanded ? <ToolDetails run={run} /> : null}
          </Box>
        )
      })}
    </Box>
  )
}

function ResumePickerView({ picker }: { picker: ResumePicker }) {
  return (
    <Box borderColor={theme.accent} borderStyle="round" flexDirection="column" marginTop={1} paddingX={1}>
      <Text color={primary}>Resume session - Up/Down, Enter</Text>
      {picker.choices.map((choice, index) => (
        <Box flexDirection="column" key={choice.id}>
          <Text color={index === picker.index ? theme.warn : theme.text}>
            {index === picker.index ? '> ' : '  '}{choice.time || choice.id}  {choice.turns} turns  {choice.user}
          </Text>
          {choice.assistant ? <Text color={theme.dim}>    {choice.assistant}</Text> : null}
        </Box>
      ))}
    </Box>
  )
}

function ToolDetails({ run }: { run: ToolRun }) {
  const output = formatToolOutput(run)
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {run.arguments == null ? null : <Text color={theme.dim}>args {shortText(JSON.stringify(run.arguments), 500)}</Text>}
      {output ? <Text color={run.error ? theme.error : theme.text}>out {shortText(output, 900)}</Text> : null}
    </Box>
  )
}

function formatToolOutput(run: ToolRun) {
  if (!run.content) {
    return ''
  }
  try {
    const parsed = JSON.parse(run.content) as { exit_code?: unknown; output?: unknown; timed_out?: unknown }
    if (typeof parsed.output === 'string') {
      const meta = parsed.exit_code == null ? '' : `exit ${parsed.exit_code}${parsed.timed_out ? ' timed out' : ''}: `
      return meta + parsed.output
    }
  } catch {
    // plain tool output
  }
  return run.content
}

function toolBrief(run: ToolRun) {
  if (run.name !== 'Bash' || !run.arguments || typeof run.arguments !== 'object') {
    return ''
  }
  const command = (run.arguments as { command?: unknown }).command
  return typeof command === 'string' ? `- ${shortText(command, 80)}` : ''
}

function shortText(value: string, max: number) {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}

function formatSeconds(seconds: number) {
  return `${Math.max(0, seconds).toFixed(1)}s`
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
