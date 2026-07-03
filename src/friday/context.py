from __future__ import annotations

import json
import os
from typing import Any

from agent_core import RunContext

DEFAULT_CONTEXT_WINDOW = 128000
TOOL_COMPACT_AT = 0.85
TOOL_COMPACT_TARGET = 0.60
TOOL_RESULT_LIMIT = 900


def context_window() -> int:
    try:
        return max(1000, int(os.getenv("FRIDAY_CONTEXT_WINDOW", DEFAULT_CONTEXT_WINDOW)))
    except ValueError:
        return DEFAULT_CONTEXT_WINDOW


def token_estimate(context: RunContext, tools: list[Any] | None = None) -> int:
    # ponytail: rough token budget; replace with provider usage if runtime exposes it.
    return _tokens(len(_context_text(context)) + len(_tool_schema_text(tools)))


def context_ratio(context: RunContext, tools: list[Any] | None = None) -> float:
    return token_estimate(context, tools) / context_window()


def context_report(context: RunContext, tools: list[Any] | None = None) -> str:
    sections = _sections(_system_text(context))
    skill = sections.get("Skill Catalog", "")
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
        ("skill catalog", skill),
        ("tool schemas", tool_schema),
        ("messages", ordinary),
        ("tool results", tool_results),
    ]
    total_chars = sum(len(value) for _, value in rows)
    total_tokens = _tokens(total_chars)
    lines = [
        "# Context",
        f"- window: {context_window()} tokens",
        f"- current: ~{total_tokens} tokens / {total_chars} chars / {total_tokens / context_window():.1%}",
    ]
    usage = context.metadata.get("friday.last_usage")
    if isinstance(usage, dict):
        lines.append(f"- last provider usage: input {usage.get('input_tokens', 'n/a')} / output {usage.get('output_tokens', 'n/a')}")
    lines.append("")
    lines.append("| Part | Est. tokens | Exact chars |")
    lines.append("| --- | ---: | ---: |")
    for name, value in rows:
        lines.append(f"| {name} | ~{_tokens(len(value))} | {len(value)} |")
    return "\n".join(lines)


def should_compact_tools(context: RunContext, tools: list[Any] | None = None) -> bool:
    return context_ratio(context, tools) >= TOOL_COMPACT_AT and not context.metadata.get("friday.compact_next_at_85")


def should_compact_conversation(context: RunContext, tools: list[Any] | None = None) -> bool:
    return context_ratio(context, tools) >= TOOL_COMPACT_AT and bool(context.metadata.get("friday.compact_next_at_85"))


def compact_tool_results(context: RunContext, tools: list[Any] | None = None) -> int:
    calls = _tool_calls(context)
    count = 0
    for message in context.get_messages():
        if message.get("role") != "tool" or message.get("friday_compacted"):
            continue
        content = str(message.get("content", ""))
        if len(content) <= TOOL_RESULT_LIMIT:
            continue
        call = calls.get(str(message.get("tool_call_id", "")), {})
        message["content"] = _tool_summary(
            str(call.get("name") or "tool"),
            call.get("arguments", {}),
            content,
        )
        message["friday_compacted"] = True
        count += 1
    if count and context_ratio(context, tools) < TOOL_COMPACT_TARGET:
        context.metadata.pop("friday.compact_next_at_85", None)
    elif count:
        context.metadata["friday.compact_next_at_85"] = True
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


def _tool_calls(context: RunContext) -> dict[str, dict[str, Any]]:
    calls = {}
    for event in context.events:
        if event.type == "tool.call":
            tool_call_id = str(event.data.get("tool_call_id", ""))
            if tool_call_id:
                calls[tool_call_id] = dict(event.data)
    return calls


def _tool_summary(name: str, arguments: Any, content: str) -> str:
    parsed = _json(content)
    if isinstance(parsed, dict):
        result = _dict_summary(parsed)
    else:
        result = _clip(content)
    return f"[tool result compacted]\nTool: {name}\nArgs: {_clip(json.dumps(arguments, ensure_ascii=False))}\nResult: {result}"


def _dict_summary(value: dict[str, Any]) -> str:
    parts = []
    for key in ("exit_code", "timed_out", "count", "path", "mode", "chars", "lines", "total_lines", "start_line", "end_line"):
        if key in value:
            parts.append(f"{key}={value[key]}")
    if "output" in value:
        parts.append("output=" + _clip(str(value["output"])))
    elif "matches" in value:
        parts.append("matches=" + _clip(json.dumps(value["matches"][:5], ensure_ascii=False)))
    elif "paths" in value:
        parts.append("paths=" + _clip(json.dumps(value["paths"][:10], ensure_ascii=False)))
    elif "content" in value:
        parts.append("content=" + _clip(str(value["content"])))
    return "; ".join(parts) or _clip(json.dumps(value, ensure_ascii=False))


def _json(value: str) -> Any:
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return None


def _clip(value: str, limit: int = 500) -> str:
    value = " ".join(value.split())
    return value if len(value) <= limit else value[: limit - 3] + "..."
