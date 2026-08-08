# Model Configuration

The desktop app exposes model providers under **Settings > Models**. Two kinds of providers exist:

- **Built-in providers** (DeepSeek, Xiaomi MiMo, OpenAI, Anthropic, OpenCode Go) have a fixed base URL. Paste an API key and press Enter: Friday calls the provider's `/models` endpoint and turns every model it advertises into a profile. The row controls reveal or clear the saved key, refresh the model catalog, and enable or hide that provider in Friday's model menu. Providers that protect `/models` also validate the key at this point; OpenCode Go publishes its model catalog publicly, so its key is validated by the first model request.
- **OpenAI-compatible providers** cover every other service that speaks the OpenAI chat API (self-hosted vLLM, SiliconFlow, Groq, ...). Each entry keeps its own name, base URL, model id, and API key; add as many as you need.

Every profile keeps its provider, base URL, model name, token limits, and optional vision capability separate, so conversations can switch models without editing files. Profiles created by model discovery are marked `auto`; re-saving the key re-syncs them (new models appear, removed ones are dropped), while manually configured OpenAI-compatible entries are never touched.

Thinking controls are model-specific. Friday only exposes values documented for the selected model: binary models show On/Off, effort-based models show their real effort levels, and fixed-thinking models show no selector.

Friday keeps non-secret model settings in JSON and credentials outside project files.

The global file is `~/.friday/config.json`. An optional `~/.friday/projects/<workspace-id>/config.json` overrides the global values for one project. Missing keys inherit from the preceding layer. Existing `<workspace>/.friday/config.json` files are migrated there on startup and removed when the legacy directory becomes empty.

```json
{
  "provider": "deepseek",
  "model": "deepseek-v4-flash",
  "base_url": "https://api.deepseek.com",
  "context_window": 1000000,
  "max_output_tokens": 65536
}
```

| Key | Meaning |
| --- | --- |
| `provider` | Provider name. Friday uses it to look for `<PROVIDER>_API_KEY`. Use `openai-compatible` for services that speak the OpenAI chat API without a dedicated entry. |
| `model` | OpenAI-compatible model identifier. |
| `base_url` | Provider API base URL. Use an empty string for the OpenAI default. Required for `openai-compatible` profiles. |
| `context_window` | How much the conversation may occupy, and the denominator compaction measures against. |
| `max_output_tokens` | Maximum generated tokens for one main-agent model call. |
| `run_token_budget` | Accepted so older config files keep loading, and no longer enforced. Nothing stops a turn on spend. |

The window is the only resource that bounds a turn, and it is a level rather than a total: the conversation occupies part of it, compaction shrinks it, and it grows linearly as work accumulates. A turn's cumulative token usage is a different quantity — because an append-only conversation is re-sent on every step, it grows with the square of the step count and reaches many times the window on a long run. That total is the bill, so Friday reports it in the turn metrics next to window occupancy, and compares it against nothing. Enforcing it as a ceiling is what used to end long turns whose windows were still mostly empty.

Desktop-managed model credentials stay in `~/.friday/model-credentials.json`. They are excluded from model catalogs, sessions, and traces; the local settings process reads one only when the user explicitly presses its reveal control. Environment-based credentials may instead live in the active process, `<workspace>/.env`, or `~/.friday/.env`. Friday reads only supported model and Web API key names from those files; control settings such as permission mode are ignored. The provider-specific key is preferred, then `LLM_API_KEY`, `OPENAI_API_KEY`, and `DEEPSEEK_API_KEY` are tried as fallbacks.

```text
DEEPSEEK_API_KEY=your-key
OPENCODE_API_KEY=optional-opencode-go-key
TAVILY_API_KEY=optional-web-search-key
ANYSEARCH_API_KEY=optional-web-search-fallback-key
JINA_API_KEY=optional-web-fetch-key
```

Friday exposes both config paths in the Environment prompt, so it can edit them when explicitly asked. Changes take effect after Friday starts a new session or rebuilds the context.

The defaults use the model's full 1M-token window and a 64K per-call output budget. The window is the only bound on a run: compaction keeps the conversation inside it, and no budget stops a turn on spend (see [Verification](verification.md)). The output budget is deliberately configurable because provider limits differ; set it no higher than the selected model supports. Friday's verifier keeps its own smaller JSON response budget.
