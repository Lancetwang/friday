from __future__ import annotations

import json
from collections.abc import Callable, Mapping, Sequence
from typing import Any

from anthropic import Anthropic


class AnthropicModel:
    """Anthropic Messages adapter for agent-core's OpenAI-shaped ChatModel boundary."""

    def __init__(
        self,
        *,
        api_key: str | None,
        base_url: str | None,
        model: str,
        client: Anthropic | None = None,
    ) -> None:
        if client is None and not api_key:
            raise RuntimeError("Configure an API key for this Anthropic model.")
        self.model = model
        self.client = client or Anthropic(api_key=api_key, base_url=base_url)

    def chat_message(
        self,
        messages: Sequence[Mapping[str, Any]],
        *,
        tools: Sequence[Mapping[str, Any]] | None = None,
        tool_choice: str | Mapping[str, Any] | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        on_delta = kwargs.pop("on_delta", None)
        stream = bool(kwargs.pop("stream", False))
        system, converted = _anthropic_messages(messages)
        request: dict[str, Any] = {
            "model": self.model,
            "messages": converted,
            "max_tokens": int(kwargs.pop("max_tokens", kwargs.pop("max_completion_tokens", 4096))),
            **kwargs,
        }
        if system:
            request["system"] = system
        if tools:
            request["tools"] = [_anthropic_tool(tool) for tool in tools]
        if tool_choice is not None:
            request["tool_choice"] = _anthropic_tool_choice(tool_choice)
        if stream:
            with self.client.messages.stream(**request) as response:
                for text in response.text_stream:
                    if on_delta:
                        on_delta(text)
                return _anthropic_response(response.get_final_message())
        return _anthropic_response(self.client.messages.create(**request))


def _anthropic_messages(messages: Sequence[Mapping[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
    system: list[str] = []
    converted: list[dict[str, Any]] = []
    pending_results: list[dict[str, Any]] = []

    def flush_results() -> None:
        if pending_results:
            converted.append({"role": "user", "content": list(pending_results)})
            pending_results.clear()

    for message in messages:
        role = str(message.get("role") or "")
        if role == "system":
            system.append(_text_content(message.get("content")))
            continue
        if role == "tool":
            pending_results.append(
                {
                    "type": "tool_result",
                    "tool_use_id": str(message.get("tool_call_id") or ""),
                    "content": _text_content(message.get("content")),
                }
            )
            continue
        flush_results()
        if role == "assistant":
            blocks: list[dict[str, Any]] = []
            text = _text_content(message.get("content"))
            if text:
                blocks.append({"type": "text", "text": text})
            for call in message.get("tool_calls") or []:
                function = call.get("function", {}) if isinstance(call, Mapping) else {}
                arguments = function.get("arguments", "{}")
                if isinstance(arguments, str):
                    try:
                        arguments = json.loads(arguments)
                    except json.JSONDecodeError:
                        arguments = {"raw": arguments}
                blocks.append(
                    {
                        "type": "tool_use",
                        "id": str(call.get("id") or ""),
                        "name": str(function.get("name") or ""),
                        "input": arguments,
                    }
                )
            converted.append({"role": "assistant", "content": blocks or [{"type": "text", "text": ""}]})
        elif role == "user":
            converted.append({"role": "user", "content": _anthropic_content(message.get("content"))})
    flush_results()
    return "\n\n".join(filter(None, system)), converted


def _anthropic_content(content: Any) -> Any:
    if not isinstance(content, list):
        return _text_content(content)
    blocks: list[dict[str, Any]] = []
    for part in content:
        if not isinstance(part, Mapping):
            continue
        if part.get("type") == "text":
            blocks.append({"type": "text", "text": str(part.get("text") or "")})
        elif part.get("type") == "image_url":
            url = str((part.get("image_url") or {}).get("url") or "")
            if url.startswith("data:") and ";base64," in url:
                header, data = url.split(",", 1)
                blocks.append(
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": header[5:].split(";", 1)[0],
                            "data": data,
                        },
                    }
                )
            elif url:
                blocks.append({"type": "image", "source": {"type": "url", "url": url}})
    return blocks


def _anthropic_tool(tool: Mapping[str, Any]) -> dict[str, Any]:
    function = tool.get("function", {})
    return {
        "name": function.get("name"),
        "description": function.get("description", ""),
        "input_schema": function.get("parameters", {"type": "object", "properties": {}}),
    }


def _anthropic_tool_choice(value: str | Mapping[str, Any]) -> dict[str, Any]:
    if isinstance(value, str):
        return {"type": {"required": "any"}.get(value, value)}
    function = value.get("function", {})
    return {"type": "tool", "name": function.get("name")} if function else dict(value)


def _anthropic_response(message: Any) -> dict[str, Any]:
    text: list[str] = []
    tool_calls: list[dict[str, Any]] = []
    for block in message.content:
        if block.type == "text":
            text.append(block.text)
        elif block.type == "tool_use":
            tool_calls.append(
                {
                    "id": block.id,
                    "type": "function",
                    "function": {"name": block.name, "arguments": json.dumps(block.input, ensure_ascii=False)},
                }
            )
    usage = {
        "input_tokens": message.usage.input_tokens,
        "output_tokens": message.usage.output_tokens,
    }
    for name in ("cache_creation_input_tokens", "cache_read_input_tokens"):
        value = getattr(message.usage, name, None)
        if value is not None:
            usage[name] = value
    result: dict[str, Any] = {"role": "assistant", "content": "".join(text), "usage": usage}
    if tool_calls:
        result["tool_calls"] = tool_calls
    return result


def _text_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            str(part.get("text") or "")
            for part in content
            if isinstance(part, Mapping) and part.get("type") == "text"
        )
    return str(content or "")
