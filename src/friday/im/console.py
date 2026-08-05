from __future__ import annotations

import threading
from pathlib import Path

from friday.config import IM_BRIDGE_ENV_NAMES
from friday.im.bridge import FridayBridge
from friday.im.gateway_client import GatewayClient

BANNER = """Friday IM bridge, console mode. Nothing connects to Feishu.
This exercises the whole path except the Feishu SDK: sessions, approvals,
commands, and progress notices. Replies interleave with the prompt because
each message runs on its own thread, exactly as it does over Feishu.

Type a message, /help for commands, or Ctrl+C to exit."""


def run_console_bridge(workspace: Path) -> None:
    closing = threading.Event()

    def reply(_chat: str, text: str) -> None:
        # Shutting the gateway down fails whatever turn is still waiting; that
        # is the exit itself, not something worth printing.
        if not closing.is_set():
            print(f"\nfriday> {text}")

    client = GatewayClient(workspace, withhold_env=IM_BRIDGE_ENV_NAMES)
    bridge = FridayBridge(client, reply, workspace=workspace)
    client.on_event = bridge.on_event
    print(BANNER)
    print(f"\nWorkspace: {workspace}")
    try:
        client.start()
        while True:
            try:
                text = input("\nyou> ").strip()
            except EOFError:
                break
            if not text:
                continue
            threading.Thread(
                target=bridge.handle,
                args=("console", text),
                name="friday-im-turn",
                daemon=True,
            ).start()
    except KeyboardInterrupt:
        pass
    finally:
        closing.set()
        client.close()
