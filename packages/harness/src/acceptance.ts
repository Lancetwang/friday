import type { AcceptanceCriterion } from 'friday-agent-protocol'

/** User criteria supplement the complete goal; neither planner nor repair can narrow it. */
export function acceptanceFor(goal: string, value?: unknown): AcceptanceCriterion[] {
  return [{ id: 'goal', description: goal.trim() }, ...validateAcceptance(value)]
}

export function validateAcceptance(value: unknown): AcceptanceCriterion[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 20) throw new Error('Acceptance criteria must be an array of at most 20 items.')
  const ids = new Set(['goal'])
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Each acceptance criterion requires id and description.')
    const record = item as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    const description = typeof record.description === 'string' ? record.description.trim() : ''
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(id) || ids.has(id) || !description || description.length > 2_000) {
      throw new Error('Acceptance criteria require unique ids and descriptions of 1–2000 characters; goal is reserved.')
    }
    ids.add(id)
    return { id, description }
  })
}

export function acceptancePrompt(criteria: readonly AcceptanceCriterion[]): string {
  return `Acceptance contract (fixed before work; satisfy every item):\n${JSON.stringify(criteria, null, 2)}`
}
