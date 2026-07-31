from __future__ import annotations

from typing import Any

THINKING_EFFORTS = ("off", "low", "high", "max")
DEFAULT_THINKING_EFFORT = "high"

# Provider protocols, not UI modes. MiMo currently exposes only an on/off
# switch, so its three non-off user levels intentionally share one wire format.
_THINKING_PROTOCOLS = {
    "deepseek": "effort",
    "mimo": "toggle",
}


def normalize_thinking_effort(value: str | None) -> str:
    effort = str(value or DEFAULT_THINKING_EFFORT).strip().lower()
    if effort not in THINKING_EFFORTS:
        raise ValueError(f"Thinking effort must be one of: {', '.join(THINKING_EFFORTS)}")
    return effort


def supports_thinking(provider: str) -> bool:
    return provider in _THINKING_PROTOCOLS


def thinking_request_kwargs(provider: str, effort: str | None) -> dict[str, Any]:
    protocol = _THINKING_PROTOCOLS.get(provider)
    if protocol is None:
        return {}
    normalized = normalize_thinking_effort(effort)
    thinking_type = "disabled" if normalized == "off" else "enabled"
    return {
        "extra_body": {"thinking": {"type": thinking_type}},
        **({"reasoning_effort": normalized} if protocol == "effort" and normalized != "off" else {}),
    }
