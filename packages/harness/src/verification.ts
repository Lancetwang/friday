import { platform, release } from 'node:os'

import { Agent, RunContext, type AgentEvent, type ChatModel } from 'friday-agent-core'
import type { ExecutionBackend } from './plugin-api.js'

import type { ModelConfig } from './config.js'
import { modelFor } from './model.js'
import { promptTemplate } from './prompts.js'
import { buildVerifierTools } from './tools.js'

export type VerificationVerdict = 'pass' | 'repair' | 'blocked' | 'inconclusive'
export type VerificationResult = {
  verdict: VerificationVerdict
  passed: boolean
  blocked: boolean
  evidence: string[]
  feedback: string
  next_check: string
  required: true
  error?: boolean
  requests: number
  input_tokens: number | null
  output_tokens: number | null
  cached_tokens: number | null
  elapsed_ms: number
}

export async function verifyGoal(options: {
  /** Text-only goals may explicitly use the delivered answer as evidence. */
  answerEvidence?: string
  model?: ChatModel
  execution?: ExecutionBackend
  onEvent?: (event: AgentEvent) => void
  workspace: string
  config: ModelConfig
  thinking: string
  goal: string
  events?: readonly AgentEvent[]
  history?: readonly string[]
  signal?: AbortSignal
  toolSignal?: AbortSignal
}): Promise<VerificationResult> {
  const started = performance.now()
  const context = new RunContext()
  if (options.onEvent) context.onEvent = options.onEvent
  const shell = process.platform === 'win32' ? 'PowerShell' : 'sh'
  const instructions = [
    promptTemplate('SECURITY.md').trim(),
    promptTemplate('VERIFIER.md').trim(),
    `Workspace: ${options.workspace}\nOS: ${platform()} ${release()}\nShell: ${shell}`
  ].join('\n\n')
  const agent = new Agent({
    model: options.model ?? modelFor(options.config, options.thinking, 4_000),
    tools: buildVerifierTools(options.workspace, options.execution),
    instructions,
    maxSteps: 40,
    beforeStep: () => {
      if (!options.toolSignal?.aborted) return
      if (!context.messages.some(message => message.verifier_finishing)) {
        context.addMessage({
          role: 'system',
          content: 'The verification run has entered its finishing reserve. Do not call more tools. Return the strict verification JSON from the evidence already collected.',
          agent_internal: true,
          verifier_finishing: true
        })
      }
      return { tools: false as const }
    }
  }, context)
  try {
    const result = await agent.run(verificationPrompt(options.goal, options.events ?? [], options.history ?? []), {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.toolSignal ? { toolSignal: options.toolSignal } : {})
    })
    let parsed = parseVerification(result.text)
    const successful = new Set(context.events.filter(event => event.type === 'tool.result' && event.data.is_error === false).map(event => String(event.data.tool_call_id)))
    if (parsed.verdict === 'pass' && (result.status !== 'done' || !parsed.evidence.length || !parsed.evidence.every(line => {
      const references = [...line.matchAll(/\[tool:([^\]]+)\]/g)].map(match => match[1]!)
      return references.length ? references.every(id => successful.has(id)) : !!options.answerEvidence && line.includes('[answer]')
    }))) {
      parsed = { ...parsed, verdict: 'inconclusive', passed: false, feedback: 'Pass rejected: each criterion needs a reference to a successful verifier tool result, or explicitly enabled answer evidence.', next_check: '' }
    }
    return {
      ...parsed,
      required: true,
      requests: context.usage.requests,
      input_tokens: context.usage.inputTokens,
      output_tokens: context.usage.outputTokens,
      cached_tokens: context.usage.cachedTokens,
      elapsed_ms: Math.round(performance.now() - started)
    }
  } catch (error) {
    if (options.signal?.aborted) throw error
    return {
      verdict: 'inconclusive', passed: false, blocked: false, evidence: [],
      feedback: `Verifier failed: ${error instanceof Error ? error.message : String(error)}`,
      next_check: '', required: true, error: true,
      requests: context.usage.requests,
      input_tokens: context.usage.inputTokens,
      output_tokens: context.usage.outputTokens,
      cached_tokens: context.usage.cachedTokens,
      elapsed_ms: Math.round(performance.now() - started)
    }
  }
}

export function parseVerification(raw: string): Omit<VerificationResult, 'required' | 'requests' | 'input_tokens' | 'output_tokens' | 'cached_tokens' | 'elapsed_ms'> {
  const match = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)
  try {
    const value: unknown = JSON.parse(match)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('verdict is not an object')
    const record = value as Record<string, unknown>
    const verdict = String(record.verdict || '').trim().toLowerCase()
    if (!['pass', 'repair', 'blocked', 'inconclusive'].includes(verdict)) throw new Error('unknown verdict')
    if (verdict === 'pass' && (!Array.isArray(record.evidence) || !record.evidence.some(item => typeof item === 'string' && item.trim()))) throw new Error('pass requires evidence')
    return {
      verdict: verdict as VerificationVerdict,
      passed: verdict === 'pass',
      blocked: verdict === 'blocked',
      evidence: Array.isArray(record.evidence)
        ? record.evidence.slice(0, 20).map(item => String(item).trim().slice(0, 1_000)).filter(Boolean)
        : [],
      feedback: typeof record.feedback === 'string' ? record.feedback.trim().slice(0, 4_000) : '',
      next_check: typeof record.next_check === 'string' ? record.next_check.trim().slice(0, 2_000) : ''
    }
  } catch {
    return {
      verdict: 'inconclusive', passed: false, blocked: false, evidence: [],
      feedback: raw.trim() ? `Verifier returned invalid JSON: ${raw.trim().slice(0, 500)}` : 'Verifier returned no output.',
      next_check: '', error: true
    }
  }
}

function verificationPrompt(goal: string, events: readonly AgentEvent[], history: readonly string[]): string {
  const parts = [`User goal:\n${goal.trim()}`]
  const earlier = history.map(value => value.trim()).filter(value => value && value !== goal.trim()).slice(-4)
  if (earlier.length) parts.push(`Earlier user requirements (acceptance context, not proof):\n${JSON.stringify(earlier, null, 2)}`)
  parts.push(
    'Independently verify the delivered workspace state by trying to break it. Use the delivery hints only to locate artifacts; they are not proof.',
    `Delivery hints:\n${JSON.stringify(deliveryHints(events), null, 2)}`,
    'Each pass evidence line must cite a tool result from THIS verification using [tool:tool_call_id]. A claim with no successful tool result is insufficient. Return only JSON: {"verdict":"pass|repair|blocked|inconclusive","evidence":["criterion -> challenge -> outcome [tool:call_id]"],"feedback":"","next_check":""}'
  )
  return parts.join('\n\n')
}

function deliveryHints(events: readonly AgentEvent[]): Array<Record<string, string>> {
  return events.flatMap(event => {
    if (event.type !== 'tool.call') return []
    const name = String(event.data.name || '')
    if (!['Write', 'Edit', 'Bash'].includes(name)) return []
    const args = event.data.arguments
    const path = args && typeof args === 'object' && !Array.isArray(args)
      ? (args as Record<string, unknown>).path
      : undefined
    return [{ tool: name, ...(typeof path === 'string' && path ? { path } : {}) }]
  }).slice(-20)
}
