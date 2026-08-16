import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import type { GatewayEvent, MessageMetrics, SessionInfo } from './types.js'
import { GatewayClient } from './gatewayClient.js'

export const VERSION = '0.8.1'

export type CliOptions = {
  command: 'ask' | 'goal' | 'help' | 'run' | 'tui' | 'version'
  cwd?: string
  json: boolean
  permissionMode?: 'auto' | 'bypass' | 'manual'
  stdin: boolean
  text: string
  trajectory?: string
}

export function parseArgs(argv: string[]): CliOptions {
  let command: CliOptions['command'] | undefined
  let cwd: string | undefined
  let json = false
  let permissionMode: CliOptions['permissionMode']
  let stdin = false
  let trajectory: string | undefined
  const text: string[] = []
  const value = (name: string, index: number): string => {
    const result = argv[index + 1]
    if (!result) throw new Error(`${name} requires a value.`)
    return result
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === '--') { text.push(...argv.slice(index + 1)); break }
    if (arg === '--help' || arg === '-h') { command = 'help'; continue }
    if (arg === '--version' || arg === '-v') { command = 'version'; continue }
    if (arg === '--json') { json = true; continue }
    if (arg === '--stdin') { stdin = true; continue }
    if (arg === '--cwd') { cwd = value(arg, index); index += 1; continue }
    if (arg === '--trajectory') { trajectory = value(arg, index); index += 1; continue }
    if (arg === '--permission-mode') {
      const mode = value(arg, index)
      if (!['auto', 'bypass', 'manual'].includes(mode)) throw new Error('--permission-mode must be manual, auto, or bypass.')
      permissionMode = mode as CliOptions['permissionMode']
      index += 1
      continue
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
    if (!command && ['ask', 'goal', 'run', 'tui'].includes(arg)) command = arg as CliOptions['command']
    else text.push(arg)
  }
  command ??= text.length ? 'help' : 'tui'
  if (command === 'run') permissionMode ??= 'bypass'
  return { command, ...(cwd ? { cwd } : {}), json, ...(permissionMode ? { permissionMode } : {}), stdin, text: text.join(' '), ...(trajectory ? { trajectory } : {}) }
}

export async function headless(options: CliOptions): Promise<number> {
  const workspace = resolve(options.cwd || process.cwd())
  if (!(await stat(workspace).catch(() => undefined))?.isDirectory()) throw new Error(`Workspace is not a directory: ${workspace}`)
  process.env.FRIDAY_CWD = workspace
  const text = (options.stdin ? await readStdin() : options.text).trim()
  if (!text) throw new Error(`${options.command} requires a prompt or --stdin.`)
  const gateway = new GatewayClient()
  const events: TimedEvent[] = []
  let streamed = false
  gateway.on('event', (event: GatewayEvent) => {
    events.push({ event, timestamp: new Date().toISOString() })
    if (!options.json && event.type === 'message.delta') {
      streamed = true
      process.stdout.write(event.payload.text)
    } else if (event.type === 'gateway.stderr') process.stderr.write(`${event.payload.line}\n`)
  })
  gateway.start()
  try {
    if (options.permissionMode) await gateway.request('permission.set', { mode: options.permissionMode })
    const info = await gateway.request<SessionInfo>('session.info')
    const method = options.command === 'goal' ? 'goal.run' : 'chat.send'
    const result = await gateway.request<HeadlessResult>(method, { text })
    if (options.trajectory) await writeTrajectory(resolve(options.trajectory), atif(text, info, events, result))
    if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`)
    else if (!streamed) process.stdout.write(`${result.text}\n`)
    else process.stdout.write('\n')
    return result.cancelled ? 130 : 0
  } finally {
    gateway.kill()
  }
}

type HeadlessResult = {
  cancelled?: boolean
  session_id?: string
  stop_reason?: string
  text: string
  verification?: unknown
}
type TimedEvent = { event: GatewayEvent; timestamp: string }
type AtifStep = Record<string, unknown> & { source: 'agent' | 'user'; step_id: number; timestamp: string }

export function atif(instruction: string, info: SessionInfo, events: TimedEvent[], result: HeadlessResult): Record<string, unknown> {
  const steps: AtifStep[] = [{ step_id: 1, timestamp: events[0]?.timestamp || new Date().toISOString(), source: 'user', message: instruction }]
  const calls = new Map<string, { name: string; arguments: Record<string, unknown>; timestamp: string }>()
  let metrics: MessageMetrics | undefined
  for (const item of events) {
    const { event, timestamp } = item
    if (event.type === 'tool.start') calls.set(event.payload.tool_call_id, {
      name: event.payload.name,
      arguments: toolArguments(event.payload.arguments),
      timestamp
    })
    if (event.type === 'tool.complete') {
      const call = calls.get(event.payload.tool_call_id) || { name: event.payload.name, arguments: {}, timestamp }
      calls.delete(event.payload.tool_call_id)
      steps.push({
        step_id: steps.length + 1,
        timestamp: call.timestamp,
        source: 'agent',
        message: `Call ${call.name}`,
        tool_calls: [{ tool_call_id: event.payload.tool_call_id, function_name: call.name, arguments: call.arguments }],
        observation: { results: [{ source_call_id: event.payload.tool_call_id, content: event.payload.content || '', ...(event.payload.error ? { extra: { error: true } } : {}) }] }
      })
    }
    if (event.type === 'message.complete' || event.type === 'message.suspended') metrics = event.payload.metrics
  }
  for (const [id, call] of calls) {
    steps.push({
      step_id: steps.length + 1, timestamp: call.timestamp, source: 'agent', message: `Call ${call.name}`,
      tool_calls: [{ tool_call_id: id, function_name: call.name, arguments: call.arguments }]
    })
  }
  steps.push({
    step_id: steps.length + 1,
    timestamp: events.at(-1)?.timestamp || new Date().toISOString(),
    source: 'agent',
    model_name: info.model_name || info.model,
    message: result.text,
    ...(metrics ? { metrics: atifMetrics(metrics), llm_call_count: metrics.requests ?? undefined } : {})
  })
  return {
    schema_version: 'ATIF-v1.7',
    session_id: result.session_id || info.session_id || randomUUID(),
    agent: { name: 'friday', version: VERSION, model_name: info.model_name || info.model },
    steps,
    final_metrics: {
      ...(typeof metrics?.input_tokens === 'number' ? { total_prompt_tokens: metrics.input_tokens } : {}),
      ...(typeof metrics?.output_tokens === 'number' ? { total_completion_tokens: metrics.output_tokens } : {}),
      ...(typeof metrics?.cached_tokens === 'number' ? { total_cached_tokens: metrics.cached_tokens } : {}),
      total_steps: steps.length
    },
    extra: { permission_mode: info.permission_mode, ...(result.stop_reason ? { stop_reason: result.stop_reason } : {}) }
  }
}

function atifMetrics(metrics: MessageMetrics): Record<string, number> {
  return Object.fromEntries([
    ['prompt_tokens', metrics.input_tokens],
    ['completion_tokens', metrics.output_tokens],
    ['cached_tokens', metrics.cached_tokens]
  ].filter((item): item is [string, number] => typeof item[1] === 'number'))
}

function toolArguments(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value }
}

async function writeTrajectory(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding('utf8')
  let value = ''
  for await (const chunk of process.stdin) value += chunk
  return value
}

export const HELP = `Friday ${VERSION}

Usage:
  friday                         Start the terminal UI
  friday ask <prompt>            Run one agent turn
  friday goal <prompt>           Run with independent goal verification
  friday run <instruction>       Headless sandbox/evaluation run (bypass mode)

Options:
  --cwd <path>                   Workspace (defaults to the current directory)
  --permission-mode <mode>       manual, auto, or bypass
  --stdin                        Read the instruction from stdin
  --json                         Print only the final JSON result
  --trajectory <path>            Write an ATIF-v1.7 trajectory
  -h, --help                     Show this help
  -v, --version                  Show the version

Use bypass mode only inside an isolated environment.`
