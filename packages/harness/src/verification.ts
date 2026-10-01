import { platform, release } from 'node:os'

import { Agent, RunContext, type AgentEvent, type ChatModel, type ToolCall } from 'friday-agent-core'
import type { ExecutionBackend } from './plugin-api.js'
import type { AcceptanceCriterion, CriterionVerification } from 'friday-agent-protocol'
import { acceptanceFor, acceptancePrompt } from './acceptance.js'

import type { ModelConfig } from './config.js'
import { modelFor } from './model.js'
import { resolveCapabilities } from './model-capabilities.js'
import { promptTemplate } from './prompts.js'
import { buildVerifierTools } from './tools.js'

export type VerificationVerdict = 'pass' | 'repair' | 'blocked' | 'inconclusive'
export type VerificationResult = {
  criteria?: CriterionVerification[]
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
  criteria?: AcceptanceCriterion[]
  events?: readonly AgentEvent[]
  history?: readonly string[]
  signal?: AbortSignal
  toolSignal?: AbortSignal
  beforeTool?: (call: ToolCall, signal?: AbortSignal) => void | Promise<void>
}): Promise<VerificationResult> {
  const started = performance.now()
  const context = new RunContext()
  if (options.onEvent) context.onEvent = options.onEvent
  const shell = options.execution?.name === 'docker' ? 'POSIX sh (Docker; workspace mounted at /workspace)' : process.platform === 'win32' ? 'PowerShell' : 'sh'
  const instructions = [
    promptTemplate('SECURITY.md').trim(),
    promptTemplate('VERIFIER.md').trim(),
    `Workspace: ${options.workspace}\nOS: ${platform()} ${release()}\nShell: ${shell}`,
    options.execution?.readOnlyIsolation ? 'Shell checks run with enforced read-only filesystem and network isolation.'
      : 'Shell verification is unavailable without an isolated backend. Use the provided read-only tools; if executable proof is necessary, report blocked or inconclusive.'
  ].join('\n\n')
  const agent = new Agent({
    model: options.model ?? modelFor(options.config, options.thinking, 4_000),
    tools: resolveCapabilities(options.config.provider, options.config.model, options.config.capabilities).tools ? buildVerifierTools(options.workspace, options.execution) : [],
    instructions,
    maxSteps: 40,
    ...(options.beforeTool ? { beforeTool: options.beforeTool } : {}),
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
    const criteria = options.criteria ?? acceptanceFor(options.goal)
    const result = await agent.run(verificationPrompt(options.goal, criteria, options.events ?? [], options.history ?? []), {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.toolSignal ? { toolSignal: options.toolSignal } : {})
    })
    const parsed = parseVerification(result.text)
    const successful = new Set(context.events.filter(event => event.type === 'tool.result' && event.data.is_error === false).map(event => String(event.data.tool_call_id)))
    const checked = enforceAcceptance(parsed, criteria, successful, result.status === 'done', options.answerEvidence)
    return {
      ...checked,
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
    let criteria: CriterionVerification[] | undefined
    if (record.criteria !== undefined) {
      if (!Array.isArray(record.criteria) || record.criteria.length > 21) throw new Error('invalid criteria')
      criteria = record.criteria.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' ||
          !['pass', 'repair', 'blocked', 'inconclusive'].includes(item.verdict) || !Array.isArray(item.evidence) ||
          item.evidence.some((line: unknown) => typeof line !== 'string')) throw new Error('invalid criterion result')
        return { id: item.id, verdict: item.verdict, evidence: item.evidence.slice(0, 20).map((line: string) => line.trim().slice(0, 1_000)).filter(Boolean),
          ...(typeof item.feedback === 'string' ? { feedback: item.feedback.slice(0, 2_000) } : {}) }
      })
    }
    return {
      verdict: verdict as VerificationVerdict,
      passed: verdict === 'pass',
      blocked: verdict === 'blocked',
      evidence: Array.isArray(record.evidence)
        ? record.evidence.slice(0, 20).map(item => String(item).trim().slice(0, 1_000)).filter(Boolean)
        : [],
      feedback: typeof record.feedback === 'string' ? record.feedback.trim().slice(0, 4_000) : '',
      next_check: typeof record.next_check === 'string' ? record.next_check.trim().slice(0, 2_000) : ''
      , ...(criteria ? { criteria } : {})
    }
  } catch {
    return {
      verdict: 'inconclusive', passed: false, blocked: false, evidence: [],
      feedback: raw.trim() ? `Verifier returned invalid JSON: ${raw.trim().slice(0, 500)}` : 'Verifier returned no output.',
      next_check: '', error: true
    }
  }
}

type ParsedVerification = ReturnType<typeof parseVerification>

/** A global pass cannot hide an omitted, failed, or unproven criterion. */
export function enforceAcceptance(parsed: ParsedVerification, contract: readonly AcceptanceCriterion[], successful: ReadonlySet<string>, done = true, answerEvidence?: string): ParsedVerification {
  const supplied = parsed.criteria ?? (contract.length === 1 && contract[0]?.id === 'goal'
    ? [{ id: 'goal', verdict: parsed.verdict, evidence: parsed.evidence }] : [])
  const known = new Set(contract.map(item => item.id))
  const ids = supplied.map(item => item.id)
  const coverage = ids.length === known.size && new Set(ids).size === ids.length && ids.every(id => known.has(id))
  const proven = (lines: readonly string[]) => lines.length > 0 && lines.every(line => {
    const references = [...line.matchAll(/\[tool:([^\]]+)\]/g)].map(match => match[1]!)
    return references.length ? references.every(id => successful.has(id)) : !!answerEvidence && line.includes('[answer]')
  })
  const criteria = contract.map(item => ({ ...(supplied.find(check => check.id === item.id) ?? { id: item.id, verdict: 'inconclusive' as const, evidence: [], feedback: 'Criterion was not checked.' }), description: item.description }))
    .map(item => item.verdict === 'pass' && !proven(item.evidence)
      ? { ...item, verdict: 'inconclusive' as const, feedback: 'No successful verifier evidence.' } : item)
  if (parsed.verdict === 'pass' && (!done || !coverage || criteria.some(item => item.verdict !== 'pass') || !proven(parsed.evidence))) {
    return { ...parsed, criteria, verdict: 'inconclusive', passed: false, blocked: false,
      feedback: 'Pass rejected: every acceptance criterion must be covered once and cite a successful result from this verifier, or explicitly enabled answer evidence.', next_check: '' }
  }
  return { ...parsed, criteria }
}

function verificationPrompt(goal: string, criteria: readonly AcceptanceCriterion[], events: readonly AgentEvent[], history: readonly string[]): string {
  const parts = [`User goal:\n${goal.trim()}`, acceptancePrompt(criteria)]
  const earlier = history.map(value => value.trim()).filter(value => value && value !== goal.trim()).slice(-4)
  if (earlier.length) parts.push(`Earlier user requirements (acceptance context, not proof):\n${JSON.stringify(earlier, null, 2)}`)
  parts.push(
    'Independently verify the delivered workspace state by trying to break it. Use the delivery hints only to locate artifacts; they are not proof.',
    `Delivery hints:\n${JSON.stringify(deliveryHints(events), null, 2)}`,
    'Check every contract id exactly once. Each pass evidence line must cite a successful tool result from THIS verification using [tool:tool_call_id]. Return only JSON: {"verdict":"pass|repair|blocked|inconclusive","criteria":[{"id":"contract_id","verdict":"pass|repair|blocked|inconclusive","evidence":["challenge -> outcome [tool:call_id]"],"feedback":""}],"evidence":["overall outcome [tool:call_id]"],"feedback":"","next_check":""}'
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
