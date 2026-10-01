import type { JsonObject } from 'friday-agent-core'
import type { ModelCapabilities } from 'friday-agent-protocol'
import { resolveCapabilities } from './model-capabilities.js'

export function thinkingOptions(provider: string, model: string, capabilities?: ModelCapabilities): string[] {
  return [...resolveCapabilities(provider, model, capabilities).reasoning.options]
}

export function defaultThinking(provider: string, model: string, capabilities?: ModelCapabilities): string {
  const reasoning = resolveCapabilities(provider, model, capabilities).reasoning
  return reasoning.default ?? reasoning.options[0] ?? ''
}

export function normalizeThinking(provider: string, model: string, value: unknown, strict = false, capabilities?: ModelCapabilities): string {
  const options = thinkingOptions(provider, model, capabilities)
  if (!options.length) return ''
  let effort = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (effort === 'off' && options.includes('none')) effort = 'none'
  if (options.includes(effort)) return effort
  if (strict) throw new Error('Thinking effort for ' + model + ' must be one of: ' + options.join(', '))
  return defaultThinking(provider, model, capabilities)
}

export function thinkingBody(provider: string, model: string, effort: string, capabilities?: ModelCapabilities): JsonObject {
  const resolved = resolveCapabilities(provider, model, capabilities)
  const value = normalizeThinking(provider, model, effort, false, capabilities)
  if (!value) return {}
  switch (resolved.reasoning.mode) {
    case 'none': return {}
    case 'adaptive': return { thinking: { type: 'adaptive' }, output_config: { effort: value } }
    case 'disabled-toggle': return value === 'off' ? { thinking: { type: 'disabled' } } : {}
    case 'toggle': return { thinking: { type: value === 'off' ? 'disabled' : 'enabled' },
      ...(resolved.reasoning.options.includes('high') && !['off', 'on'].includes(value) ? { reasoning_effort: value } : {}) }
    case 'effort': return resolved.api === 'responses' ? { reasoning: { effort: value } }
      : resolved.api === 'anthropic' ? { output_config: { effort: value } } : { reasoning_effort: value }
  }
}
