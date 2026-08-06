from __future__ import annotations

import os
import subprocess
import sys
import unittest
from pathlib import Path
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


class ProviderImportCostTests(unittest.TestCase):
    def test_starting_the_gateway_does_not_import_the_anthropic_sdk(self) -> None:
        """The desktop runs one backend per open project, so imports cost per project.

        The Anthropic SDK is ~1400 modules and ~18 MB of resident memory on top of
        what Friday already loads, and users on other providers never call it. A
        subprocess is required because this test process has imported it above.
        """
        source = (
            "import friday.app_server, sys;"
            "print(any(name.startswith('anthropic') for name in sys.modules))"
        )
        result = subprocess.run(
            [sys.executable, "-c", source],
            capture_output=True,
            text=True,
            env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src")},
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "False", "friday.app_server now imports the Anthropic SDK eagerly")


if __name__ == "__main__":
    unittest.main()
