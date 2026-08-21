import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink'
import TextInput from 'ink-text-input'

import type {
  CompactionSettings,
  ForkNode,
  ForkTree,
  HistoryItem,
  ModelCatalog,
  ModelProfile,
  ModelProvider,
  PluginInfo,
  ResumeChoice,
  SessionResult,
  WebSearchSettings
} from 'friday-agent-protocol'

import type { GatewayClient } from './gatewayClient.js'
import { Markdown, type Theme } from './markdown.js'
import {
  COMMANDS,
  CommandPalette,
  PickerView,
  commandChoices,
  moveSelection,
  selectedOption,
  updateQuery,
  type MenuOption,
  type PickerMenu,
} from './menu.js'
import type { ContextCompaction, GatewayEvent, Message, ProgressState, SessionInfo, VerificationResult } from './types.js'

const theme: Theme = {
  accent: '#4F6CD8',
  code: '#4F6CD8',
  dim: '#8A857D',
  error: '#E5534B',
  ok: '#3FB950',
  warn: '#D29922'
}

const APPROVAL_OPTIONS = [
  { id: 'once', label: 'Approve once' },
  { id: 'session', label: 'Approve for this session' },
  { id: 'reject', label: 'Reject' },
  { id: 'instruct', label: 'Tell Friday what to do' }
] as const

type ApprovalDecision = typeof APPROVAL_OPTIONS[number]['id']

const HELP_TEXT = `# Friday commands

${COMMANDS.map(command => `- \`${command.name}\` - ${command.detail}`).join('\n')}

Type any command prefix after \`/\`, then use ↑/↓ and Enter.`

/** How many restored messages are replayed into the scrollback on resume. */
const MAX_RESTORED_MESSAGES = 60

type SearchProvider = {
  configured: boolean
  id: 'anysearch' | 'tavily'
  label: string
}

type CredentialInput =
  | { kind: 'model'; parent: PickerMenu; provider: ModelProvider; value: string }
  | { kind: 'search'; parent: PickerMenu; provider: SearchProvider; value: string }

type MemoryRecord = {
  content: string
  count?: number
  id: string
  scope: string
}

type BranchNode = ForkNode
type BranchTree = ForkTree

type BranchRow = { depth: number; guide: string; node: BranchNode }

type BranchView = {
  confirmDelete: boolean
  index: number
  rows: BranchRow[]
  tree: BranchTree
}

/**
 * The turn Friday is working on right now. Everything that still changes -
 * thinking, tool runs, verification - lives here; finished turns move into the
 * static scrollback and are never re-rendered.
 */
type ActiveTurn = {
  text: string
  steers: string[]
  thinking: ThinkingBlock[]
  tools: ToolRun[]
  turnId: string | null
  verification?: VerificationStatus
}

export function App({ gateway }: { gateway: GatewayClient }) {
  const app = useApp()
  const { stdout } = useStdout()
  const activeTurn = useRef<string | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [toolsExpanded, setToolsExpanded] = useState(false)
  const [thinkingExpanded, setThinkingExpanded] = useState(false)
  const [info, setInfo] = useState<SessionInfo | null>(null)
  const infoRef = useRef<SessionInfo | null>(null)
  infoRef.current = info
  const [progress, setProgress] = useState<ProgressState | null>(null)
  // `history` renders once into terminal scrollback via <Static>; `active` is
  // the only message content the dynamic bottom frame repaints. Keeping that
  // frame small is what keeps the composer pinned and the screen from jumping.
  const [history, setHistory] = useState<UiMessage[]>([])
  const [staticKey, setStaticKey] = useState(0)
  // The ref is the synchronous source of truth for the live turn; the state
  // only mirrors it for rendering. Gateway events arrive between renders, so
  // deriving the ref from the last committed render would let a fast
  // completion read a stale turn and drop it from the scrollback.
  const [active, setActive] = useState<ActiveTurn | null>(null)
  const activeRef = useRef<ActiveTurn | null>(null)
  const mutateActive = (mutate: (turn: ActiveTurn | null) => ActiveTurn | null) => {
    activeRef.current = mutate(activeRef.current)
    setActive(activeRef.current)
  }
  const [menu, setMenu] = useState<PickerMenu | null>(null)
  const [branches, setBranches] = useState<BranchView | null>(null)
  const [credential, setCredential] = useState<CredentialInput | null>(null)
  const [commandIndex, setCommandIndex] = useState(0)
  const [approvalPicker, setApprovalPicker] = useState<ApprovalPicker | null>(null)
  const [streaming, setStreaming] = useState('')
  const [activity, setActivity] = useState('')
  const [now, setNow] = useState(Date.now())
  const [queued, setQueued] = useState<string[]>([])
  const lastEscape = useRef(0)
  const traceOn = useRef(false)

  useEffect(() => {
    const onEvent = (event: GatewayEvent) => {
      const eventSession = sessionId(event)
      const selectedSession = infoRef.current?.session_id
      if (eventSession && selectedSession && eventSession !== selectedSession) return
      if (event.type === 'gateway.ready') {
        void gateway.request<SessionInfo>('session.info').then(value => {
          infoRef.current = value
          setInfo(value)
          setProgress(value.progress ?? null)
          applyApproval(value)
        })
      } else if (event.type === 'session.info') {
        infoRef.current = event.payload
        setInfo(event.payload)
        applyApproval(event.payload)
      } else if (event.type === 'message.delta') {
        setStreaming(text => text + event.payload.text)
        mutateActive(turn => turn && closeOpenThinking(turn))
      } else if (event.type === 'message.complete') {
        const extra: UiMessage[] = []
        if (event.payload.text) extra.push({ metrics: event.payload.metrics, role: 'assistant', text: event.payload.text })
        const cutShort = stopReasonLine(event.payload.status)
        if (cutShort) extra.push({ role: 'system', text: cutShort })
        finishTurn(extra)
        activeTurn.current = null
        lastEscape.current = 0
        setProgress(event.payload.progress ?? null)
        setBusy(false)
        setActivity('')
      } else if (event.type === 'message.suspended') {
        setProgress(event.payload.progress ?? null)
        setStreaming('')
        setBusy(false)
        setActivity('Waiting for approval.')
      } else if (event.type === 'message.cancelled') {
        activeTurn.current = null
        lastEscape.current = 0
        mutateActive(turn => turn && closeOpenThinking(turn))
        finishTurn([])
        setBusy(false)
        setActivity('Response stopped.')
      } else if (event.type === 'reasoning.delta') {
        // Thinking effort "off" is a promise to hide reasoning: some providers
        // still stream it, so honor the choice here instead of rendering it.
        if (['off', 'none'].includes(infoRef.current?.thinking_effort || '')) return
        const id = event.payload.id || ''
        if (id && event.payload.text) {
          mutateActive(turn => upsertThinking(ensureTurn(turn), id, event.payload.text))
        }
      } else if (event.type === 'reasoning.complete') {
        mutateActive(turn => turn && completeThinking(turn, event.payload.id, Boolean(event.payload.error)))
      } else if (event.type === 'tool.start') {
        // The stream so far is transient narration interrupted by this tool
        // round; clearing it keeps rounds from concatenating into one
        // unreadable stream that the final answer then replaces.
        setStreaming('')
        const startMs = Date.now()
        mutateActive(turn => {
          const current = ensureTurn(turn)
          return {
            ...current,
            tools: [...current.tools, {
              arguments: event.payload.arguments,
              id: event.payload.tool_call_id || `${startMs}-${current.tools.length}`,
              name: event.payload.name,
              startMs
            }]
          }
        })
        setActivity(`tool ${event.payload.name}`)
      } else if (event.type === 'tool.update') {
        mutateActive(turn => turn && updateToolRun(turn, event.payload.tool_call_id, run => ({
          content: event.payload.content ?? run.content
        })))
      } else if (event.type === 'tool.complete') {
        const endMs = Date.now()
        // Prefer the backend-measured execution time: it excludes the event
        // round trip and stays accurate however long the tool really ran.
        mutateActive(turn => turn && updateToolRun(turn, event.payload.tool_call_id, run => ({
          content: event.payload.content,
          endMs: typeof event.payload.elapsed_ms === 'number' ? run.startMs + event.payload.elapsed_ms : endMs,
          error: event.payload.error
        })))
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
        setBusy(Boolean(event.payload.continued))
      } else if (event.type === 'message.steered') {
        mutateActive(turn => {
          const current = ensureTurn(turn)
          return { ...current, steers: [...current.steers, event.payload.text] }
        })
      } else if (event.type === 'message.start') {
        // A turn the gateway started on its own (queued or follow-up steers):
        // give it a bubble; locally-sent turns already created one.
        if (!activeTurn.current && event.payload.text) {
          setBusy(true)
          const turnId = `turn-${Date.now()}`
          activeTurn.current = turnId
          mutateActive(() => ({ text: event.payload.text, steers: [], thinking: [], tools: [], turnId }))
        }
      } else if (event.type === 'session.updated' && typeof event.payload.running === 'boolean') {
        setBusy(event.payload.running)
      } else if (event.type === 'permission.updated') {
        // Gateway-wide hot swap; may have been made from another view.
        const mode = event.payload.permission_mode
        if (infoRef.current) infoRef.current = { ...infoRef.current, permission_mode: mode }
        setInfo(value => value && { ...value, permission_mode: mode })
      } else if (event.type === 'verification.start') {
        setActivity('verifying')
        mutateActive(turn => ({ ...ensureTurn(turn), verification: { running: true } }))
      } else if (event.type === 'verification.complete') {
        setActivity('')
        mutateActive(turn => ({ ...ensureTurn(turn), verification: event.payload }))
      } else if (event.type === 'progress.update') {
        setProgress(event.payload)
      } else if (event.type === 'context.compacted') {
        const line = compactionLine(event.payload)
        setHistory(items => [...items, { role: 'system', text: line }])
        setActivity(shortText(line, 80))
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app, gateway])

  useEffect(() => {
    if (busy || approvalPicker || !queued.length) return
    const [next, ...rest] = queued
    setQueued(rest)
    sendChat(next!)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, approvalPicker, queued])

  useEffect(() => {
    const running = active && (
      active.tools.some(run => !run.endMs) || active.thinking.some(block => block.ended == null)
    )
    if (!running) {
      return
    }
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])

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
    if (branches) {
      handleBranchInput(branches, char, key)
      return
    }
    if (credential) {
      if (key.escape) {
        setCredential(null)
        setMenu(credential.parent)
      }
      return
    }
    if (menu) {
      if (key.upArrow) {
        setMenu(current => current && moveSelection(current, -1))
      } else if (key.downArrow) {
        setMenu(current => current && moveSelection(current, 1))
      } else if (key.escape) {
        setMenu(menu.parent ?? null)
      } else if (menu.kind === 'resume' && ((key.ctrl && char.toLowerCase() === 'd') || (key.delete && !menu.query))) {
        const choice = selectedOption(menu)?.data as ResumeChoice | undefined
        if (choice) {
          setMenu({
            index: 1,
            kind: 'resume-delete',
            options: [
              { data: choice, id: 'delete', label: `Delete ${resumeLabel(choice)}` },
              { id: 'cancel', label: 'Cancel' },
            ],
            parent: menu,
            query: '',
            title: 'Delete conversation?',
          })
        }
      } else if (menu.kind === 'memory' && ((key.ctrl && char.toLowerCase() === 'd') || (key.delete && !menu.query))) {
        const record = selectedOption(menu)?.data as MemoryRecord | undefined
        if (record) {
          setMenu({
            index: 1,
            kind: 'memory-delete',
            options: [
              { data: record, id: 'delete', label: `Forget: ${shortText(record.content, 60)}` },
              { id: 'cancel', label: 'Cancel' },
            ],
            parent: menu,
            query: '',
            title: 'Forget this memory?',
          })
        }
      }
      return
    }
    if (!busy && input.startsWith('/')) {
      const choices = commandChoices(input)
      if (key.upArrow && choices.length) {
        setCommandIndex(index => (index - 1 + choices.length) % choices.length)
        return
      }
      if (key.downArrow && choices.length) {
        setCommandIndex(index => (index + 1) % choices.length)
        return
      }
    }
    if (key.ctrl && (char.toLowerCase() === 'o' || char === '\u000f')) {
      setToolsExpanded(value => !value)
      stripLeakedChar('o')
      return
    }
    if (key.ctrl && (char.toLowerCase() === 't' || char === '\u0014')) {
      setThinkingExpanded(value => !value)
      stripLeakedChar('t')
      return
    }
    if (key.escape && busy) {
      const pressed = Date.now()
      if (pressed - lastEscape.current <= 750) {
        lastEscape.current = 0
        setActivity('Stopping...')
        // Stop means stop everything: locally queued messages and steers the
        // turn never delivered go back into the composer instead of firing a
        // surprise follow-up turn.
        const held = queued
        setQueued([])
        void gateway.request<{ dropped_steers?: string[] }>('chat.cancel').then(result => {
          const returned = [...(result.dropped_steers ?? []), ...held]
          if (returned.length) setInput(value => value || returned.join(' '))
        }).catch(error => setActivity(error.message))
      } else {
        lastEscape.current = pressed
        setActivity('Press Esc again to stop the response.')
      }
      return
    }
    if (key.escape && input) {
      setInput('')
      setCommandIndex(0)
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

  const suggestions = useMemo(() => commandChoices(input), [input])

  const submit = (value: string) => {
    const text = cleanInput(value)
    if (!text) return
    if (busy && !canNavigateWhileBusy(text)) {
      if (text.startsWith('/')) {
        const queueText = text.match(/^\/queue\s+(.+)$/i)?.[1]?.trim()
        if (queueText) {
          setInput('')
          setQueued(items => [...items, queueText])
          appendSystem(`Queued (#${queued.length + 1}): ${shortText(queueText, 100)}`)
        }
        return
      }
      // A plain message while Friday is working steers the running turn: it
      // is injected before the next model step. If the turn just ended, run
      // it as the next message instead - nothing typed is lost.
      setInput('')
      void gateway.request('chat.steer', { text }).catch(() => {
        setQueued(items => [...items, text])
      })
      return
    }
    if (text.startsWith('/')) {
      const head = text.split(/\s+/, 1)[0]!.toLowerCase()
      if (!COMMANDS.some(command => command.name === head) && suggestions.length) {
        const selected = suggestions[Math.min(commandIndex, suggestions.length - 1)]!
        if (['/goal', '/memory', '/trace'].includes(selected.name)) {
          setInput(`${selected.name} `)
          setCommandIndex(0)
          return
        }
        setInput('')
        executeCommand(selected.name)
        return
      }
    }
    setInput('')
    setCommandIndex(0)
    const goal = goalText(text)
    if (goal != null) {
      if (!goal) {
        appendSystem('Usage: /goal describe the goal')
        return
      }
      beginTurn(`/goal ${goal}`)
      void gateway.request('goal.run', { text: goal }).catch(error => {
        failTurn(error)
      })
      return
    }
    if (executeCommand(text)) {
      return
    }

    sendChat(text)
  }

  function sendChat(text: string) {
    beginTurn(text)
    void gateway.request('chat.send', { text }).catch(error => {
      failTurn(error)
    })
  }

  return (
    <>
      <Static key={staticKey} items={history}>
        {(message, index) => (
          <Box key={index} marginBottom={1} paddingX={1}>
            <MessageLine message={message} now={now} thinkingExpanded={thinkingExpanded} toolsExpanded={toolsExpanded} />
          </Box>
        )}
      </Static>
      <Box flexDirection="column" paddingX={1}>
        {active ? (
          <Box marginBottom={streaming ? 1 : 0}>
            <MessageLine
              message={activeAsMessage(active)}
              now={now}
              tail
              thinkingExpanded={thinkingExpanded}
              toolsExpanded={toolsExpanded}
            />
          </Box>
        ) : null}
        {streaming ? <StreamTail text={streaming} /> : null}
        {menu ? (
          <PickerView
            menu={menu}
            onQuery={query => setMenu(current => current && updateQuery(current, query))}
            onSubmit={() => void chooseMenu(menu)}
            theme={theme}
          />
        ) : null}
        {branches ? <BranchesView active={info?.session_id || ''} view={branches} /> : null}
        {credential ? (
          <CredentialInputView
            credential={credential}
            onChange={value => setCredential(current => current && { ...current, value })}
            onSubmit={() => void saveCredential(credential)}
          />
        ) : null}
        {approvalPicker ? (
          <ApprovalPickerView
            onInstructionChange={instruction => setApprovalPicker(picker => picker && { ...picker, instruction })}
            picker={approvalPicker}
          />
        ) : null}
        <Header activity={activity} busy={busy} info={info} progress={progress} queued={queued.length} />
        {!menu && !branches && !credential && !approvalPicker ? (
          <>
            <Composer
              busy={busy}
              input={input}
              onChange={value => {
                setInput(value)
                setCommandIndex(0)
              }}
              onSubmit={submit}
            />
            {!busy ? <CommandPalette choices={suggestions} index={commandIndex} theme={theme} /> : null}
          </>
        ) : null}
      </Box>
    </>
  )

  /** Some terminals deliver Ctrl+letter as the bare letter too; drop the leak. */
  function stripLeakedChar(letter: string) {
    setTimeout(() => setInput(value => value.toLowerCase().endsWith(letter) ? value.slice(0, -1) : value), 0)
  }

  function beginTurn(text: string) {
    setBusy(true)
    lastEscape.current = 0
    setStreaming('')
    const turnId = `turn-${Date.now()}`
    activeTurn.current = turnId
    mutateActive(() => ({ text, steers: [], thinking: [], tools: [], turnId }))
  }

  /** Move the finished turn plus its results into the static scrollback. */
  function finishTurn(extra: UiMessage[]) {
    const turn = activeRef.current
    const settled = turn ? [activeAsMessage(closeOpenThinking(turn))] : []
    const additions = [...settled, ...extra]
    if (additions.length) setHistory(items => [...items, ...additions])
    mutateActive(() => null)
    setStreaming('')
  }

  function failTurn(error: unknown) {
    activeTurn.current = null
    setBusy(false)
    finishTurn([{ role: 'system', text: error instanceof Error ? error.message : String(error) }])
  }

  function appendSystem(text: string) {
    setHistory(items => [...items, { role: 'system', text }])
  }

  function requestError(error: unknown) {
    const text = error instanceof Error ? error.message : String(error)
    setActivity(text)
    appendSystem(text)
  }

  function applySession(result: SessionResult) {
    activeTurn.current = null
    infoRef.current = result.info
    setInfo(result.info)
    setProgress(result.progress ?? result.info.progress ?? null)
    // The old scrollback belongs to another conversation: clear the terminal
    // and remount <Static> so the restored transcript is rendered once, fresh.
    if (stdout.isTTY) stdout.write('\u001B[2J\u001B[3J\u001B[H')
    setStaticKey(value => value + 1)
    setHistory(restoredMessages(result.history ?? []))
    mutateActive(() => null)
    setStreaming('')
    setBusy(Boolean(result.info.running))
    applyApproval(result.info)
  }

  function applyApproval(value: SessionInfo) {
    const approval = value.approval
    setApprovalPicker(approval?.pending
      ? { approval, index: approvalIndex('once'), instruction: '' }
      : null)
  }

  function openLoginMenu() {
    setActivity('Loading providers...')
    void gateway.request<ModelCatalog>('model.list').then(catalog => {
      setActivity('')
      const providers = catalog.providers.filter(provider => provider.builtin)
      setMenu({
        index: 0,
        kind: 'login',
        options: providers.map(provider => ({
          data: provider,
          detail: provider.api_key_configured ? 'configured' : '',
          id: provider.id,
          keywords: provider.label,
          label: provider.label,
        })),
        query: '',
        title: 'Log in to a model provider',
      })
    }).catch(requestError)
  }

  function openModelMenu() {
    setActivity('Loading models...')
    void gateway.request<ModelCatalog>('model.list').then(catalog => {
      setActivity('')
      const profiles = catalog.profiles.filter(profile => profile.api_key_configured && profile.enabled)
      if (!profiles.length) {
        appendSystem('No configured models. Run /login first.')
        return
      }
      setMenu({
        index: Math.max(0, profiles.findIndex(profile => profile.id === catalog.active)),
        kind: 'model',
        options: profiles.map(profile => ({
          data: profile,
          detail: [profile.vision ? 'vision' : '', profile.id === catalog.active ? 'current' : ''].filter(Boolean).join(' · '),
          id: profile.id,
          keywords: `${profile.provider} ${profile.name}`,
          label: `${profile.model} [${profile.provider}]`,
        })),
        query: '',
        title: 'Choose a model',
      })
    }).catch(requestError)
  }

  function openSearchMenu() {
    setActivity('Loading search providers...')
    void gateway.request<WebSearchSettings>('settings.web.get').then(settings => {
      setActivity('')
      const providers: SearchProvider[] = [
        { configured: settings.tavily_configured, id: 'tavily', label: 'Tavily' },
        { configured: settings.anysearch_configured, id: 'anysearch', label: 'AnySearch' },
      ]
      setMenu({
        index: 0,
        kind: 'search',
        options: providers.map(provider => ({
          data: provider,
          detail: provider.configured ? 'configured' : '',
          id: provider.id,
          label: provider.label,
        })),
        query: '',
        title: 'Configure Web Search',
      })
    }).catch(requestError)
  }

  function openResumeMenu() {
    setActivity('Loading conversations...')
    void gateway.request<{ choices: ResumeChoice[] }>('session.resume_choices').then(result => {
      setActivity('')
      if (!result.choices.length) {
        appendSystem('No saved conversations to resume.')
        setMenu(null)
        return
      }
      setMenu(resumeMenu(result.choices, infoRef.current?.session_id))
    }).catch(requestError)
  }

  function openPermissionMenu() {
    const options: MenuOption[] = [
      { detail: 'ask before risky commands', id: 'manual', label: 'Request approval' },
      { detail: 'let Friday review risky commands', id: 'auto', label: 'Friday decides' },
      { detail: 'run without approval', id: 'bypass', label: 'Full access' },
    ]
    setMenu({
      index: Math.max(0, options.findIndex(option => option.id === info?.permission_mode)),
      kind: 'permission',
      options,
      query: '',
      title: 'Choose permission mode',
    })
  }

  function pluginMenu(plugins: PluginInfo[], selected = ''): PickerMenu {
    return {
      footer: 'Enter switches the selected plugin on or off',
      index: Math.max(0, plugins.findIndex(plugin => plugin.name === selected)),
      kind: 'plugins',
      options: plugins.map(plugin => ({
        data: plugin,
        detail: [
          plugin.disabled ? 'off' : 'on',
          plugin.required ? 'required' : plugin.scope,
          plugin.tools.length ? plugin.tools.join(', ') : '',
          plugin.capabilities?.filter(capability => capability !== 'tools').join(', ') || '',
          plugin.description,
          plugin.errors.length ? `error: ${plugin.errors[0]}` : ''
        ].filter(Boolean).join(' · '),
        id: plugin.name,
        keywords: `${plugin.description} ${plugin.scope}`,
        label: `${plugin.disabled ? '○' : '●'} ${plugin.name}`,
      })),
      query: '',
      title: 'Plugins',
    }
  }

  function openPluginMenu() {
    setActivity('Loading plugins...')
    void gateway.request<{ plugins: PluginInfo[] }>('plugin.list').then(result => {
      setActivity('')
      if (!result.plugins.length) {
        appendSystem('No plugins. Put an ES module in `.friday/plugins/` (project) or `~/.friday/plugins/` (user).')
        return
      }
      setMenu(pluginMenu(result.plugins))
    }).catch(requestError)
  }

  function memoryMenu(memories: MemoryRecord[], parent?: PickerMenu): PickerMenu {
    return {
      footer: 'Enter shows the full entry · Ctrl+D forgets it · /memory add <scope> <text> stores one',
      index: 0,
      kind: 'memory',
      options: memories.map(record => ({
        data: record,
        detail: `${record.scope}${(record.count ?? 1) > 1 ? ` · x${record.count}` : ''} · ${record.id}`,
        id: record.id,
        keywords: `${record.content} ${record.scope} ${record.id}`,
        label: shortText(record.content, 70),
      })),
      ...(parent ? { parent } : {}),
      query: '',
      title: 'Memory',
    }
  }

  function openMemoryMenu() {
    setActivity('Loading memory...')
    void gateway.request<{ result?: { memories?: MemoryRecord[] } }>('memory.command', { command: 'list' }).then(result => {
      setActivity('')
      const memories = result.result?.memories ?? []
      if (!memories.length) {
        appendSystem('No stored memories yet. Friday saves them as it works, or use `/memory add <scope> <text>`.')
        return
      }
      setMenu(memoryMenu(memories))
    }).catch(requestError)
  }

  function openBranchView() {
    setActivity('Loading branches...')
    void gateway.request<BranchTree>('session.tree').then(tree => {
      setActivity('')
      if (!tree.root || tree.nodes.length < 2) {
        appendSystem('This conversation has no branches yet. Use /fork to create one.')
        return
      }
      showBranchTree(tree)
    }).catch(requestError)
  }

  function showBranchTree(tree: BranchTree) {
    const rows = branchRows(tree)
    if (rows.length < 2) {
      appendSystem('This conversation has no branches yet. Use /fork to create one.')
      return
    }
    const current = infoRef.current?.session_id || ''
    setBranches({
      confirmDelete: false,
      index: Math.max(0, rows.findIndex(row => row.node.id === current)),
      rows,
      tree
    })
  }

  function handleBranchInput(view: BranchView, char: string, key: Parameters<Parameters<typeof useInput>[0]>[1]) {
    const selected = view.rows[view.index]?.node
    if (view.confirmDelete) {
      if (key.return || char.toLowerCase() === 'y') {
        setBranches(current => current && { ...current, confirmDelete: false })
        if (selected) deleteBranch(selected)
      } else if (key.escape || char.toLowerCase() === 'n') {
        setBranches(current => current && { ...current, confirmDelete: false })
      }
      return
    }
    if (key.escape) {
      setBranches(null)
    } else if (key.upArrow) {
      setBranches(current => current && { ...current, index: Math.max(0, current.index - 1) })
    } else if (key.downArrow) {
      setBranches(current => current && { ...current, index: Math.min(current.rows.length - 1, current.index + 1) })
    } else if (key.leftArrow) {
      // Left walks to the parent branch, mirroring /backward.
      setBranches(current => {
        if (!current) return current
        const node = current.rows[current.index]?.node
        const parentIndex = node ? current.rows.findIndex(row => row.node.id === node.parent) : -1
        return parentIndex >= 0 ? { ...current, index: parentIndex } : current
      })
    } else if (key.rightArrow) {
      // Right dives into the first child fork.
      setBranches(current => {
        if (!current) return current
        const node = current.rows[current.index]?.node
        const childIndex = node ? current.rows.findIndex(row => row.node.parent === node.id) : -1
        return childIndex >= 0 ? { ...current, index: childIndex } : current
      })
    } else if (key.return) {
      if (!selected) return
      if (selected.id === infoRef.current?.session_id) {
        setBranches(null)
        return
      }
      setBranches(null)
      setActivity('Switching branch...')
      void gateway.request<SessionResult>('session.resume', { id: selected.id }).then(result => {
        setActivity('')
        applySession(result)
        appendSystem(`Switched to branch: ${selected.title || selected.id}`)
      }).catch(requestError)
    } else if (key.ctrl && char.toLowerCase() === 'd') {
      if (!selected || selected.id === view.tree.root) {
        setActivity('The root conversation cannot be deleted from the branch map.')
        return
      }
      setBranches(current => current && { ...current, confirmDelete: true })
    }
  }

  function deleteBranch(node: BranchNode) {
    setActivity('Deleting branch...')
    void gateway.request<SessionResult & { deleted: string[] }>('session.delete', { id: node.id }).then(result => {
      setActivity('')
      const currentId = infoRef.current?.session_id || ''
      if (result.deleted.includes(currentId)) applySession(result)
      appendSystem(`Deleted branch: ${node.title || node.id}${result.deleted.length > 1 ? ` (+${result.deleted.length - 1} sub-branches)` : ''}`)
      void gateway.request<BranchTree>('session.tree').then(tree => {
        if (tree.root && tree.nodes.length > 1) showBranchTree(tree)
        else setBranches(null)
      }).catch(() => setBranches(null))
    }).catch(requestError)
  }

  async function chooseMenu(current: PickerMenu) {
    const option = selectedOption(current)
    if (!option) return
    try {
      if (current.kind === 'login') {
        setCredential({ kind: 'model', parent: current, provider: option.data as ModelProvider, value: '' })
        setMenu(null)
      } else if (current.kind === 'search') {
        setCredential({ kind: 'search', parent: current, provider: option.data as SearchProvider, value: '' })
        setMenu(null)
      } else if (current.kind === 'model') {
        const profile = option.data as ModelProfile
        const efforts = profile.thinking_options ?? []
        if (efforts.length) {
          setMenu({
            index: Math.max(0, efforts.indexOf(info?.thinking_effort || '')),
            kind: 'thinking',
            options: efforts.map(effort => ({ data: { effort, profile }, id: effort, label: thinkingLabel(effort) })),
            parent: current,
            query: '',
            title: `Thinking for ${profile.model}`,
          })
        } else {
          await selectModel(profile)
        }
      } else if (current.kind === 'thinking') {
        const selection = option.data as { effort: string; profile: ModelProfile }
        await selectModel(selection.profile, selection.effort)
      } else if (current.kind === 'permission') {
        const result = await gateway.request<{ permission_mode: SessionInfo['permission_mode'] }>('permission.set', { mode: option.id })
        setInfo(value => value && { ...value, permission_mode: result.permission_mode })
        setMenu(null)
        appendSystem(`Permission mode: ${permissionLabel(result.permission_mode)}.`)
      } else if (current.kind === 'resume') {
        const choice = option.data as ResumeChoice
        const result = await gateway.request<SessionResult>('session.resume', { id: choice.id })
        setMenu(null)
        applySession(result)
      } else if (current.kind === 'resume-delete') {
        if (option.id === 'cancel') {
          setMenu(current.parent ?? null)
          return
        }
        const choice = option.data as ResumeChoice
        const result = await gateway.request<SessionResult>('session.delete', { id: choice.id })
        applySession(result)
        openResumeMenu()
      } else if (current.kind === 'plugins') {
        const plugin = option.data as PluginInfo
        if (plugin.required && !plugin.disabled) {
          setActivity(`${plugin.name} is required and stays on.`)
          return
        }
        setActivity(`${plugin.disabled ? 'Enabling' : 'Disabling'} ${plugin.name}...`)
        const result = await gateway.request<{ info: SessionInfo; plugins: PluginInfo[] }>(
          'plugin.toggle', { enabled: plugin.disabled === true, name: plugin.name }
        )
        setActivity('')
        infoRef.current = result.info
        setInfo(result.info)
        setMenu(pluginMenu(result.plugins, plugin.name))
      } else if (current.kind === 'memory') {
        const record = option.data as MemoryRecord
        setMenu(null)
        appendSystem(`**Memory \`${record.id}\`** [${record.scope}]\n\n${record.content}`)
      } else if (current.kind === 'memory-delete') {
        if (option.id === 'cancel') {
          setMenu(current.parent ?? null)
          return
        }
        const record = option.data as MemoryRecord
        const result = await gateway.request<{ text: string }>('memory.command', { command: `remove ${record.id}` })
        appendSystem(result.text)
        openMemoryMenu()
      }
    } catch (error) {
      requestError(error)
    }
  }

  async function saveCredential(current: CredentialInput) {
    const apiKey = current.value.trim()
    if (!apiKey) return
    setActivity(`Connecting to ${current.provider.label}...`)
    try {
      if (current.kind === 'search') {
        await gateway.request<WebSearchSettings>('settings.web.save', {
          [`${current.provider.id}_api_key`]: apiKey,
        })
        setCredential(null)
        setActivity('')
        appendSystem(`${current.provider.label} Web Search is configured.`)
        return
      }
      const result = await gateway.request<{ catalog: ModelCatalog; info: SessionInfo }>('model.save', {
        activate: false,
        api_key: apiKey,
        profile: {
          base_url: current.provider.base_url,
          id: current.provider.id,
          model: '',
          name: current.provider.label,
          provider: current.provider.id,
        },
      })
      setInfo(result.info)
      setCredential(null)
      setActivity('')
      appendSystem(`${current.provider.label} is configured. Use /model to choose a model.`)
    } catch (error) {
      requestError(error)
    }
  }

  async function selectModel(profile: ModelProfile, effort?: string) {
    setActivity(`Selecting ${profile.model}...`)
    const selected = await gateway.request<{ info: SessionInfo }>('model.select', { id: profile.id })
    let nextInfo = selected.info
    if (effort) {
      nextInfo = (await gateway.request<{ info: SessionInfo }>('thinking.set', { effort })).info
    }
    setInfo(nextInfo)
    setMenu(null)
    setActivity('')
    appendSystem(`Model: ${nextInfo.model}${nextInfo.thinking_effort ? ` · thinking ${nextInfo.thinking_effort}` : ''}.`)
  }

  function executeCommand(text: string) {
    if (!text.startsWith('/')) return false
    const command = text.split(/\s+/, 1)[0]!.toLowerCase()
    const argument = text.slice(command.length).trim()
    if (command === '/exit') {
      gateway.kill()
      app.exit()
    } else if (command === '/help') {
      appendSystem(HELP_TEXT)
    } else if (command === '/new') {
      void gateway.request<SessionResult>('session.new').then(applySession).catch(requestError)
    } else if (command === '/login') {
      openLoginMenu()
    } else if (command === '/model') {
      openModelMenu()
    } else if (command === '/search') {
      openSearchMenu()
    } else if (command === '/memory') {
      // Bare /memory opens the browser; with arguments it stays a command
      // (`/memory add user ...`, `/memory status`, ...).
      if (argument) {
        void gateway.request<{ text: string }>('memory.command', { command: argument }).then(result => appendSystem(result.text)).catch(requestError)
      } else {
        openMemoryMenu()
      }
    } else if (command === '/context') {
      void gateway.request<{ text: string }>('context.get').then(result => appendSystem(result.text)).catch(requestError)
    } else if (command === '/compaction') {
      const words = argument.toLowerCase().split(/\s+/).filter(Boolean)
      let update: Record<string, unknown> | undefined
      if (words.length) {
        if (words[0] === 'auto' && ['on', 'off'].includes(words[1] || '')) {
          update = { automatic: words[1] === 'on' }
        } else if (words[0] === 'threshold' && /^\d+$/.test(words[1] || '')) {
          update = { threshold_percent: Number(words[1]) }
        } else if (words[0] === 'strategy' && ['insert', 'two-stage'].includes(words[1] || '')) {
          update = { strategy: words[1] }
        } else {
          appendSystem('Usage: /compaction [auto on|off | threshold 50..95 | strategy insert|two-stage]')
          return true
        }
      }
      const method = update ? 'settings.compaction.save' : 'settings.compaction.get'
      void gateway.request<CompactionSettings>(method, update).then(settings => appendSystem([
        '**Context compaction**',
        `- automatic: ${settings.automatic ? 'on' : 'off'}`,
        `- threshold: ${settings.threshold_percent}%`,
        `- strategy: ${settings.strategy}`,
        '',
        'Manual `/compact` remains available while a compaction plugin is enabled.'
      ].join('\n'))).catch(requestError)
    } else if (command === '/trace') {
      const mode = argument.toLowerCase()
      const start = () => gateway.request<{ url: string }>('trace.serve').then(result => {
        traceOn.current = true
        appendSystem(`Trace is running in the background: ${result.url}`)
      }).catch(requestError)
      const stop = () => gateway.request<{ stopped: boolean }>('trace.stop').then(result => {
        traceOn.current = false
        appendSystem(result.stopped ? 'Trace stopped.' : 'Trace was not running.')
      }).catch(requestError)
      if (mode === 'on') void start()
      else if (mode === 'off') void stop()
      else void (traceOn.current ? stop() : start())
    } else if (command === '/compact') {
      void gateway.request<{ text: string }>('session.compact').then(result => appendSystem(`Compacted conversation:\n\n${result.text}`)).catch(requestError)
    } else if (command === '/clear') {
      const id = info?.session_id
      if (!id) appendSystem('No active conversation to clear.')
      else void gateway.request<SessionResult>('session.delete', { id }).then(applySession).catch(requestError)
    } else if (command === '/resume') {
      openResumeMenu()
    } else if (command === '/permission') {
      openPermissionMenu()
    } else if (command === '/fork') {
      void gateway.request<SessionResult & { tree?: BranchTree }>('session.fork').then(result => {
        applySession(result)
        appendSystem('Forked from the latest Friday response. Use /branches to navigate the fork map.')
        if (result.tree) showBranchTree(result.tree)
      }).catch(requestError)
    } else if (command === '/queue') {
      if (!argument) appendSystem('Usage: /queue <message> - runs after the current turn finishes.')
      else sendChat(argument)
    } else if (command === '/branches') {
      openBranchView()
    } else if (command === '/plugins') {
      openPluginMenu()
    } else {
      appendSystem(`Unknown command: ${command}. Try /help.`)
    }
    return true
  }

  function handleApprovalResult(result: unknown, rejected: boolean) {
    if (isContinuedApproval(result)) {
      return
    }
    setBusy(false)
    finishTurn([{ role: 'system', text: rejected ? 'Command rejected.' : 'Command approved.' }])
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
      finishTurn([])
      beginTurn(instruction)
    }
    setApprovalPicker(null)
    setBusy(true)
    void gateway.request(method, params).then(result =>
      handleApprovalResult(result, rejected)
    ).catch(error => {
      failTurn(error)
    })
  }
}

function cleanInput(value: string) {
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
}

function canNavigateWhileBusy(value: string) {
  // /permission is deliberately usable mid-run: the mode is a hot swap that
  // governs the next tool call of the running turn.
  return /^\/(?:new|resume|branches|permission)$/i.test(value)
}

function sessionId(event: GatewayEvent) {
  const value = 'session_id' in event.payload ? event.payload.session_id : undefined
  return typeof value === 'string' ? value : ''
}

function goalText(value: string) {
  const match = value.match(/^\/goal(?:\s+(.*))?$/i)
  return match ? (match[1] ?? '').trim() : null
}

function isContinuedApproval(result: unknown) {
  return Boolean(result && typeof result === 'object' && (result as { continued?: unknown }).continued)
}

type UiMessage = Message & {
  steers?: string[]
  thinking?: ThinkingBlock[]
  tools?: ToolRun[]
  turnId?: string
  verification?: VerificationStatus
}

type ThinkingBlock = {
  ended?: number
  error?: boolean
  id: string
  started: number
  text: string
}

type VerificationStatus = VerificationResult & {
  running?: boolean
}

type Approval = {
  command?: string
  id?: string
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

/** Lazily create the live-turn container for events that arrive without one. */
function ensureTurn(turn: ActiveTurn | null): ActiveTurn {
  return turn ?? { text: '', steers: [], thinking: [], tools: [], turnId: null }
}

function activeAsMessage(turn: ActiveTurn): UiMessage {
  return {
    role: 'user',
    text: turn.text,
    steers: turn.steers,
    thinking: turn.thinking,
    tools: turn.tools,
    ...(turn.verification ? { verification: turn.verification } : {})
  }
}

export function restoredMessages(history: HistoryItem[]) {
  const messages: UiMessage[] = []
  let current: UiMessage | undefined
  for (const [index, item] of history.entries()) {
    if (item.kind === 'user') {
      current = { role: 'user', text: item.text }
      messages.push(current)
    } else if (item.kind === 'tool') {
      if (!current) continue
      const timestamp = Date.now()
      current.tools = [
        ...(current.tools ?? []),
        {
          arguments: item.arguments,
          content: item.text,
          endMs: item.status === 'running' ? undefined : timestamp,
          error: item.status === 'error',
          id: item.tool_call_id || `history-tool-${index}`,
          name: item.name || 'Tool',
          startMs: timestamp,
        },
      ]
    } else if (item.kind === 'reasoning') {
      if (!current) continue
      current.thinking = [
        ...(current.thinking ?? []),
        {
          ended: item.elapsed_ms ?? 0,
          error: item.status === 'error',
          id: `history-reasoning-${index}`,
          started: 0,
          text: item.text
        }
      ]
    } else if (item.kind === 'assistant') {
      messages.push({ metrics: item.metrics, role: 'assistant', text: item.text })
    } else if (item.kind === 'system') {
      messages.push({ role: 'system', text: item.text })
    }
  }
  if (messages.length > MAX_RESTORED_MESSAGES) {
    const hidden = messages.length - MAX_RESTORED_MESSAGES
    return [
      { role: 'system', text: `… ${hidden} earlier message${hidden > 1 ? 's' : ''} not shown. The full conversation is preserved.` } as UiMessage,
      ...messages.slice(-MAX_RESTORED_MESSAGES)
    ]
  }
  return messages
}

function resumeLabel(choice: ResumeChoice) {
  return choice.title || choice.objective || choice.user || 'Conversation'
}

function resumeMenu(choices: ResumeChoice[], currentId?: string): PickerMenu {
  return {
    footer: 'Ctrl+D or Delete removes the selected conversation',
    index: Math.max(0, choices.findIndex(choice => choice.id === currentId)),
    kind: 'resume',
    options: choices.map(choice => ({
      data: choice,
      detail: `${choice.time || 'recent'} · ${choice.turns} turns · ${choice.running ? 'running' : choice.status || 'saved'}${choice.id === currentId ? ' · current' : ''}`,
      id: choice.id,
      keywords: `${choice.title} ${choice.objective} ${choice.user}`,
      label: resumeLabel(choice),
    })),
    query: '',
    title: 'Resume conversation',
  }
}

function thinkingLabel(effort: string) {
  const labels: Record<string, string> = {
    max: 'Maximum',
    medium: 'Medium',
    minimal: 'Minimal',
    none: 'Off',
    off: 'Off',
    on: 'On',
    xhigh: 'Extra high',
  }
  return labels[effort] || effort[0]!.toUpperCase() + effort.slice(1)
}

function permissionLabel(mode: SessionInfo['permission_mode']) {
  return mode === 'bypass' ? 'Full access' : mode === 'auto' ? 'Friday decides' : 'Request approval'
}

function upsertThinking(turn: ActiveTurn, id: string, text: string): ActiveTurn {
  const blocks = [...turn.thinking]
  const blockIndex = blocks.findIndex(block => block.id === id)
  if (blockIndex === -1) {
    blocks.push({ id, started: Date.now(), text })
  } else {
    blocks[blockIndex] = { ...blocks[blockIndex]!, text: blocks[blockIndex]!.text + text }
  }
  return { ...turn, thinking: blocks }
}

function completeThinking(turn: ActiveTurn, id: string, error: boolean): ActiveTurn {
  return {
    ...turn,
    thinking: turn.thinking.map(block =>
      block.id === id && block.ended == null ? { ...block, ended: Date.now(), error: error || undefined } : block)
  }
}

function closeOpenThinking(turn: ActiveTurn): ActiveTurn {
  if (!turn.thinking.some(block => block.ended == null)) {
    return turn
  }
  return {
    ...turn,
    thinking: turn.thinking.map(block => block.ended == null ? { ...block, ended: Date.now() } : block)
  }
}

function updateToolRun(turn: ActiveTurn, id: string, patch: Partial<ToolRun> | ((run: ToolRun) => Partial<ToolRun>)): ActiveTurn {
  const tools = [...turn.tools]
  const toolIndex = tools.findIndex(run => run.id === id)
  if (toolIndex === -1) {
    return turn
  }
  const run = tools[toolIndex]!
  tools[toolIndex] = { ...run, ...(typeof patch === 'function' ? patch(run) : patch) }
  return { ...turn, tools }
}

/** Depth-first rows with box-drawing guides for the branch map. */
function branchRows(tree: BranchTree): BranchRow[] {
  const children = new Map<string, BranchNode[]>()
  const byId = new Map(tree.nodes.map(node => [node.id, node]))
  for (const node of tree.nodes) {
    if (!node.parent || !byId.has(node.parent) || node.id === tree.root) continue
    children.set(node.parent, [...children.get(node.parent) ?? [], node])
  }
  for (const list of children.values()) {
    list.sort((left, right) => left.time.localeCompare(right.time))
  }
  const rows: BranchRow[] = []
  const visit = (node: BranchNode, depth: number, prefix: string, last: boolean) => {
    const guide = depth === 0 ? '' : `${prefix}${last ? '└─ ' : '├─ '}`
    rows.push({ depth, guide, node })
    const kids = children.get(node.id) ?? []
    const nextPrefix = depth === 0 ? '' : `${prefix}${last ? '   ' : '│  '}`
    kids.forEach((child, index) => visit(child, depth + 1, nextPrefix, index === kids.length - 1))
  }
  const root = byId.get(tree.root)
  if (root) visit(root, 0, '', true)
  for (const node of tree.nodes) {
    if (!rows.some(row => row.node.id === node.id)) rows.push({ depth: 0, guide: '', node })
  }
  return rows
}

function Header({ activity, busy, info, progress, queued = 0 }: { activity: string; busy: boolean; info: SessionInfo | null; progress: ProgressState | null; queued?: number }) {
  const cwd = info?.cwd ?? process.cwd()
  const status = activity || (busy ? 'thinking · Enter steers · /queue waits' : 'ready')
  const waiting = queued > 0 ? ` · queued ${queued}` : ''
  const model = info?.model_name || info?.model || 'loading model'
  const tools = info?.tools.length ?? 0
  const permissions = info?.permission_mode === 'bypass'
    ? 'full access'
    : info?.permission_mode === 'auto'
      ? 'Friday approves'
      : 'request approval'
  const thinking = info?.thinking_supported ? ` · thinking ${info.thinking_effort}` : ''
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={theme.accent}>●</Text>
        <Text bold> Friday</Text>
        <Text color={theme.dim}>  /help commands · Ctrl+O tools · Ctrl+T thinking · Esc Esc stop</Text>
      </Box>
      <Text color={theme.dim} wrap="truncate-end">{cwd}</Text>
      {progress?.objective ? <ProgressLine progress={progress} /> : null}
      <Box>
        <Text color={busy ? theme.warn : theme.ok}>● </Text>
        <Text color={busy ? theme.warn : theme.ok}>{status}</Text>
        <Text color={theme.dim}> · {shortModel(model)}{thinking} · {tools} tools · {permissions}{waiting}</Text>
      </Box>
    </Box>
  )
}

function ProgressLine({ progress }: { progress: ProgressState }) {
  const steps = progress.steps ?? []
  const completed = steps.filter(step => step.status === 'completed').length
  const count = steps.length ? ` · ${completed}/${steps.length}` : ''
  const next = progress.next_action ? ` · next: ${shortText(progress.next_action, 60)}` : ''
  const color = progress.status === 'done' ? theme.ok : progress.status === 'blocked' ? theme.error : progress.status === 'waiting' ? theme.warn : theme.accent
  return <Text color={color} wrap="truncate-end">task {progress.status ?? 'working'} · {shortText(progress.objective ?? '', 90)}{count}{next}</Text>
}

function MessageLine({
  message,
  now = Date.now(),
  tail = false,
  thinkingExpanded = false,
  toolsExpanded = false
}: {
  message: UiMessage
  now?: number
  /** Live rendering: bound expanded panels so the dynamic frame stays short. */
  tail?: boolean
  thinkingExpanded?: boolean
  toolsExpanded?: boolean
}) {
  if (message.role === 'user') {
    return (
      <Box>
        <Text color={theme.accent}>{message.text ? '❯ ' : '· '}</Text>
        <Box flexDirection="column">
          {message.text ? <Text bold wrap="wrap">{message.text}</Text> : null}
          {(message.steers ?? []).map((steer, index) => (
            <Text key={index} wrap="wrap">
              <Text color={theme.warn}>↳ </Text>
              <Text bold>{steer}</Text>
            </Text>
          ))}
          <ThinkingPanel blocks={message.thinking ?? []} expanded={thinkingExpanded} now={now} tail={tail} />
          <ToolPanel now={now} runs={message.tools ?? []} toolsExpanded={toolsExpanded} />
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

/**
 * While the answer streams, only its last lines render in the dynamic frame:
 * the full text lands in the scrollback once the turn completes. Keeping the
 * frame shorter than the terminal is what prevents flicker on every delta.
 */
function StreamTail({ text }: { text: string }) {
  const rows = process.stdout.rows ?? 24
  const limit = Math.max(6, rows - 14)
  const lines = text.split('\n')
  const truncated = lines.length > limit
  return (
    <Box>
      <Text color={theme.accent}>● </Text>
      <Box flexDirection="column">
        {truncated ? <Text color={theme.dim}>… streaming · earlier lines appear above when the reply completes</Text> : null}
        <Markdown text={lines.slice(-limit).join('\n')} theme={theme} />
      </Box>
    </Box>
  )
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

function ThinkingPanel({ blocks, expanded, now, tail = false }: { blocks: ThinkingBlock[]; expanded: boolean; now: number; tail?: boolean }) {
  if (!blocks.length) {
    return null
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.dim}>thinking (Ctrl+T)</Text>
      {blocks.map(block => {
        const done = block.ended != null
        const color = block.error ? theme.error : done ? theme.dim : theme.warn
        const seconds = formatThinkingSeconds(((block.ended ?? now) - block.started) / 1000)
        const label = block.error ? `Thinking stopped · ${seconds}` : done ? `Thought for ${seconds}` : `Thinking… ${seconds}`
        return (
          <Box flexDirection="column" key={block.id}>
            <Text wrap="truncate-end">
              <Text color={color}>●</Text>
              <Text color={done && !block.error ? theme.dim : undefined}> {label}</Text>
            </Text>
            {expanded && block.text ? (
              <Box paddingLeft={2}>
                <Text color={theme.dim}>{tail ? tailLines(block.text, 8) : block.text}</Text>
              </Box>
            ) : null}
          </Box>
        )
      })}
    </Box>
  )
}

function tailLines(text: string, limit: number) {
  const lines = text.split('\n')
  return lines.length > limit ? `…\n${lines.slice(-limit).join('\n')}` : text
}

function formatThinkingSeconds(seconds: number) {
  const value = Math.max(0, seconds)
  if (value < 60) return value < 10 ? `${value.toFixed(1)}s` : `${Math.round(value)}s`
  const minutes = Math.floor(value / 60)
  const rest = Math.round(value % 60)
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`
}

function ToolPanel({ toolsExpanded, now, runs }: { toolsExpanded: boolean; now: number; runs: ToolRun[] }) {
  if (!runs.length) {
    return null
  }
  const shown = runs.slice(-6)
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.dim}>tools (Ctrl+O)</Text>
      {runs.length > shown.length ? <Text color={theme.dim}>… {runs.length - shown.length} earlier tool call{runs.length - shown.length > 1 ? 's' : ''} hidden</Text> : null}
      {shown.map(run => {
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

function BranchesView({ active, view }: { active: string; view: BranchView }) {
  const rows = process.stdout.rows ?? 24
  const limit = Math.max(5, rows - 12)
  const start = Math.max(0, Math.min(view.index - Math.floor(limit / 2), view.rows.length - limit))
  const visible = view.rows.slice(start, start + limit)
  const selected = view.rows[view.index]?.node
  return (
    <Box borderColor={theme.accent} borderStyle="round" flexDirection="column" marginTop={1} paddingX={1}>
      <Text>
        <Text bold color={theme.accent}>Conversation branches</Text>
        <Text color={theme.dim}>  ↑↓←→ move · enter open · Ctrl+D delete · esc close</Text>
      </Text>
      {start > 0 ? <Text color={theme.dim}>… {start} more above</Text> : null}
      {visible.map(row => {
        const node = row.node
        const selectedRow = node.id === selected?.id
        const markers = [
          node.id === view.tree.root ? 'root' : '',
          node.id === active ? 'current' : '',
          node.fork_source ? `from “${shortText(node.fork_source, 40)}”` : '',
          node.turns ? `${node.turns}t` : ''
        ].filter(Boolean).join(' · ')
        return (
          <Text color={selectedRow ? theme.accent : node.id === active ? theme.ok : undefined} key={node.id} wrap="truncate-end">
            {selectedRow ? '❯ ' : '  '}
            <Text color={theme.dim}>{row.guide}</Text>
            {node.id === active ? '◉ ' : '○ '}
            {shortText(node.title || node.id, 46)}
            {markers ? <Text color={theme.dim}>  {markers}</Text> : null}
            <Text color={theme.dim}>  {node.time}</Text>
          </Text>
        )
      })}
      {start + visible.length < view.rows.length ? <Text color={theme.dim}>… {view.rows.length - start - visible.length} more below</Text> : null}
      {view.confirmDelete && selected ? (
        <Text color={theme.error}>Delete “{shortText(selected.title || selected.id, 40)}” and its sub-branches? Enter/y confirm · Esc/n cancel</Text>
      ) : null}
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

function CredentialInputView({
  credential,
  onChange,
  onSubmit,
}: {
  credential: CredentialInput
  onChange: (value: string) => void
  onSubmit: () => void
}) {
  return (
    <Box borderColor={theme.dim} borderStyle="round" flexDirection="column" marginTop={1} paddingX={1}>
      <Text>
        <Text bold color={theme.accent}>{credential.provider.label} API key</Text>
        <Text color={theme.dim}>  enter save · esc back</Text>
      </Text>
      <Box>
        <Text color={theme.dim}>key › </Text>
        <TextInput
          focus
          mask="•"
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder="paste API key"
          value={credential.value}
        />
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

function shortText(value: string, max: number) {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}

/** A turn a guard ended reads as a normal answer, so name the reason. */
function stopReasonLine(status?: string) {
  if (status === 'no_progress') {
    return 'Friday stopped early: the same step kept producing the same result. The answer above is what it had.'
  }
  if (status === 'context_window') {
    return 'Friday stopped early: the context window is full and compaction could not free enough of it.'
  }
  return ''
}

/** Compaction rewrites the prompt, not the conversation. Say which one moved. */
function compactionLine(payload: ContextCompaction) {
  if (payload.ok === false) {
    return `Context compaction failed (${payload.reason || 'unknown'}). This conversation may hit the model's limit.`
  }
  const saved = payload.before_tokens && payload.after_tokens
    ? ` (~${shortTokens(payload.before_tokens)} to ~${shortTokens(payload.after_tokens)} tokens)`
    : ''
  if (payload.kind === 'tool_results') {
    const count = payload.tool_results ? ` ${payload.tool_results}` : ''
    return `Context compacted${saved}: replaced${count} old tool results with receipts. Exact outputs remain in conversation history.`
  }
  const kept = payload.kept_turns ? `, plus the last ${payload.kept_turns} steps verbatim` : ''
  const written = payload.fallback ? ' Friday wrote the summary locally because the model could not.' : ''
  return `Context compacted${saved}: the model now reads a summary of the earlier work${kept}. Everything above stays in this conversation.${written}`
}

function shortTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  return value >= 1000 ? `${Math.round(value / 1000)}k` : String(value)
}

function formatSeconds(seconds: number) {
  return `${Math.max(0, seconds).toFixed(1)}s`
}

function approvalIndex(decision: ApprovalDecision) {
  return APPROVAL_OPTIONS.findIndex(option => option.id === decision)
}

function Composer({ busy, input, onChange, onSubmit }: { busy: boolean; input: string; onChange: (value: string) => void; onSubmit: (value: string) => void }) {
  const rule = '─'.repeat(Math.max(20, (process.stdout.columns ?? 80) - 2))
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.dim}>{rule}</Text>
      <Box>
        <Text color={busy ? theme.dim : theme.accent}>{busy ? '…' : '❯'} </Text>
        <TextInput focus onChange={onChange} onSubmit={onSubmit} placeholder="Ask Friday or /help" value={input} />
      </Box>
    </Box>
  )
}

function Metrics({ metrics }: { metrics: NonNullable<Message['metrics']> }) {
  const mark = metrics.estimated_tokens ? '~' : ''
  const input = metrics.input_tokens == null ? 'n/a' : `${mark}${shortTokens(metrics.input_tokens)}`
  const output = metrics.output_tokens == null ? 'n/a' : `${mark}${shortTokens(metrics.output_tokens)}`
  const seconds = metrics.elapsed_ms == null ? 'n/a' : `${(metrics.elapsed_ms / 1000).toFixed(1)}s`
  const parts: string[] = []
  if (metrics.window_tokens != null && metrics.window) {
    const percent = Math.round((metrics.window_tokens / metrics.window) * 100)
    // Occupancy is always Friday's own estimate, never a provider count.
    parts.push(`ctx ~${shortTokens(metrics.window_tokens)}/${shortTokens(metrics.window)} (${percent}%)`)
  }
  // The request count is what makes the rest legible: the token figures are sums
  // over every call the turn made, each re-sending the conversation, so they run
  // far ahead of the window. Cache is quoted inside the input it is part of --
  // beside it, it read as a second context larger than the first.
  if (metrics.requests) parts.push(`${metrics.requests} req`)
  parts.push(`in ${input} (${metrics.cached_tokens == null ? 'n/a' : shortTokens(metrics.cached_tokens)} cached) / out ${output}`)
  parts.push(seconds)
  return <Text color={theme.dim}>{parts.join(' · ')}</Text>
}

function shortModel(model: string) {
  return model.split('/').pop()?.replace(/[-_]/g, ' ') || model
}
