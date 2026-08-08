from __future__ import annotations

from typing import Any

DEFAULT_THINKING_EFFORT = "high"


def thinking_options(provider: str, model: str) -> tuple[str, ...]:
    """Return only the controls the selected model actually accepts."""
    provider = provider.lower()
    model = model.lower()

    if provider == "deepseek" and model.startswith("deepseek-v4-"):
        return ("off", "high", "max")
    if provider == "mimo" and model in {"mimo-v2.5", "mimo-v2.5-pro"}:
        return ("off", "on")
    if provider == "openai":
        return _openai_options(model)
    if provider == "anthropic":
        return _anthropic_options(model)
    if provider != "opencode-go":
        return ()

    if model.startswith("gpt-5.6"):
        return ("none", "low", "medium", "high", "xhigh", "max")
    if model == "grok-4.5":
        return ("low", "medium", "high")
    if model == "glm-5.2":
        return ("high", "max")
    if model in {"glm-5.1", "glm-5"}:
        return ("off", "on")
    if model == "kimi-k3":
        return ("low", "high", "max")
    if model == "kimi-k2.6":
        return ("off", "on")
    if model == "minimax-m3":
        return ("off", "on")
    if model.startswith(("qwen3.5-", "qwen3.6-", "qwen3.7-")):
        return ("off", "on")
    if model == "hy3":
        return ("none", "low", "high")
    if model.startswith("deepseek-v4-"):
        return ("off", "high", "max")
    if model in {"mimo-v2.5", "mimo-v2.5-pro"}:
        return ("off", "on")
    # Fixed-thinking and undocumented legacy models deliberately have no
    # selector. Omitting a control is safer than sending a guessed parameter.
    return ()


def default_thinking_effort(provider: str, model: str) -> str:
    provider = provider.lower()
    options = thinking_options(provider, model)
    if not options:
        return ""
    model = model.lower()
    if provider == "openai" and model.startswith(("gpt-5.6", "gpt-5.5")):
        return "medium"
    if provider == "opencode-go" and model.startswith("gpt-5.6"):
        return "medium"
    if model == "kimi-k3":
        return "max"
    if "on" in options:
        return "on"
    if "none" in options and model.startswith(("gpt-5.1", "gpt-5.2", "gpt-5.4")):
        return "none"
    if "medium" in options and model.startswith("gpt-5"):
        return "medium"
    return "high" if "high" in options else options[0]


def normalize_thinking_effort(
    provider: str,
    model: str,
    value: str | None,
    *,
    strict: bool = False,
) -> str:
    options = thinking_options(provider, model)
    if not options:
        return ""
    effort = str(value or "").strip().lower()
    if effort == "off" and "none" in options:
        effort = "none"
    if effort in options:
        return effort
    if strict:
        raise ValueError(f"Thinking effort for {model} must be one of: {', '.join(options)}")
    return default_thinking_effort(provider, model)


def supports_thinking(provider: str, model: str) -> bool:
    return len(thinking_options(provider, model)) > 1


def model_api_mode(provider: str, model: str) -> str:
    provider = provider.lower()
    model = model.lower()
    if provider == "anthropic":
        return "messages"
    if provider != "opencode-go":
        return "chat"
    if model.startswith("gpt-5.6"):
        return "responses"
    if model.startswith(("minimax-", "qwen3.")):
        return "messages"
    return "chat"


def thinking_request_kwargs(provider: str, model: str, effort: str | None) -> dict[str, Any]:
    provider = provider.lower()
    model = model.lower()
    normalized = normalize_thinking_effort(provider, model, effort)
    if not normalized:
        return {}

    if provider == "anthropic":
        return {
            "thinking": {"type": "adaptive"},
            "output_config": {"effort": normalized},
        }
    if provider == "opencode-go" and model.startswith("gpt-5.6"):
        return {"reasoning": {"effort": normalized}}
    if provider == "opencode-go" and model.startswith(("minimax-", "qwen3.")):
        return {"thinking": {"type": "disabled"}} if normalized == "off" else {}

    options = thinking_options(provider, model)
    if "on" in options or "off" in options:
        kwargs: dict[str, Any] = {
            "extra_body": {"thinking": {"type": "disabled" if normalized == "off" else "enabled"}}
        }
        if "high" in options and normalized not in {"off", "on"}:
            kwargs["reasoning_effort"] = normalized
        return kwargs
    return {"reasoning_effort": normalized}


def _openai_options(model: str) -> tuple[str, ...]:
    if model.startswith("gpt-5.6"):
        return ("none", "low", "medium", "high", "xhigh", "max")
    if model.startswith("gpt-5.5-pro"):
        return ("medium", "high", "xhigh")
    if model.startswith("gpt-5.5"):
        return ("none", "low", "medium", "high", "xhigh")
    if model.startswith(("gpt-5.4-pro", "gpt-5.2-pro")):
        return ("medium", "high", "xhigh")
    if model.startswith(("gpt-5.3-codex", "gpt-5.2-codex")):
        return ("low", "medium", "high", "xhigh")
    if model.startswith(("gpt-5.4", "gpt-5.2")):
        return ("none", "low", "medium", "high", "xhigh")
    if model.startswith("gpt-5.1"):
        return ("none", "low", "medium", "high")
    if model.startswith("gpt-5-pro"):
        return ("high",)
    if "-chat" in model:
        return ()
    if model.startswith("gpt-5"):
        return ("minimal", "low", "medium", "high")
    return ()


def _anthropic_options(model: str) -> tuple[str, ...]:
    version = model.replace(".", "-")
    if any(name in version for name in ("opus-5", "sonnet-5", "fable-5", "mythos-5")):
        return ("low", "medium", "high", "xhigh", "max")
    if any(name in version for name in ("opus-4-8", "opus-4-7")):
        return ("low", "medium", "high", "xhigh", "max")
    if any(name in version for name in ("opus-4-6", "sonnet-4-6")):
        return ("low", "medium", "high", "max")
    if "mythos-preview" in version:
        return ("low", "medium", "high", "max")
    return ()
