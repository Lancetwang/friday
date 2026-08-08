from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import Any

from anthropic import Anthropic


class ResponsesModel:
    """OpenAI Responses adapter for agent-core's chat-model boundary."""

    def __init__(
        self,
        *,
        api_key: str | None,
        base_url: str | None,
        model: str,
        client: Any = None,
    ) -> None:
        if client is None and not api_key:
            raise RuntimeError("Configure an API key for this Responses model.")
        if client is None:
            from openai import OpenAI

            client = OpenAI(api_key=api_key, base_url=base_url)
        self.model = model
        self.client = client

    def chat_message(
        self,
        messages: Sequence[Mapping[str, Any]],
        *,
        tools: Sequence[Mapping[str, Any]] | None = None,
        tool_choice: str | Mapping[str, Any] | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        on_delta = kwargs.pop("on_delta", None)
        on_reasoning_delta = kwargs.pop("on_reasoning_delta", None)
        stream = bool(kwargs.pop("stream", False))
        instructions, inputs = _responses_input(messages)
        request: dict[str, Any] = {"model": self.model, "input": inputs, **kwargs}
        if instructions:
            request["instructions"] = instructions
        if tools:
            request["tools"] = [_responses_tool(tool) for tool in tools]
        if tool_choice is not None:
            request["tool_choice"] = _responses_tool_choice(tool_choice)
        if not stream:
            return _responses_response(self.client.responses.create(**request))

        final = None
        events = self.client.responses.create(**request, stream=True)
        for event in events:
            event_type = _get(event, "type", "")
            if event_type == "response.output_text.delta" and on_delta:
                on_delta(str(_get(event, "delta", "")))
            elif event_type in {"response.reasoning_text.delta", "response.reasoning_summary_text.delta"}:
                if on_reasoning_delta:
                    on_reasoning_delta(str(_get(event, "delta", "")))
            elif event_type == "response.completed":
                final = _get(event, "response")
        if final is None and hasattr(events, "get_final_response"):
            final = events.get_final_response()
        if final is None:
            raise RuntimeError("Responses stream ended without a completed response.")
        return _responses_response(final)


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
        on_reasoning_delta = kwargs.pop("on_reasoning_delta", None)
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
                for event in response:
                    if _get(event, "type") != "content_block_delta":
                        continue
                    delta = _get(event, "delta")
                    if _get(delta, "type") == "text_delta" and on_delta:
                        on_delta(str(_get(delta, "text", "")))
                    elif _get(delta, "type") == "thinking_delta" and on_reasoning_delta:
                        on_reasoning_delta(str(_get(delta, "thinking", "")))
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
            reasoning = message.get("reasoning_content")
            if isinstance(reasoning, list):
                blocks.extend(dict(block) for block in reasoning if isinstance(block, Mapping))
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
    reasoning: list[dict[str, Any]] = []
    tool_calls: list[dict[str, Any]] = []
    for block in message.content:
        if block.type == "text":
            text.append(block.text)
        elif block.type in {"thinking", "redacted_thinking"}:
            reasoning.append(_object_dict(block))
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
    if reasoning:
        result["reasoning_content"] = reasoning
    if tool_calls:
        result["tool_calls"] = tool_calls
    return result


def _responses_input(messages: Sequence[Mapping[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
    system: list[str] = []
    inputs: list[dict[str, Any]] = []
    for message in messages:
        role = str(message.get("role") or "")
        if role == "system":
            system.append(_text_content(message.get("content")))
            continue
        if role == "tool":
            inputs.append(
                {
                    "type": "function_call_output",
                    "call_id": str(message.get("tool_call_id") or ""),
                    "output": _text_content(message.get("content")),
                }
            )
            continue
        if role not in {"user", "assistant"}:
            continue
        reasoning = message.get("reasoning_content")
        if role == "assistant" and isinstance(reasoning, list):
            inputs.extend(dict(item) for item in reasoning if isinstance(item, Mapping))
        content = _responses_content(message.get("content"))
        if content:
            inputs.append({"role": role, "content": content})
        if role == "assistant":
            for call in message.get("tool_calls") or []:
                function = call.get("function", {}) if isinstance(call, Mapping) else {}
                inputs.append(
                    {
                        "type": "function_call",
                        "call_id": str(call.get("id") or ""),
                        "name": str(function.get("name") or ""),
                        "arguments": str(function.get("arguments") or "{}"),
                    }
                )
    return "\n\n".join(filter(None, system)), inputs


def _responses_content(content: Any) -> Any:
    if not isinstance(content, list):
        return _text_content(content)
    parts: list[dict[str, Any]] = []
    for part in content:
        if not isinstance(part, Mapping):
            continue
        if part.get("type") == "text":
            parts.append({"type": "input_text", "text": str(part.get("text") or "")})
        elif part.get("type") == "image_url":
            url = str((part.get("image_url") or {}).get("url") or "")
            if url:
                parts.append({"type": "input_image", "image_url": url})
    return parts


def _responses_tool(tool: Mapping[str, Any]) -> dict[str, Any]:
    function = tool.get("function", {})
    result = {
        "type": "function",
        "name": function.get("name"),
        "description": function.get("description", ""),
        "parameters": function.get("parameters", {"type": "object", "properties": {}}),
    }
    if "strict" in function:
        result["strict"] = function["strict"]
    return result


def _responses_tool_choice(value: str | Mapping[str, Any]) -> Any:
    if isinstance(value, str):
        return value
    function = value.get("function", {})
    return {"type": "function", "name": function.get("name")} if function else dict(value)


def _responses_response(response: Any) -> dict[str, Any]:
    text: list[str] = []
    reasoning: list[dict[str, Any]] = []
    tool_calls: list[dict[str, Any]] = []
    for item in _get(response, "output", []) or []:
        item_type = _get(item, "type")
        if item_type == "message":
            for block in _get(item, "content", []) or []:
                if _get(block, "type") == "output_text":
                    text.append(str(_get(block, "text", "")))
        elif item_type == "reasoning":
            reasoning.append(_object_dict(item))
        elif item_type == "function_call":
            tool_calls.append(
                {
                    "id": str(_get(item, "call_id") or _get(item, "id") or ""),
                    "type": "function",
                    "function": {
                        "name": str(_get(item, "name", "")),
                        "arguments": str(_get(item, "arguments", "{}")),
                    },
                }
            )
    result: dict[str, Any] = {"role": "assistant", "content": "".join(text)}
    if reasoning:
        result["reasoning_content"] = reasoning
    if tool_calls:
        result["tool_calls"] = tool_calls
    if usage := _get(response, "usage"):
        result["usage"] = _object_dict(usage)
    return result


def _object_dict(value: Any) -> dict[str, Any]:
    if hasattr(value, "model_dump"):
        return value.model_dump(exclude_none=True)
    if isinstance(value, Mapping):
        return dict(value)
    return {key: item for key, item in vars(value).items() if item is not None}


def _get(value: Any, name: str, default: Any = None) -> Any:
    if isinstance(value, Mapping):
        return value.get(name, default)
    return getattr(value, name, default)


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
