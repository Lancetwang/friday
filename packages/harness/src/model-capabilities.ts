import type { ModelApi, ModelCapabilities, ModelReasoning } from 'friday-agent-protocol'

export type ResolvedCapabilities = {
  api: ModelApi
  tools: boolean
  max_tokens_field: 'max_tokens' | 'max_completion_tokens'
  reasoning: ModelReasoning
}

/** All name-based compatibility rules live here; new gateways can override them. */
export function resolveCapabilities(provider: string, model: string, overrides?: ModelCapabilities): ResolvedCapabilities {
  const name = model.toLowerCase()
  const api = overrides?.api ?? resolveDefaultApi(provider, name)
  const options = legacyThinkingOptions(provider, model)
  const mode = !options.length ? 'none' : api === 'anthropic'
    ? provider === 'anthropic' ? 'adaptive' : 'disabled-toggle'
    : options.includes('on') || options.includes('off') ? 'toggle' : 'effort'
  // Changing the wire API cannot safely inherit an incompatible reasoning dialect.
  const reasoning = overrides?.reasoning ?? (overrides?.api && overrides.api !== resolveDefaultApi(provider, name)
    ? { mode: 'none', options: [] } as ModelReasoning
    : { mode, options, ...(options.length ? { default: legacyDefaultThinking(provider, model) } : {}) })
  if (['adaptive', 'disabled-toggle'].includes(reasoning.mode) && api !== 'anthropic') {
    throw new Error(`${reasoning.mode} reasoning requires the Anthropic API.`)
  }
  if (reasoning.mode === 'toggle' && api === 'anthropic') throw new Error('Anthropic toggle reasoning requires a provider-specific budget; use adaptive, disabled-toggle, or none.')
  return { api, reasoning, tools: overrides?.tools ?? true,
    max_tokens_field: overrides?.max_tokens_field ?? (['openai', 'mimo'].includes(provider) ? 'max_completion_tokens' : 'max_tokens') }
}

function resolveDefaultApi(provider: string, name: string): ModelApi {
  return provider === 'anthropic' || provider === 'opencode-go' && /^(minimax-|qwen3\.)/.test(name)
    ? 'anthropic' : provider === 'opencode-go' && name.startsWith('gpt-5.6') ? 'responses' : 'chat-completions'
}

export function validateCapabilities(value: unknown): ModelCapabilities | undefined {
  if (value === undefined || value === null) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Model capabilities must be an object.')
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key => !['api', 'reasoning', 'tools', 'max_tokens_field'].includes(key))) throw new Error('Unknown model capability.')
  const result: ModelCapabilities = {}
  if (record.api !== undefined) {
    if (!['chat-completions', 'responses', 'anthropic'].includes(String(record.api))) throw new Error('Unsupported model API.')
    result.api = record.api as ModelApi
  }
  if (record.tools !== undefined) {
    if (typeof record.tools !== 'boolean') throw new Error('Tools capability must be boolean.')
    result.tools = record.tools
  }
  if (record.max_tokens_field !== undefined) {
    if (!['max_tokens', 'max_completion_tokens'].includes(String(record.max_tokens_field))) throw new Error('Unsupported output token field.')
    result.max_tokens_field = record.max_tokens_field as NonNullable<ModelCapabilities['max_tokens_field']>
  }
  if (record.reasoning !== undefined) {
    const raw = record.reasoning
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Reasoning capability must be an object.')
    const entry = raw as Record<string, unknown>
    if (Object.keys(entry).some(key => !['mode', 'options', 'default'].includes(key)) ||
      !['none', 'effort', 'adaptive', 'toggle', 'disabled-toggle'].includes(String(entry.mode)) || !Array.isArray(entry.options)) {
      throw new Error('Invalid reasoning capability.')
    }
    const options = entry.options
    if (options.length > 12 || options.some(item => typeof item !== 'string' || !/^[a-z][a-z0-9_-]{0,23}$/.test(item)) || new Set(options).size !== options.length ||
      (entry.mode === 'none' ? options.length !== 0 : options.length === 0) ||
      entry.default !== undefined && !options.includes(entry.default)) throw new Error('Invalid reasoning options or default.')
    if (['toggle', 'disabled-toggle'].includes(String(entry.mode)) && !options.includes('off')) throw new Error('Toggle reasoning must include off.')
    result.reasoning = { mode: entry.mode as ModelReasoning['mode'], options: [...options] as string[],
      ...(typeof entry.default === 'string' ? { default: entry.default } : {}) }
  }
  return Object.keys(result).length ? result : undefined
}

function legacyThinkingOptions(provider: string, model: string): string[] {
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

function legacyDefaultThinking(provider: string, model: string): string {
  const options = legacyThinkingOptions(provider, model)
  if (!options.length) return ''
  const name = model.toLowerCase()
  if ((provider === 'openai' || provider === 'opencode-go') && name.startsWith('gpt-5.6')) return 'medium'
  if (name === 'kimi-k3') return 'max'
  if (options.includes('on')) return 'on'
  if (options.includes('none') && /^gpt-5\.[124]/.test(name)) return 'none'
  if (options.includes('medium') && name.startsWith('gpt-5')) return 'medium'
  return options.includes('high') ? 'high' : options[0]!
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
