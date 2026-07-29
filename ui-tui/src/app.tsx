import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import TextInput from 'ink-text-input'

import type { GatewayClient } from './gatewayClient.js'
import { Markdown, type Theme } from './markdown.js'
import type { GatewayEvent, Message, ProgressState, SessionInfo, VerificationResult } from './types.js'

const theme: Theme = {
  accent: '#C97B5A',
  code: '#C97B5A',
  dim: '#8A857D',
  error: '#E5534B',
  ok: '#3FB950',
  warn: '#D29922'
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function useSpinner(active: boolean) {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (!active) {
      return
    }
    const timer = setInterval(() => setFrame(value => (value + 1) % SPINNER_FRAMES.length), 80)
    return () => clearInterval(timer)
  }, [active])
  return active ? SPINNER_FRAMES[frame]! : ''
}

const APPROVAL_OPTIONS = [
  { id: 'once', label: 'Approve once' },
  { id: 'session', label: 'Approve for this session' },
  { id: 'reject', label: 'Reject' },
  { id: 'instruct', label: 'Tell Friday what to do' }
] as const

type ApprovalDecision = typeof APPROVAL_OPTIONS[number]['id']

const HELP_TEXT = `# Friday commands

| Command | What it does |
| --- | --- |
| \`/help\` | Show this command reference. |
| \`/new\` | Start a new conversation in the current workspace. |
| \`/memory [help]\` | Inspect or manage persistent memory. |
| \`/model [id]\` | List configured models or switch the active model. |
| \`/context\` | Print current context usage. |
| \`/progress\` | Show the current objective and plan. |
| \`/trace\` | Open the local Trace Workbench. |
| \`/compact\` | Summarize the live conversation into a fresh context. |
| \`/goal <text>\` | Loop until the verifier passes, blocks, needs approval, or is cancelled. |
| \`/resume\` | Resume recent Friday session context. |
| \`/session list|rename|delete\` | Manage saved conversations. |
| \`/undo\` | Restore the workspace and conversation to before the latest Friday turn. |
| \`/permission manual|bypass\` | Request approval for risky commands or grant full access. |
| \`/approve\` | Open the pending approval choices. |
| \`/reject\` | Open the pending approval choices with Reject selected. |
| \`/reset\` | Clear Friday state for the current project. |
| \`/exit\` | Close the TUI. \`/quit\` works too. |
`

export function App({ gateway }: { gateway: GatewayClient }) {
  const app = useApp()
  const activeTurn = useRef<string | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [toolsExpanded, setToolsExpanded] = useState(false)
  const [info, setInfo] = useState<SessionInfo | null>(null)
  const [progress, setProgress] = useState<ProgressState | null>(null)
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [resumePicker, setResumePicker] = useState<ResumePicker | null>(null)
  const [approvalPicker, setApprovalPicker] = useState<ApprovalPicker | null>(null)
  const [streaming, setStreaming] = useState('')
  const [activity, setActivity] = useState('')
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const onEvent = (event: GatewayEvent) => {
      if (event.type === 'gateway.ready') {
        void gateway.request<SessionInfo>('session.info').then(value => {
          setInfo(value)
          setProgress(value.progress ?? null)
        })
      } else if (event.type === 'message.delta') {
        setStreaming(text => text + event.payload.text)
      } else if (event.type === 'message.complete') {
        if (event.payload.text) {
          setMessages(items => [...items, { metrics: event.payload.metrics, role: 'assistant', text: event.payload.text }])
        }
        activeTurn.current = null
        setProgress(event.payload.progress ?? null)
        setStreaming('')
        setBusy(false)
      } else if (event.type === 'tool.start') {
        const startMs = Date.now()
        setMessages(items => addToolRun(items, activeTurn.current, { arguments: event.payload.arguments, id: event.payload.tool_call_id || `${startMs}-${items.length}`, name: event.payload.name, startMs }))
        setActivity(`tool ${event.payload.name}`)
      } else if (event.type === 'tool.complete') {
        const endMs = Date.now()
        setMessages(items => updateToolRun(items, activeTurn.current, event.payload.tool_call_id, { content: event.payload.content, endMs, error: event.payload.error }))
        const approval = approvalFromContent(event.payload.content)
        if (approval) {
          setApprovalPicker(current => current ?? { approval, index: approvalIndex('once'), instruction: '' })
        }
        setActivity(event.payload.error ? `tool ${event.payload.name} failed` : '')
      } else if (event.type === 'approval.pending') {
        setApprovalPicker(current => current ?? { approval: { ...event.payload, pending: true }, index: approvalIndex('once'), instruction: '' })
        setBusy(false)
      } else if (event.type === 'approval.resolved') {
        setApprovalPicker(null)
        setBusy(false)
      } else if (event.type === 'verification.start') {
        setActivity('verifying')
        setMessages(items => updateVerification(items, activeTurn.current, { running: true }))
      } else if (event.type === 'verification.complete') {
        setActivity('')
        setMessages(items => updateVerification(items, activeTurn.current, event.payload))
      } else if (event.type === 'progress.update') {
        setProgress(event.payload)
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
    if (approvalPicker) {
      if (key.upArrow) {
        setApprovalPicker(picker => picker && { ...picker, index: Math.max(0, picker.index - 1) })
      } else if (key.downArrow) {
        setApprovalPicker(picker => picker && { ...picker, index: Math.min(APPROVAL_OPTIONS.length - 1, picker.index + 1) })
      } else if (key.return) {
        submitApproval(approvalPicker)
      } else if (key.escape) {
        setApprovalPicker(null)
      }
      return
    }
    if (resumePicker) {
      if (key.upArrow || char === 'k') {
        setResumePicker(picker => picker && { ...picker, index: Math.max(0, picker.index - 1) })
      } else if (key.downArrow || char === 'j') {
        setResumePicker(picker => picker && { ...picker, index: Math.min(picker.choices.length - 1, picker.index + 1) })
      } else if (key.return) {
        const choice = resumePicker.choices[resumePicker.index]
        if (choice) {
          setResumePicker(null)
          void gateway.request<{ count: number; progress?: ProgressState }>('session.resume', { id: choice.id }).then(result => {
            setProgress(result.progress ?? null)
            setMessages(items => [...items, { role: 'system', text: `Resumed session (${result.count} turns): ${choice.objective || choice.user}` }])
          })
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
    () => ({ app, gateway, setApprovalPicker, setInfo, setMessages, setProgress, setResumePicker }),
    [app, gateway]
  )

  const submit = (value: string) => {
    const text = cleanInput(value)
    if (!text || busy) {
      return
    }
    setInput('')
    const goal = goalText(text)
    if (goal != null) {
      if (!goal) {
        setMessages(items => [...items, { role: 'system', text: 'Usage: /goal describe the goal' }])
        return
      }
      setBusy(true)
      setStreaming('')
      const turnId = `turn-${Date.now()}`
      activeTurn.current = turnId
      setMessages(items => [...items, { role: 'user', text: `/goal ${goal}`, turnId }])
      void gateway.request('goal.run', { text: goal }).catch(error => {
        activeTurn.current = null
        setBusy(false)
        setStreaming('')
        setMessages(items => [...items, { role: 'system', text: error.message }])
      })
      return
    }
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
      setStreaming('')
      setMessages(items => [...items, { role: 'system', text: error.message }])
    })
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Header activity={activity} busy={busy} info={info} progress={progress} />
      <Box flexDirection="column" gap={1} marginTop={1}>
        {messages.slice(-10).map((message, index) => <MessageLine toolsExpanded={toolsExpanded} key={index} message={message} now={now} />)}
        {streaming ? <MessageLine message={{ role: 'assistant', text: streaming }} /> : null}
      </Box>
      {resumePicker ? <ResumePickerView picker={resumePicker} /> : null}
      {approvalPicker ? (
        <ApprovalPickerView
          onInstructionChange={instruction => setApprovalPicker(picker => picker && { ...picker, instruction })}
          picker={approvalPicker}
        />
      ) : null}
      <Composer busy={busy || Boolean(resumePicker) || Boolean(approvalPicker)} input={input} onChange={setInput} onSubmit={submit} />
    </Box>
  )

  function handleApprovalResult(result: unknown, rejected: boolean) {
    if (isContinuedApproval(result)) {
      return
    }
    setBusy(false)
    setMessages(items => [...items, { role: 'system', text: rejected ? 'Command rejected.' : 'Command approved.' }])
  }

  function submitApproval(picker: ApprovalPicker) {
    const instruction = picker.instruction.trim()
    const decision = APPROVAL_OPTIONS[picker.index]?.id
    if (!decision || (decision === 'instruct' && !instruction)) {
      return
    }
    const rejected = decision === 'reject' || decision === 'instruct'
    const method = decision === 'reject' ? 'approval.reject' : decision === 'instruct' ? 'approval.instruct' : 'approval.approve'
    const params = decision === 'session' ? { session: true } : decision === 'instruct' ? { text: instruction } : undefined
    if (decision === 'instruct') {
      const turnId = `turn-${Date.now()}`
      activeTurn.current = turnId
      setMessages(items => [...items, { role: 'user', text: instruction, turnId }])
    }
    setApprovalPicker(null)
    setBusy(true)
    void gateway.request(method, params).then(result =>
      handleApprovalResult(result, rejected)
    ).catch(error => {
      activeTurn.current = null
      setBusy(false)
      setMessages(items => [...items, { role: 'system', text: error.message }])
    })
  }
}

function cleanInput(value: string) {
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
}

function goalText(value: string) {
  const match = value.match(/^\/goal(?:\s+(.*))?$/i)
  return match ? (match[1] ?? '').trim() : null
}

function isContinuedApproval(result: unknown) {
  return Boolean(result && typeof result === 'object' && (result as { continued?: unknown }).continued)
}

function runCommand(
  text: string,
  {
    app,
    gateway,
    setApprovalPicker,
    setInfo,
    setMessages,
    setProgress,
    setResumePicker,
  }: {
    app: ReturnType<typeof useApp>
    gateway: GatewayClient
    setApprovalPicker: React.Dispatch<React.SetStateAction<ApprovalPicker | null>>
    setInfo: React.Dispatch<React.SetStateAction<SessionInfo | null>>
    setMessages: React.Dispatch<React.SetStateAction<UiMessage[]>>
    setProgress: React.Dispatch<React.SetStateAction<ProgressState | null>>
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
  } else if (command === '/new') {
    void gateway.request('session.new').then(() => {
      setProgress(null)
      setMessages([])
    })
  } else if (command.startsWith('/memory')) {
    void gateway.request<{ text: string }>('memory.command', { command: text.slice('/memory'.length).trim() }).then(result =>
      setMessages(items => [...items, { role: 'system', text: result.text }])
    )
  } else if (text.trim().toLowerCase() === '/model') {
    void gateway.request<{
      active: string
      profiles: Array<{ api_key_configured: boolean; id: string; model: string; name: string; provider: string; vision: boolean }>
    }>('model.list').then(result => {
      const lines = result.profiles.map(profile => {
        const active = profile.id === result.active ? '*' : ' '
        const vision = profile.vision ? ' [vision]' : ''
        const key = profile.api_key_configured ? 'key configured' : 'key missing'
        return `${active} ${profile.id}: ${profile.name} (${profile.provider}/${profile.model})${vision} - ${key}`
      })
      setMessages(items => [...items, { role: 'system', text: lines.join('\n') }])
    })
  } else if (command === '/model') {
    const id = text.slice('/model'.length).trim()
    void gateway.request<{ info: SessionInfo }>('model.select', { id }).then(result => {
      setInfo(result.info)
      setMessages(items => [...items, { role: 'system', text: `Model: ${result.info.model}` }])
    })
  } else if (command.startsWith('/context')) {
    void gateway.request<{ text: string }>('context.get').then(result =>
      setMessages(items => [...items, { role: 'system', text: result.text }])
    )
  } else if (command.startsWith('/progress')) {
    void gateway.request<{ progress: ProgressState }>('progress.get').then(result => {
      setProgress(result.progress)
      setMessages(items => [...items, { role: 'system', text: formatProgress(result.progress) }])
    })
  } else if (command.startsWith('/trace')) {
    void gateway.request<{ url: string }>('trace.serve').then(result =>
      setMessages(items => [...items, { role: 'system', text: `Trace Workbench: ${result.url}` }])
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
  } else if (command === '/session list') {
    void gateway.request<{ choices: ResumeChoice[] }>('session.resume_choices').then(result => {
      const lines = result.choices.map(choice =>
        `${choice.id}\t${choice.title || choice.objective || choice.user || 'Conversation'}`
      )
      setMessages(items => [...items, { role: 'system', text: lines.length ? lines.join('\n') : 'No saved conversations.' }])
    })
  } else if (command.startsWith('/session rename ')) {
    const parts = text.trim().split(/\s+/, 4)
    const title = text.trim().split(/\s+/).slice(3).join(' ')
    if (parts.length < 4 || !title) {
      setMessages(items => [...items, { role: 'system', text: 'Usage: /session rename <id> <title>' }])
    } else {
      void gateway.request<{ title: string }>('session.rename', { id: parts[2], title }).then(result =>
        setMessages(items => [...items, { role: 'system', text: `Renamed ${parts[2]}: ${result.title}` }])
      )
    }
  } else if (command.startsWith('/session delete ')) {
    const id = text.slice('/session delete '.length).trim()
    void gateway.request('session.delete', { id }).then(() =>
      setMessages(items => [...items, { role: 'system', text: `Deleted session ${id}.` }])
    )
  } else if (command.startsWith('/undo')) {
    const id = text.slice('/undo'.length).trim() || undefined
    void gateway.request<{ changed_paths: string[]; progress: ProgressState; user: string }>('checkpoint.undo', { id }).then(result => {
      setProgress(result.progress)
      setMessages(items => [
        ...removeLastTurn(items),
        {
          role: 'system',
          text: `Undid: ${result.user || 'latest Friday turn'}\nRestored ${result.changed_paths.length} workspace path${result.changed_paths.length === 1 ? '' : 's'}.`
        }
      ])
    }).catch(error =>
      setMessages(items => [...items, { role: 'system', text: error.message }])
    )
  } else if (command.startsWith('/permission')) {
    const requested = text.slice('/permission'.length).trim().toLowerCase()
    const mode = requested === 'full' ? 'bypass' : requested === 'ask' ? 'manual' : requested
    if (!['manual', 'accept-edits', 'dont-ask', 'bypass'].includes(mode)) {
      setMessages(items => [...items, { role: 'system', text: 'Usage: /permission manual|bypass' }])
    } else {
      void gateway.request<{ permission_mode: SessionInfo['permission_mode'] }>('permission.set', { mode }).then(result => {
        setInfo(current => current && { ...current, permission_mode: result.permission_mode })
        setMessages(items => [...items, { role: 'system', text: `Permission mode: ${result.permission_mode}` }])
      })
    }
  } else if (command.startsWith('/approve')) {
    openApprovalPicker(gateway, setApprovalPicker, setMessages, 'once')
  } else if (command.startsWith('/reject')) {
    openApprovalPicker(gateway, setApprovalPicker, setMessages, 'reject')
  } else if (command.startsWith('/reset')) {
    void gateway.request('session.reset').then(() => {
      setProgress(null)
      setMessages(items => [...items, { role: 'system', text: 'Reset Friday for this project.' }])
    })
  } else {
    setMessages(items => [...items, { role: 'system', text: `Unknown command: ${command}. Try /help.` }])
  }
  return true
}

type UiMessage = Message & {
  tools?: ToolRun[]
  turnId?: string
  verification?: VerificationStatus
}

type VerificationStatus = VerificationResult & {
  running?: boolean
}

type ResumeChoice = {
  assistant: string
  id: string
  objective: string
  status: string
  time: string
  title: string
  turns: string
  user: string
}

type ResumePicker = {
  choices: ResumeChoice[]
  index: number
}

type Approval = {
  command?: string
  id?: string
  max_chars?: number
  message?: string
  pending?: boolean
  reason?: string
  timeout_seconds?: number
}

type ApprovalPicker = {
  approval: Approval
  index: number
  instruction: string
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

function updateToolRun(messages: UiMessage[], turnId: string | null, id: string, patch: Partial<ToolRun>) {
  const index = turnIndex(messages, turnId)
  if (index === -1) {
    return messages
  }
  const next = [...messages]
  const message = next[index]!
  const tools = [...(message.tools ?? [])]
  const toolIndex = tools.findIndex(run => run.id === id)
  if (toolIndex === -1) {
    return messages
  }
  tools[toolIndex] = { ...tools[toolIndex]!, ...patch }
  next[index] = { ...message, tools }
  return next
}

function updateVerification(messages: UiMessage[], turnId: string | null, verification: VerificationStatus) {
  const index = turnIndex(messages, turnId)
  if (index === -1) {
    return messages
  }
  const next = [...messages]
  next[index] = { ...next[index]!, verification }
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

function Header({ activity, busy, info, progress }: { activity: string; busy: boolean; info: SessionInfo | null; progress: ProgressState | null }) {
  const spinner = useSpinner(busy)
  const cwd = info?.cwd ?? process.cwd()
  const status = activity || (busy ? 'thinking' : 'ready')
  const model = info?.model_name || info?.model || 'loading model'
  const tools = info?.tools.length ?? 0
  const permissions = info?.permission_mode === 'bypass' ? 'full access' : 'request approval'
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.accent}>●</Text>
        <Text bold> Friday</Text>
        <Text color={theme.dim}>  agent · /help for commands · Ctrl+O tools</Text>
      </Box>
      <Text color={theme.dim} wrap="truncate-end">{cwd}</Text>
      {progress?.objective ? <ProgressLine progress={progress} /> : null}
      <Box>
        {busy ? <Text color={theme.warn}>{spinner} </Text> : <Text color={theme.ok}>● </Text>}
        <Text color={busy ? theme.warn : theme.ok}>{status}</Text>
        <Text color={theme.dim}> · {shortModel(model)} · {tools} tools · {permissions}</Text>
      </Box>
    </Box>
  )
}

function removeLastTurn(messages: UiMessage[]) {
  const index = turnIndex(messages, null)
  return index === -1 ? messages : messages.slice(0, index)
}

function ProgressLine({ progress }: { progress: ProgressState }) {
  const steps = progress.steps ?? []
  const completed = steps.filter(step => step.status === 'completed').length
  const count = steps.length ? ` · ${completed}/${steps.length}` : ''
  const next = progress.next_action ? ` · next: ${shortText(progress.next_action, 60)}` : ''
  const color = progress.status === 'done' ? theme.ok : progress.status === 'blocked' ? theme.error : progress.status === 'waiting' ? theme.warn : theme.accent
  return <Text color={color} wrap="truncate-end">task {progress.status ?? 'working'} · {shortText(progress.objective ?? '', 90)}{count}{next}</Text>
}

function MessageLine({ toolsExpanded = false, message, now = Date.now() }: { toolsExpanded?: boolean; message: UiMessage; now?: number; streaming?: boolean }) {
  if (message.role === 'user') {
    return (
      <Box>
        <Text color={theme.accent}>❯ </Text>
        <Box flexDirection="column">
          <Text bold wrap="wrap">{message.text}</Text>
          <ToolPanel toolsExpanded={toolsExpanded} now={now} runs={message.tools ?? []} />
          {message.verification ? <VerificationLine verification={message.verification} /> : null}
        </Box>
      </Box>
    )
  }
  if (message.role === 'assistant') {
    return (
      <Box>
        <Text color={theme.accent}>● </Text>
        <Box flexDirection="column">
          <Markdown text={message.text} theme={theme} />
          {message.metrics ? <Metrics metrics={message.metrics} /> : null}
        </Box>
      </Box>
    )
  }
  return <Markdown text={message.text} theme={{ ...theme, text: theme.dim }} />
}

function VerificationLine({ verification }: { verification: VerificationStatus }) {
  if (verification.running) {
    return <Text color={theme.warn}>● verifying…</Text>
  }
  const status = verification.approval_required ? 'approval pending' : verification.error ? 'error' : verification.verdict ?? (verification.passed ? 'pass' : 'failed')
  const passing = status === 'pass'
  const color = passing ? theme.ok : status === 'repair' || status === 'inconclusive' || status === 'approval pending' ? theme.warn : theme.error
  return <Text color={color}>{passing ? '✓' : color === theme.warn ? '!' : '✗'} verification: {status}</Text>
}

function ToolPanel({ toolsExpanded, now, runs }: { toolsExpanded: boolean; now: number; runs: ToolRun[] }) {
  if (!runs.length) {
    return null
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.dim}>tools (Ctrl+O)</Text>
      {runs.slice(-6).map(run => {
        const done = Boolean(run.endMs)
        const color = !done ? theme.warn : run.error ? theme.error : theme.ok
        const seconds = formatSeconds(((run.endMs ?? now) - run.startMs) / 1000)
        const brief = toolBrief(run)
        return (
          <Box flexDirection="column" key={run.id}>
            <Text wrap="truncate-end">
              <Text color={color}>●</Text>
              <Text> {run.name} </Text>
              <Text color={theme.dim}>{done ? (run.error ? 'failed' : 'done') : 'running'} {seconds}{brief ? ` ${brief}` : ''}</Text>
            </Text>
            {toolsExpanded ? <ToolDetails run={run} /> : null}
          </Box>
        )
      })}
    </Box>
  )
}

function ResumePickerView({ picker }: { picker: ResumePicker }) {
  return (
    <Box borderColor={theme.dim} borderStyle="round" flexDirection="column" marginTop={1} paddingX={1}>
      <Text>
        <Text bold color={theme.accent}>Resume session</Text>
        <Text color={theme.dim}>  ↑↓ choose · enter confirm · esc cancel</Text>
      </Text>
      {picker.choices.map((choice, index) => {
        const selected = index === picker.index
        return (
          <Box flexDirection="column" key={choice.id}>
            <Text wrap="truncate-end">
              <Text color={selected ? theme.accent : theme.dim}>{selected ? '❯ ' : '  '}</Text>
              <Text color={selected ? undefined : theme.dim}>{choice.time || choice.id} · {choice.turns} turns · {choice.status || 'unknown'} · {choice.title || choice.objective || choice.user}</Text>
            </Text>
            {selected && choice.assistant ? <Text color={theme.dim} wrap="truncate-end">    {choice.assistant}</Text> : null}
          </Box>
        )
      })}
    </Box>
  )
}

function ApprovalPickerView({ onInstructionChange, picker }: { onInstructionChange: (value: string) => void; picker: ApprovalPicker }) {
  const decision = APPROVAL_OPTIONS[picker.index]?.id
  return (
    <Box borderColor={theme.warn} borderStyle="round" flexDirection="column" marginTop={1} paddingX={1}>
      <Text>
        <Text bold color={theme.warn}>Approval required</Text>
        <Text color={theme.dim}>  ↑↓ choose · enter confirm · esc dismiss</Text>
      </Text>
      <Text wrap="wrap">{shortText(picker.approval.command || 'unknown command', 160)}</Text>
      {picker.approval.reason ? <Text color={theme.dim}>reason: {picker.approval.reason}</Text> : null}
      <Box flexDirection="column" marginTop={1}>
        {APPROVAL_OPTIONS.map((option, index) => {
          const selected = index === picker.index
          const color = selected ? (option.id === 'reject' ? theme.error : theme.accent) : theme.dim
          return <Text color={color} key={option.id}>{selected ? '◉ ' : '○ '}{option.label}</Text>
        })}
        <Box>
          <Text color={decision === 'instruct' ? theme.accent : theme.dim}>  ❯ </Text>
          <TextInput
            focus={decision === 'instruct'}
            onChange={onInstructionChange}
            placeholder="Use another approach..."
            value={picker.instruction}
          />
        </Box>
      </Box>
    </Box>
  )
}

function ToolDetails({ run }: { run: ToolRun }) {
  const output = formatToolOutput(run)
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {run.arguments == null ? null : <Text color={theme.dim} wrap="truncate-end">args {shortText(JSON.stringify(run.arguments), 500)}</Text>}
      {output ? <Text color={run.error ? theme.error : undefined} wrap="truncate-end">out {shortText(output, 900)}</Text> : null}
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

function approvalFromContent(content?: string): Approval | null {
  if (!content) {
    return null
  }
  try {
    const parsed = JSON.parse(content) as Approval & { approval_required?: boolean }
    return parsed.approval_required ? parsed : null
  } catch {
    return null
  }
}

function openApprovalPicker(
  gateway: GatewayClient,
  setApprovalPicker: React.Dispatch<React.SetStateAction<ApprovalPicker | null>>,
  setMessages: React.Dispatch<React.SetStateAction<UiMessage[]>>,
  decision: ApprovalDecision
) {
  void gateway.request<Approval>('approval.pending').then(approval => {
    if (approval.pending) {
      setApprovalPicker({ approval, index: approvalIndex(decision), instruction: '' })
    } else {
      setMessages(items => [...items, { role: 'system', text: approval.message || 'No pending approval.' }])
    }
  })
}

function shortText(value: string, max: number) {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}

function formatSeconds(seconds: number) {
  return `${Math.max(0, seconds).toFixed(1)}s`
}

function approvalIndex(decision: ApprovalDecision) {
  return APPROVAL_OPTIONS.findIndex(option => option.id === decision)
}

function formatProgress(progress: ProgressState) {
  if (!progress.objective) {
    return 'No active session progress.'
  }
  const lines = [`[${progress.status ?? 'working'}] ${progress.objective}`]
  for (const step of progress.steps ?? []) {
    const mark = step.status === 'completed' ? '[x]' : step.status === 'in_progress' ? '[>]' : step.status === 'blocked' ? '[!]' : '[ ]'
    lines.push(`${mark} ${step.step}`)
  }
  if (progress.next_action) {
    lines.push(`next: ${progress.next_action}`)
  }
  return lines.join('\n')
}

function Composer({ busy, input, onChange, onSubmit }: { busy: boolean; input: string; onChange: (value: string) => void; onSubmit: (value: string) => void }) {
  const rule = '─'.repeat(Math.max(20, (process.stdout.columns ?? 80) - 2))
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.dim}>{rule}</Text>
      <Box>
        <Text color={busy ? theme.dim : theme.accent}>{busy ? '…' : '❯'} </Text>
        <TextInput focus={!busy} onChange={onChange} onSubmit={onSubmit} placeholder="Ask Friday or /help" value={input} />
      </Box>
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
      in {input} · out {output} · {seconds}
    </Text>
  )
}

function shortModel(model: string) {
  return model.split('/').pop()?.replace(/[-_]/g, ' ') || model
}
