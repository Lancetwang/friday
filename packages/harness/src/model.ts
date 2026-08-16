import { AnthropicModel, OpenAIModel, ResponsesModel, type ChatModel } from 'friday-agent-core'

import type { ModelConfig } from './config.js'
import { thinkingBody } from './thinking.js'

export function modelFor(config: ModelConfig, thinking: string, outputLimit = config.maxOutputTokens): ChatModel {
  const common = {
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl,
    maxOutputTokens: Math.min(config.maxOutputTokens, outputLimit),
    body: thinkingBody(config.provider, config.model, thinking)
  }
  if (config.provider === 'anthropic' || (config.provider === 'opencode-go' && /^(minimax-|qwen3\.)/.test(config.model))) {
    // Explicit prompt-cache breakpoints only against the real Anthropic API;
    // Anthropic-compatible proxies may reject the cache_control field.
    return new AnthropicModel({ ...common, cacheControl: config.provider === 'anthropic' })
  }
  if (config.provider === 'opencode-go' && config.model.startsWith('gpt-5.6')) return new ResponsesModel(common)
  return new OpenAIModel({
    ...common,
    maxTokensField: ['openai', 'mimo'].includes(config.provider) ? 'max_completion_tokens' : 'max_tokens'
  })
}
