import type { JsonObject } from './types.js'

/** Prompt occupancy includes cache reads and writes; cache savings include reads only. */
export function normalizeUsage(value: unknown): { input: number | undefined; output: number | undefined; cached: number | undefined; cacheWrite: number | undefined } {
  const usage = object(value)
  const read = count(usage.cache_read_input_tokens)
  const written = count(usage.cache_creation_input_tokens)
  const raw = count(usage.input_tokens) ?? count(usage.prompt_tokens)
  return {
    input: raw === undefined ? undefined : raw + (read ?? 0) + (written ?? 0),
    output: count(usage.output_tokens) ?? count(usage.completion_tokens),
    cached: read ?? count(object(usage.prompt_tokens_details ?? usage.input_tokens_details).cached_tokens) ?? count(usage.cached_tokens) ?? count(usage.prompt_cache_hit_tokens),
    cacheWrite: written
  }
}
function count(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined
}
function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}
