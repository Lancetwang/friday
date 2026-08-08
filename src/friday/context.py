from __future__ import annotations

import json
import os
from collections.abc import Mapping
from typing import Any

from agent_core import RunContext

from friday.config import DEFAULT_MODEL_CONFIG

DEFAULT_CONTEXT_WINDOW = DEFAULT_MODEL_CONFIG.context_window
TOOL_COMPACT_AT = 0.85
TOOL_COMPACT_GAIN = 0.25
_TOKEN_ANCHORS = "friday.context_token_anchors"
_PENDING_TOKEN_ANCHORS = "friday.pending_context_token_anchors"


def context_window(context: RunContext | None = None) -> int:
    if context is not None:
        config = context.metadata.get("friday.model_config")
        if isinstance(config, dict) and isinstance(config.get("context_window"), int):
            return max(1000, config["context_window"])
    try:
        return max(1000, int(os.getenv("FRIDAY_CONTEXT_WINDOW", DEFAULT_CONTEXT_WINDOW)))
    except ValueError:
        return DEFAULT_CONTEXT_WINDOW


def token_estimate(context: RunContext, tools: list[Any] | None = None) -> int:
    return int(token_measurement(context, tools)["tokens"])


def token_measurement(context: RunContext, tools: list[Any] | None = None) -> dict[str, Any]:
    """Measure the next prompt from the latest provider count plus its local delta."""
    message_chars = len(_message_schema_text(context.get_messages()))
    anchors = context.metadata.get(_TOKEN_ANCHORS)
    anchor = anchors.get(_scope_key(context)) if isinstance(anchors, Mapping) else None
    if tools is None and isinstance(anchor, Mapping):
        tool_chars = int(anchor.get("tool_chars") or 0)
    else:
        tool_chars = len(_tool_schema_text(tools))
    chars = message_chars + tool_chars

    if isinstance(anchor, Mapping):
        prompt_tokens = anchor.get("prompt_tokens")
        anchor_chars = anchor.get("chars")
        if isinstance(prompt_tokens, int) and isinstance(anchor_chars, int):
            delta_tokens = _token_delta(chars - anchor_chars)
            return {
                "tokens": max(1, prompt_tokens + delta_tokens),
                "provider_tokens": prompt_tokens,
                "delta_tokens": delta_tokens,
                "chars": chars,
                "source": "provider" if delta_tokens == 0 else "provider+local-delta",
            }

    return {
        "tokens": _tokens(chars),
        "provider_tokens": None,
        "delta_tokens": None,
        "chars": chars,
        "source": "local",
    }


def observe_context_usage(context: RunContext, event_type: str, data: Any) -> None:
    """Anchor context occupancy to the provider's exact prompt count."""
    if not isinstance(data, Mapping):
        return
    if event_type == "model.request.payload":
        messages = data.get("messages")
        tools = data.get("tools")
        if not isinstance(messages, list):
            return
        message_chars = len(_message_schema_text(messages))
        tool_chars = len(_tool_schema_text(tools if isinstance(tools, list) else []))
        pending = context.metadata.setdefault(_PENDING_TOKEN_ANCHORS, {})
        if not isinstance(pending, dict):
            pending = {}
            context.metadata[_PENDING_TOKEN_ANCHORS] = pending
        pending[_scope_key(context)] = {
            "chars": message_chars + tool_chars,
            "tool_chars": tool_chars,
        }
        return
    if event_type != "model.response.payload":
        return

    pending_by_scope = context.metadata.get(_PENDING_TOKEN_ANCHORS)
    pending = pending_by_scope.pop(_scope_key(context), None) if isinstance(pending_by_scope, dict) else None
    message = data.get("message")
    usage = message.get("usage") if isinstance(message, Mapping) else data.get("usage")
    prompt_tokens = _usage_int(usage, "prompt_tokens", "input_tokens")
    if isinstance(pending, Mapping) and prompt_tokens is not None:
        anchors = context.metadata.setdefault(_TOKEN_ANCHORS, {})
        if not isinstance(anchors, dict):
            anchors = {}
            context.metadata[_TOKEN_ANCHORS] = anchors
        anchors[_scope_key(context)] = {**dict(pending), "prompt_tokens": prompt_tokens}


def estimate_tokens(text: str) -> int:
    """The same rough char-to-token rule the budget checks use."""
    return _tokens(len(text))


def content_text(content: Any) -> str:
    """Readable text for a message body, whether it is a string or content parts."""
    return _content_text(content)


def context_ratio(context: RunContext, tools: list[Any] | None = None) -> float:
    return token_estimate(context, tools) / context_window(context)


def context_report(context: RunContext, tools: list[Any] | None = None) -> str:
    sections = _sections(_system_text(context))
    skill = sections.get("Skills", "")
    tool_schema = _tool_schema_text(tools)
    ordinary = "\n".join(
        _content_text(message.get("content", ""))
        for message in context.get_messages()
        if message.get("role") in {"user", "assistant"}
    )
    tool_results = "\n".join(
        str(message.get("content", ""))
        for message in context.get_messages()
        if message.get("role") == "tool"
    )
    rows = [
        ("system prompt", _system_text(context)),
        ("skill routing", skill),
        ("tool schemas", tool_schema),
        ("messages", ordinary),
        ("tool results", tool_results),
    ]
    measurement = token_measurement(context, tools)
    total_chars = int(measurement["chars"])
    total_tokens = int(measurement["tokens"])
    window = context_window(context)
    source = str(measurement["source"])
    marker = "" if source == "provider" else "~"
    lines = [
        "# Context",
        f"- window: {window} tokens",
        f"- in the window now: {marker}{total_tokens} tokens / {total_chars} chars / {total_tokens / window:.1%} ({source})",
        f"- compaction starts at: {int(window * TOOL_COMPACT_AT)} tokens ({TOOL_COMPACT_AT:.0%})",
    ]
    if source == "provider+local-delta":
        lines.append(
            f"- measurement: provider anchor {measurement['provider_tokens']} tokens"
            f" + local delta {int(measurement['delta_tokens']):+d}"
        )
    usage = context.metadata.get("friday.last_usage")
    if isinstance(usage, dict):
        input_tokens = usage.get("input_tokens")
        output_tokens = usage.get("output_tokens")
        total = input_tokens + output_tokens if isinstance(input_tokens, int) and isinstance(output_tokens, int) else "n/a"
        input_value = input_tokens if isinstance(input_tokens, int) else "n/a"
        output_value = output_tokens if isinstance(output_tokens, int) else "n/a"
        cached = usage.get("cached_tokens")
        cached_value = cached if isinstance(cached, int) else "n/a"
        requests = usage.get("requests")
        source = "estimated" if usage.get("estimated_tokens") else "provider"
        # Cost, not occupancy: every step re-sends the window, so this total runs
        # far ahead of the line above and says nothing about how full the window is.
        lines.append(
            f"- last turn cost ({source}, summed over {requests if isinstance(requests, int) else 'n/a'} requests):"
            f" input {input_value} / output {output_value} / cached {cached_value} / total {total}"
        )
    else:
        lines.append("- last turn cost: n/a")
    lines.append("")
    lines.append("| Part | Local est. tokens | Exact chars |")
    lines.append("| --- | ---: | ---: |")
    for name, value in rows:
        lines.append(f"| {name} | ~{_tokens(len(value))} | {len(value)} |")
    return "\n".join(lines)


def should_compact_tools(context: RunContext, tools: list[Any] | None = None) -> bool:
    return context_ratio(context, tools) >= TOOL_COMPACT_AT and tool_compaction_gain(context, tools) >= TOOL_COMPACT_GAIN


def should_compact_conversation(context: RunContext, tools: list[Any] | None = None) -> bool:
    return context_ratio(context, tools) >= TOOL_COMPACT_AT and not should_compact_tools(context, tools)


def tool_compaction_gain(context: RunContext, tools: list[Any] | None = None) -> float:
    current = token_estimate(context, tools)
    saved = _tokens(sum(before - after for _, before, after in _tool_compaction_probe(context)))
    return saved / current if current else 0.0


def compact_tool_results(context: RunContext, tools: list[Any] | None = None) -> int:
    count = 0
    for message, _, _ in _tool_compaction_probe(context):
        content = str(message.get("content", ""))
        message["content"] = _simplify_tool_result(content)
        message["friday_compacted"] = True
        count += 1
    return count


def _context_text(context: RunContext) -> str:
    return "\n".join(_content_text(message.get("content", "")) for message in context.get_messages())


def _tool_schema_text(tools: list[Any] | None) -> str:
    schemas = [tool.to_llm_format() if hasattr(tool, "to_llm_format") else tool for tool in tools or []]
    return json.dumps(_wire_value(schemas), ensure_ascii=False, separators=(",", ":"), sort_keys=True, default=str)


def _message_schema_text(messages: Any) -> str:
    return json.dumps(_wire_value(messages), ensure_ascii=False, separators=(",", ":"), sort_keys=True, default=str)


def _wire_value(value: Any) -> Any:
    if isinstance(value, Mapping):
        if value.get("type") == "image_url":
            image = value.get("image_url")
            detail = image.get("detail") if isinstance(image, Mapping) else None
            return {
                "type": "image_url",
                "image_url": {
                    "url": "[image attachment]",
                    **({"detail": detail} if detail else {}),
                },
            }
        return {str(key): _wire_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_wire_value(item) for item in value]
    return value


def _system_text(context: RunContext) -> str:
    return "\n".join(_content_text(message.get("content", "")) for message in context.get_messages() if message.get("role") == "system")


def _content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "text":
                parts.append(str(item.get("text") or ""))
            elif item.get("type") == "image_url":
                parts.append("[image attachment]")
        return "\n".join(parts)
    return str(content or "")


def _sections(text: str) -> dict[str, str]:
    sections: dict[str, list[str]] = {}
    current = ""
    for line in text.splitlines():
        if line.startswith("## "):
            current = line[3:].strip()
            sections.setdefault(current, [])
        elif current:
            sections[current].append(line)
    return {key: "\n".join(value).strip() for key, value in sections.items()}


def _tokens(chars: int) -> int:
    return max(1, (chars + 3) // 4)


def _token_delta(chars: int) -> int:
    return (chars + 3) // 4 if chars >= 0 else -((-chars + 3) // 4)


def _usage_int(usage: Any, *names: str) -> int | None:
    if not isinstance(usage, Mapping):
        return None
    for name in names:
        value = usage.get(name)
        if isinstance(value, int) and not isinstance(value, bool):
            return value
    return None


def _scope_key(context: RunContext) -> str:
    return context.active_message_scope or "__default__"


def _tool_compaction_probe(context: RunContext) -> list[tuple[dict[str, Any], int, int]]:
    probe = []
    for message in context.get_messages():
        if message.get("role") != "tool" or message.get("friday_compacted"):
            continue
        content = str(message.get("content", ""))
        simplified = _simplify_tool_result(content)
        before = len(json.dumps(content, ensure_ascii=False, separators=(",", ":")))
        after = len(json.dumps(simplified, ensure_ascii=False, separators=(",", ":")))
        if after < before:
            probe.append((message, before, after))
    return probe


def _simplify_tool_result(content: str) -> str:
    try:
        value = json.loads(content)
    except json.JSONDecodeError:
        return content
    if not isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    if isinstance(value.get("full_output_path"), str):
        compacted = {key: item for key, item in value.items() if key not in {"content", "output"}}
        compacted["preview_removed"] = True
        return "[tool result compacted; full output preserved]\n" + json.dumps(
            compacted,
            ensure_ascii=False,
            separators=(",", ":"),
        )

    lines = ["[tool result simplified; all fields preserved]"]
    for key, item in value.items():
        label = json.dumps(str(key), ensure_ascii=False)
        if isinstance(item, str):
            lines.extend((f"{label}: string({len(item)})", item))
        else:
            lines.append(f"{label}: {json.dumps(item, ensure_ascii=False, separators=(',', ':'))}")
    return "\n".join(lines)
