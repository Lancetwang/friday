/** A request can tighten a configured cap, including when no default exists. */
export function outputTokenLimit(...values: Array<number | undefined>): number | undefined {
  const limits = values.filter((value): value is number => value !== undefined)
  for (const value of limits) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('maxOutputTokens must be a positive integer.')
  }
  return limits.length ? Math.min(...limits) : undefined
}
