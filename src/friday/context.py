from __future__ import annotations

import json
import os
from typing import Any

from agent_core import RunContext

from friday.config import DEFAULT_MODEL_CONFIG

DEFAULT_CONTEXT_WINDOW = DEFAULT_MODEL_CONFIG.context_window
TOOL_COMPACT_AT = 0.85
TOOL_COMPACT_GAIN = 0.25
TOOL_RESULT_LIMIT = 900


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
    # ponytail: rough token budget; replace with provider usage if runtime exposes it.
    return _tokens(len(_context_text(context)) + len(_tool_schema_text(tools)))


def context_ratio(context: RunContext, tools: list[Any] | None = None) -> float:
    return token_estimate(context, tools) / context_window(context)


def context_report(context: RunContext, tools: list[Any] | None = None) -> str:
    sections = _sections(_system_text(context))
    skill = sections.get("Skills", "")
    tool_schema = _tool_schema_text(tools)
    ordinary = "\n".join(
        str(message.get("content", ""))
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
    total_chars = sum(len(value) for _, value in rows)
    total_tokens = _tokens(total_chars)
    window = context_window(context)
    lines = [
        "# Context",
        f"- window: {window} tokens",
        f"- current local estimate: ~{total_tokens} tokens / {total_chars} chars / {total_tokens / window:.1%}",
    ]
    usage = context.metadata.get("friday.last_usage")
    if isinstance(usage, dict):
        input_tokens = usage.get("input_tokens")
        output_tokens = usage.get("output_tokens")
        total = input_tokens + output_tokens if isinstance(input_tokens, int) and isinstance(output_tokens, int) else "n/a"
        input_value = input_tokens if isinstance(input_tokens, int) else "n/a"
        output_value = output_tokens if isinstance(output_tokens, int) else "n/a"
        source = "estimated" if usage.get("estimated_tokens") else "provider"
        lines.append(f"- last turn usage ({source}): input {input_value} / output {output_value} / total {total}")
    else:
        lines.append("- last turn usage: n/a")
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
    return "\n".join(str(message.get("content", "")) for message in context.get_messages())


def _tool_schema_text(tools: list[Any] | None) -> str:
    return json.dumps([tool.to_llm_format() for tool in tools or []], ensure_ascii=False, default=str)


def _system_text(context: RunContext) -> str:
    return "\n".join(str(message.get("content", "")) for message in context.get_messages() if message.get("role") == "system")


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


def _tool_compaction_probe(context: RunContext) -> list[tuple[dict[str, Any], int, int]]:
    probe = []
    for message in context.get_messages():
        if message.get("role") != "tool" or message.get("friday_compacted"):
            continue
        content = str(message.get("content", ""))
        if len(content) <= TOOL_RESULT_LIMIT:
            continue
        simplified = _simplify_tool_result(content)
        if len(simplified) < len(content):
            probe.append((message, len(content), len(simplified)))
    return probe


def _simplify_tool_result(content: str) -> str:
    try:
        value = json.loads(content)
    except json.JSONDecodeError:
        return content
    if not isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    lines = ["[tool result simplified; all fields preserved]"]
    for key, item in value.items():
        label = json.dumps(str(key), ensure_ascii=False)
        if isinstance(item, str):
            lines.extend((f"{label}: string({len(item)})", item))
        else:
            lines.append(f"{label}: {json.dumps(item, ensure_ascii=False, separators=(',', ':'))}")
    return "\n".join(lines)
