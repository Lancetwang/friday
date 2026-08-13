import type { JsonObject } from 'friday-agent-core'

export function thinkingOptions(provider: string, model: string): string[] {
  const name = model.toLowerCase()
  if (provider === 'deepseek' && name.startsWith('deepseek-v4-')) return ['off', 'high', 'max']
  if (provider === 'mimo' && ['mimo-v2.5', 'mimo-v2.5-pro'].includes(name)) return ['off', 'on']
  if (provider === 'openai') return openAIOptions(name)
  if (provider === 'anthropic') return anthropicOptions(name)
  if (provider !== 'opencode-go') return []
  if (name.startsWith('gpt-5.6')) return ['none', 'low', 'medium', 'high', 'xhigh', 'max']
  if (name === 'grok-4.5') return ['low', 'medium', 'high']
  if (name === 'glm-5.2') return ['high', 'max']
  if (['glm-5.1', 'glm-5', 'kimi-k2.6', 'minimax-m3'].includes(name)) return ['off', 'on']
  if (name === 'kimi-k3') return ['low', 'high', 'max']
  if (/^qwen3\.[5-7]-/.test(name)) return ['off', 'on']
  if (name === 'hy3') return ['none', 'low', 'high']
  if (name.startsWith('deepseek-v4-')) return ['off', 'high', 'max']
  if (['mimo-v2.5', 'mimo-v2.5-pro'].includes(name)) return ['off', 'on']
  return []
}

export function defaultThinking(provider: string, model: string): string {
  const options = thinkingOptions(provider, model)
  if (!options.length) return ''
  const name = model.toLowerCase()
  if ((provider === 'openai' || provider === 'opencode-go') && name.startsWith('gpt-5.6')) return 'medium'
  if (name === 'kimi-k3') return 'max'
  if (options.includes('on')) return 'on'
  if (options.includes('none') && /^gpt-5\.[124]/.test(name)) return 'none'
  if (options.includes('medium') && name.startsWith('gpt-5')) return 'medium'
  return options.includes('high') ? 'high' : options[0]!
}

export function normalizeThinking(provider: string, model: string, value: unknown, strict = false): string {
  const options = thinkingOptions(provider, model)
  if (!options.length) return ''
  let effort = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (effort === 'off' && options.includes('none')) effort = 'none'
  if (options.includes(effort)) return effort
  if (strict) throw new Error(`Thinking effort for ${model} must be one of: ${options.join(', ')}`)
  return defaultThinking(provider, model)
}

export function thinkingBody(provider: string, model: string, effort: string): JsonObject {
  const value = normalizeThinking(provider, model, effort)
  if (!value) return {}
  if (provider === 'anthropic') return { thinking: { type: 'adaptive' }, output_config: { effort: value } }
  if (provider === 'opencode-go' && model.toLowerCase().startsWith('gpt-5.6')) return { reasoning: { effort: value } }
  if (provider === 'opencode-go' && /^(minimax-|qwen3\.)/.test(model.toLowerCase())) {
    return value === 'off' ? { thinking: { type: 'disabled' } } : {}
  }
  const options = thinkingOptions(provider, model)
  if (options.includes('on') || options.includes('off')) {
    return {
      thinking: { type: value === 'off' ? 'disabled' : 'enabled' },
      ...(options.includes('high') && !['off', 'on'].includes(value) ? { reasoning_effort: value } : {})
    }
  }
  return { reasoning_effort: value }
}

function openAIOptions(model: string): string[] {
  if (model.startsWith('gpt-5.6')) return ['none', 'low', 'medium', 'high', 'xhigh', 'max']
  if (model.startsWith('gpt-5.5-pro')) return ['medium', 'high', 'xhigh']
  if (model.startsWith('gpt-5.5')) return ['none', 'low', 'medium', 'high', 'xhigh']
  if (/^gpt-5\.[24]-pro/.test(model)) return ['medium', 'high', 'xhigh']
  if (/^gpt-5\.[23]-codex/.test(model)) return ['low', 'medium', 'high', 'xhigh']
  if (/^gpt-5\.[24]/.test(model)) return ['none', 'low', 'medium', 'high', 'xhigh']
  if (model.startsWith('gpt-5.1')) return ['none', 'low', 'medium', 'high']
  if (model.startsWith('gpt-5-pro')) return ['high']
  if (model.includes('-chat')) return []
  return model.startsWith('gpt-5') ? ['minimal', 'low', 'medium', 'high'] : []
}

function anthropicOptions(model: string): string[] {
  const version = model.replaceAll('.', '-')
  if (/(opus|sonnet|fable|mythos)-5/.test(version) || /opus-4-[78]/.test(version)) {
    return ['low', 'medium', 'high', 'xhigh', 'max']
  }
  if (/(opus|sonnet)-4-6/.test(version) || version.includes('mythos-preview')) return ['low', 'medium', 'high', 'max']
  return []
}
