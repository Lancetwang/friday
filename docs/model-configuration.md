# Model Configuration

The desktop app manages providers under **Settings > Models**; the TUI exposes
the same catalog through `/login` and `/model`.

Friday supports two kinds of entries:

- **Built-in providers**: DeepSeek, Xiaomi MiMo, OpenAI, Anthropic, and
  OpenCode Go. Friday supplies their discovery base URLs. Saving a key attempts
  to refresh the provider's `/models` catalog; an authentication rejection is
  reported, while other catalog failures leave Friday's bundled model list
  available.
- **OpenAI-compatible profiles**: manually configured name, base URL, model id,
  API key, and limits. Each profile is independent, so several compatible
  services can coexist.

The selected provider/model pair also determines which thinking controls
Friday offers. Models without a known mapping have no thinking selector;
mapped models show only the values the runtime knows how to send.

Vision capability is deliberately a positive hint, not a local permission
check. Friday marks models when its bundled catalog or a provider's `/models`
metadata positively advertises image input, but missing or stale metadata means
"unknown", not "text-only". Clipboard and selected-file images are therefore
sent to the chosen provider even for a newly released or manually configured
model. The provider remains the authority; if it rejects image input, the
Harness rolls the failed turn back and returns a stable, actionable Friday
error instead of exposing the provider's response payload. This classification
is deliberately narrow: other provider failures keep their normal error after
the Harness has retried transient HTTP or network failures.

## Files and precedence

Friday keeps the model catalog and credentials outside the workspace:

```text
~/.friday/models.json                         profiles, active profile, disabled targets
~/.friday/model-credentials.json              API keys, keyed by profile id
~/.friday/config.json                         global fallback defaults and other settings
~/.friday/projects/<workspace-id>/config.json project fallback overrides and other settings
```

`models.json` is the source of truth for saved profiles. The two `config.json`
layers provide defaults when Friday has to create or validate a profile; the
project layer overrides the global layer. They are also used by settings such
as `disabled_plugins`. Friday does not use or migrate
`<workspace>/.friday/config.json` as a runtime configuration layer.

A minimal fallback configuration is:

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
| `provider` | One of Friday's provider ids. Use `openai-compatible` for another service that implements the OpenAI chat API. |
| `model` | Provider model identifier. |
| `base_url` | API base URL. Built-in discovery supplies a host-defined URL; compatible profiles require their own. |
| `context_window` | Configured context capacity and the denominator used by context-pressure checks. |
| `max_output_tokens` | Maximum output requested for one main-agent call. It must not exceed `context_window`. |
| `run_token_budget` | Positive compatibility field retained in stored profiles and old configs. The current runtime does not enforce it. |

Profile values stored in `models.json` take precedence over these fallback
defaults. Editing a fallback does not rewrite existing profiles.

## Credentials

Keys saved by Friday live in `~/.friday/model-credentials.json`, are omitted
from the public model catalog, and are not written to sessions or normal trace
metadata. The reveal control reads a saved key only after the user requests it.

Headless runs can use process environment variables instead. Resolution is:
the saved profile key, `<PROVIDER>_API_KEY`, then `LLM_API_KEY`; the built-in
providers also recognize their conventional names such as `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `MIMO_API_KEY`, and
`OPENCODE_API_KEY`. Friday does not load `.env` files.

Web credentials are separate from model credentials. For example:

```text
TAVILY_API_KEY=optional-web-search-key
ANYSEARCH_API_KEY=optional-web-search-fallback-key
JINA_API_KEY=optional-web-fetch-key
```

Keep `model-credentials.json` private even though normal traces redact common
secret patterns.

## When changes take effect

Selecting a model through the desktop or TUI rebuilds the active idle session
with that profile. Saving, refreshing, enabling, or deleting profiles updates
the catalog and also moves the session when its active profile changes. Model
operations are rejected while a request is running. Direct JSON edits are read
when a session is created or a model is selected again; they are not a
supported hot-reload channel.

The fallback limits are a 1,000,000-token context window and 65,536 output
tokens per main-agent call. They are configuration defaults, not a claim about
every provider's actual limits. Set both to values the selected model supports
and leave enough context headroom for the prompt and tool schemas.

Context pressure is handled by the Harness compaction plugin. Its compatibility
default is automatic insert-and-compact at 85% occupancy; Settings → Compaction
or `/compaction` can change the threshold, disable automatic compaction while
retaining manual compaction, or enable the two-stage tool-receipt strategy. A
normal Agent attempt has a 100-step guard, an independent verifier has 40
steps, and Goal mode can make at most six attempts. Provider usage is measured
and reported but is not stopped by `run_token_budget`. See [Verification, Run
Guards, and Compaction](verification.md) for the complete behavior.
