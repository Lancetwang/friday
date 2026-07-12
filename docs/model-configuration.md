# Model Configuration

Friday keeps non-secret model settings in JSON and credentials in `.env`.

The global file is `~/.friday/config.json`. An optional `<workspace>/.friday/config.json` overrides the global values for one project. Missing keys inherit from the preceding layer.

```json
{
  "provider": "deepseek",
  "model": "deepseek-v4-flash",
  "base_url": "https://api.deepseek.com",
  "context_window": 353000,
  "max_output_tokens": 65536
}
```

| Key | Meaning |
| --- | --- |
| `provider` | Provider name. Friday uses it to look for `<PROVIDER>_API_KEY`. |
| `model` | OpenAI-compatible model identifier. |
| `base_url` | Provider API base URL. Use an empty string for the OpenAI default. |
| `context_window` | Friday's context budget and compaction denominator. |
| `max_output_tokens` | Maximum generated tokens for one main-agent model call. |

Credentials stay in the active process, `<workspace>/.env`, or `~/.friday/.env`. The provider-specific key is preferred, then `LLM_API_KEY`, `OPENAI_API_KEY`, and `DEEPSEEK_API_KEY` are tried as fallbacks.

```text
DEEPSEEK_API_KEY=your-key
TAVILY_API_KEY=optional-web-search-key
JINA_API_KEY=optional-web-fetch-key
```

Friday exposes both config paths in the Environment prompt, so it can edit them when explicitly asked. Changes take effect after Friday starts a new session or rebuilds the context.

The defaults use a 353K working context and a 64K per-call output budget. The output budget is deliberately configurable because provider limits differ; set it no higher than the selected model supports. Friday's verifier keeps its own smaller JSON response budget.
