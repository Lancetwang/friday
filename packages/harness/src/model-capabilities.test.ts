import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadModelCatalog, loadModelConfig, saveModelProfile } from './config.js'
import { resolveCapabilities, validateCapabilities } from './model-capabilities.js'
import { modelFor } from './model.js'
import { defaultThinking, thinkingBody, thinkingOptions } from './thinking.js'

test('unknown model overrides drive API, reasoning, tool and token fields on the wire', async () => {
  const original = globalThis.fetch
  try {
    for (const api of ['chat-completions', 'responses', 'anthropic'] as const) {
      let url = ''; let body: Record<string, unknown> = {}
      globalThis.fetch = async (input, init) => {
        url = String(input); body = JSON.parse(String(init?.body))
        const events = api === 'chat-completions' ? [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]
          : api === 'responses' ? [{ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] } }]
          : [{ type: 'message_start', message: {} }, { type: 'content_block_start', index: 0, content_block: { type: 'text' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }, { type: 'message_stop' }]
        return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
      }
      const capabilities = validateCapabilities({ api, tools: false, max_tokens_field: 'max_completion_tokens',
        reasoning: { mode: api === 'anthropic' ? 'adaptive' : 'effort', options: ['low', 'high'], default: 'low' } })!
      assert.equal(defaultThinking('openai-compatible', 'future', capabilities), 'low')
      assert.deepEqual(thinkingOptions('openai-compatible', 'future', capabilities), ['low', 'high'])
      await modelFor({ profileId: 'custom', profileName: 'Custom', provider: 'openai-compatible', model: 'future',
        apiKey: 'test', baseUrl: 'http://localhost:12345/v1', contextWindow: 32768, maxOutputTokens: 2000, capabilities }, 'high').complete({
        messages: [{ role: 'user', content: 'hello' }], tools: [{ type: 'function', function: { name: 'Probe', description: '', parameters: {} } }] })
      assert.match(url, api === 'responses' ? /\/responses$/ : api === 'anthropic' ? /\/messages$/ : /\/chat\/completions$/)
      assert.equal(body.tools, undefined)
      assert.equal(body[api === 'responses' ? 'max_output_tokens' : api === 'anthropic' ? 'max_tokens' : 'max_completion_tokens'], 2000)
      assert.deepEqual(api === 'responses' ? body.reasoning : api === 'anthropic' ? body.output_config : body.reasoning_effort,
        api === 'chat-completions' ? 'high' : { effort: 'high' })
    }
  } finally { globalThis.fetch = original }
})

test('capability validation rejects ambiguous dialects and keeps existing compatibility behavior', () => {
  assert.throws(() => validateCapabilities({ reasoning: { mode: 'effort', options: ['high', 'high'] } }), /Invalid/)
  assert.throws(() => validateCapabilities({ tools: 'false' }), /boolean/)
  assert.throws(() => validateCapabilities({ api: 'imaginary' }), /API/)
  assert.throws(() => resolveCapabilities('openai', 'future', { reasoning: { mode: 'adaptive', options: ['high'] } }), /Anthropic/)
  assert.equal(resolveCapabilities('opencode-go', 'gpt-5.6-luna').api, 'responses')
  assert.deepEqual(thinkingBody('opencode-go', 'minimax-m3', 'off'), { thinking: { type: 'disabled' } })
  assert.deepEqual(thinkingBody('deepseek', 'deepseek-v4-pro', 'high'), { thinking: { type: 'enabled' }, reasoning_effort: 'high' })
  assert.deepEqual(thinkingOptions('openai', 'gpt-5.6', { api: 'anthropic' }), [])
})

test('saved model overrides and explicit false vision survive a builtin catalog refresh', async () => {
  const root = await mkdtemp(join(tmpdir(), 'friday-model-config-'))
  const workspace = join(root, 'workspace'); await mkdir(workspace)
  const previous = process.env.FRIDAY_HOME; const original = globalThis.fetch
  process.env.FRIDAY_HOME = join(root, 'state')
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: 'gpt-5.1', capabilities: { tools: true }, vision: true }] }), { headers: { 'content-type': 'application/json' } })
  try {
    const profile = { id: 'custom-openai', name: 'My proxy', provider: 'openai', model: 'gpt-5.1', base_url: 'https://proxy.example/v1',
      context_window: 32000, max_output_tokens: 1024, vision: false, capabilities: { api: 'responses', tools: false } }
    await saveModelProfile(workspace, profile, { apiKey: 'test' })
    await saveModelProfile(workspace, profile, { apiKey: 'refreshed' })
    const saved = loadModelCatalog(workspace).profiles.find(item => item.id === 'custom-openai')!
    assert.equal(saved.vision, false); assert.equal(saved.name, 'My proxy'); assert.equal(saved.base_url, 'https://proxy.example/v1')
    assert.equal(saved.context_window, 32000); assert.deepEqual(saved.capabilities, profile.capabilities)
    assert.deepEqual(loadModelConfig(workspace, saved.id).capabilities, profile.capabilities)
    assert.equal(loadModelConfig(workspace, saved.id).vision, false)
    await assert.rejects(saveModelProfile(workspace, { ...profile, capabilities: { tools: 'yes' } }), /boolean/)
    for (const field of ['context_window', 'max_output_tokens', 'run_token_budget']) {
      await assert.rejects(saveModelProfile(workspace, { ...profile, [field]: 0 }), /positive integer/)
    }
  } finally {
    globalThis.fetch = original
    if (previous === undefined) delete process.env.FRIDAY_HOME; else process.env.FRIDAY_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})
