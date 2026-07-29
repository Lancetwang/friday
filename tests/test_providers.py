from __future__ import annotations

import unittest
from types import SimpleNamespace

from friday.providers import _anthropic_messages, _anthropic_response


class AnthropicProviderTests(unittest.TestCase):
    def test_openai_tool_messages_become_one_anthropic_result_turn(self) -> None:
        system, messages = _anthropic_messages(
            [
                {"role": "system", "content": "Friday rules"},
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {"id": "one", "function": {"name": "Read", "arguments": '{"path":"a"}'}},
                        {"id": "two", "function": {"name": "Read", "arguments": '{"path":"b"}'}},
                    ],
                },
                {"role": "tool", "tool_call_id": "one", "content": "A"},
                {"role": "tool", "tool_call_id": "two", "content": "B"},
            ]
        )

        self.assertEqual(system, "Friday rules")
        self.assertEqual([item["type"] for item in messages[-1]["content"]], ["tool_result", "tool_result"])

    def test_anthropic_response_is_normalized_for_agent_core(self) -> None:
        response = SimpleNamespace(
            content=[
                SimpleNamespace(type="text", text="done"),
                SimpleNamespace(type="tool_use", id="tool-1", name="Read", input={"path": "README.md"}),
            ],
            usage=SimpleNamespace(input_tokens=12, output_tokens=4),
        )

        normalized = _anthropic_response(response)

        self.assertEqual(normalized["content"], "done")
        self.assertEqual(normalized["tool_calls"][0]["function"]["name"], "Read")
        self.assertEqual(normalized["usage"], {"input_tokens": 12, "output_tokens": 4})


if __name__ == "__main__":
    unittest.main()
