import type { RunContext } from 'friday-agent-core'

import { localTimestamp } from './time.js'

export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'blocked'
export type ProgressStep = { step: string; status: StepStatus }
export type ProgressState = {
  objective: string
  latest_request: string
  mode: 'normal' | 'goal'
  status: 'working' | 'waiting' | 'blocked' | 'done'
  steps: ProgressStep[]
  next_action: string
  verification: Record<string, unknown>
  updated: string
}

const ARTIFACT = 'friday.progress'
const STEP_STATUSES = new Set<StepStatus>(['pending', 'in_progress', 'completed', 'blocked'])

export function currentProgress(context: RunContext): ProgressState | undefined {
  const value = context.artifacts[ARTIFACT]
  return isProgress(value) ? structuredClone(value) : undefined
}

export function beginProgress(
  context: RunContext,
  request: string,
  mode: 'normal' | 'goal' = 'normal',
  continuation = false
): ProgressState {
  const previous = currentProgress(context)
  const objective = request.trim()
  const state: ProgressState = continuation && previous ? {
    ...previous,
    latest_request: objective || previous.latest_request,
    status: 'working',
    next_action: ''
  } : {
    objective,
    latest_request: objective,
    mode,
    status: 'working',
    steps: [],
    next_action: '',
    verification: {},
    updated: ''
  }
  return store(context, state)
}

export function updatePlan(
  context: RunContext,
  value: { plan: unknown; objective?: unknown; explanation?: unknown; next_action?: unknown }
): ProgressState {
  const state = currentProgress(context)
  if (!state) throw new Error('No active Friday progress state.')
  const steps = validatePlan(value.plan)
  const objective = optionalText(value.objective, 'objective', 2_000)
  const explanation = optionalText(value.explanation, 'explanation', 2_000)
  const nextAction = optionalText(value.next_action, 'next_action', 2_000)
  return store(context, {
    ...state,
    ...(objective ? { objective } : {}),
    steps,
    status: 'working',
    next_action: nextAction
  }, explanation)
}

export function resumeProgress(context: RunContext): ProgressState | undefined {
  const state = currentProgress(context)
  return state ? store(context, { ...state, status: 'working', next_action: '' }) : undefined
}

export function recordVerificationProgress(context: RunContext, value: Record<string, unknown>): ProgressState | undefined {
  const state = currentProgress(context)
  if (!state) return undefined
  const verification = Object.fromEntries(
    ['attempt', 'stop_reason', 'verdict'].flatMap(key => value[key] === undefined ? [] : [[key, value[key]]])
  )
  return store(context, { ...state, verification })
}

export function finishProgress(
  context: RunContext,
  status: 'done' | 'waiting' | 'blocked',
  verification: Record<string, unknown> = {}
): ProgressState | undefined {
  const state = currentProgress(context)
  if (!state) return undefined
  const summary = Object.fromEntries(
    ['attempt', 'stop_reason', 'verdict'].flatMap(key => verification[key] === undefined ? [] : [[key, verification[key]]])
  )
  if (status === 'done') {
    return store(context, {
      ...state,
      status,
      next_action: '',
      steps: state.steps.map(step => ({ ...step, status: 'completed' })),
      verification: summary
    })
  }
  return store(context, {
    ...state,
    status,
    next_action: status === 'waiting'
      ? 'Choose whether to approve, allow for this session, reject, or provide guidance.'
      : state.next_action || 'Provide guidance or revise the request.',
    verification: summary
  })
}

export function restoreProgress(context: RunContext, value: unknown, emit = false): ProgressState | undefined {
  if (!isObject(value) || typeof value.objective !== 'string' || !value.objective.trim()) {
    delete context.artifacts[ARTIFACT]
    if (emit) context.emit('progress.updated', 'progress', {})
    return undefined
  }
  let steps: ProgressStep[] = []
  try { steps = validatePlan(value.steps) } catch {}
  const state: ProgressState = {
    objective: value.objective.trim(),
    latest_request: typeof value.latest_request === 'string' ? value.latest_request.trim() : '',
    mode: value.mode === 'goal' ? 'goal' : 'normal',
    status: ['working', 'waiting', 'blocked', 'done'].includes(String(value.status))
      ? value.status as ProgressState['status']
      : 'working',
    steps,
    next_action: typeof value.next_action === 'string' ? value.next_action.trim() : '',
    verification: isObject(value.verification) ? structuredClone(value.verification) : {},
    updated: typeof value.updated === 'string' ? value.updated : ''
  }
  context.artifacts[ARTIFACT] = structuredClone(state)
  if (emit) context.emit('progress.updated', 'progress', state)
  return structuredClone(state)
}

function validatePlan(value: unknown): ProgressStep[] {
  if (!Array.isArray(value)) throw new Error('plan must be an array.')
  if (value.length > 12) throw new Error('Plan supports at most 12 steps.')
  const steps = value.map((item, index) => {
    if (!isObject(item)) throw new Error(`plan[${index}] must be an object.`)
    const step = typeof item.step === 'string' ? item.step.trim() : ''
    const status = item.status
    if (!step || step.length > 500 || !STEP_STATUSES.has(status as StepStatus)) {
      throw new Error('Plan items require a short step and status=pending|in_progress|completed|blocked.')
    }
    return { step, status: status as StepStatus }
  })
  if (steps.filter(step => step.status === 'in_progress').length > 1) {
    throw new Error('At most one plan step can be in_progress.')
  }
  return steps
}

function store(context: RunContext, value: ProgressState, explanation = ''): ProgressState {
  const state = { ...structuredClone(value), updated: localTimestamp() }
  context.artifacts[ARTIFACT] = state
  context.emit('progress.updated', 'progress', { ...state, explanation })
  return structuredClone(state)
}

function optionalText(value: unknown, name: string, maximum: number): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new Error(`${name} must be text.`)
  const text = value.trim()
  if (text.length > maximum) throw new Error(`${name} must be at most ${maximum} characters.`)
  return text
}

function isProgress(value: unknown): value is ProgressState {
  return isObject(value) && typeof value.objective === 'string' && Array.isArray(value.steps)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
