import { setTimeout as delay } from 'node:timers/promises'

import {
  AnthropicModel,
  ModelRequestError,
  OpenAIModel,
  ResponsesModel,
  type ChatModel,
  type ModelRequest
} from 'friday-agent-core'

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
    return withModelRetries(new AnthropicModel({ ...common, cacheControl: config.provider === 'anthropic' }))
  }
  if (config.provider === 'opencode-go' && config.model.startsWith('gpt-5.6')) {
    return withModelRetries(new ResponsesModel(common))
  }
  return withModelRetries(new OpenAIModel({
    ...common,
    maxTokensField: ['openai', 'mimo'].includes(config.provider) ? 'max_completion_tokens' : 'max_tokens'
  }))
}

const MODEL_RETRY_DELAYS_MS = [250, 750] as const
const RETRYABLE_HTTP_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504])

/**
 * Retry only failures for which replay is both useful and invisible. Once a
 * stream has emitted text or reasoning, replay would duplicate user-visible
 * output, so that attempt is allowed to fail normally.
 */
export function withModelRetries(
  model: ChatModel,
  delays: readonly number[] = MODEL_RETRY_DELAYS_MS
): ChatModel {
  return {
    async complete(request: ModelRequest) {
      for (let attempt = 0; ; attempt += 1) {
        let emitted = false
        try {
          return await model.complete(trackOutput(request, () => { emitted = true }))
        } catch (error) {
          const waitMs = delays[attempt]
          if (waitMs === undefined || emitted || request.signal?.aborted || !isRetryableModelError(error)) throw error
          await delay(waitMs, undefined, request.signal ? { signal: request.signal } : undefined)
        }
      }
    }
  }
}

function trackOutput(request: ModelRequest, emitted: () => void): ModelRequest {
  return {
    ...request,
    ...(request.onDelta
      ? { onDelta: (text: string) => { emitted(); request.onDelta?.(text) } }
      : {}),
    ...(request.onReasoningDelta
      ? { onReasoningDelta: (text: string) => { emitted(); request.onReasoningDelta?.(text) } }
      : {})
  }
}

function isRetryableModelError(error: unknown): boolean {
  if (error instanceof ModelRequestError) return RETRYABLE_HTTP_STATUS.has(error.status)
  return error instanceof Error && error.name !== 'AbortError' && error.name !== 'TimeoutError'
}
