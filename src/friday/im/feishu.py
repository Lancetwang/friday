from __future__ import annotations

import json
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from friday.child import frozen
from friday.config import IM_BRIDGE_ENV_NAMES, feishu_credentials
from friday.im.bridge import FridayBridge, Stream
from friday.im.feishu_card import (
    DONE_EMOJI,
    FAILED_EMOJI,
    MAX_CARD_CHARS,
    RECEIVED_EMOJI,
    FeishuStream,
    react,
    send_markdown,
)
from friday.im.gateway_client import GatewayClient

# Feishu drops the long-connection frame unless the handler returns quickly, so
# every message is acknowledged immediately and answered from a worker thread.
ACK_BUDGET_SECONDS = 3
SEEN_MESSAGE_LIMIT = 512
TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal"
TOKEN_TIMEOUT_SECONDS = 10

# A packaged Friday has no pip to run, so telling its user to run one would send
# them somewhere they cannot go.
INSTALL_HINT = "The Feishu bridge needs the lark-oapi SDK: pip install 'friday-agent[feishu]'"
PACKAGED_HINT = (
    "This build of Friday does not include the Feishu SDK, so the phone bridge "
    "cannot start. Run it from a source install instead: see docs/im-feishu.md."
)


@dataclass(frozen=True)
class FeishuConfig:
    app_id: str
    app_secret: str
    allowed_users: frozenset[str]
    workspace: Path
    allow_group: bool = False

    @property
    def pairing(self) -> bool:
        """No allowed sender yet, so the bridge only reports the open_ids it sees.

        An empty allow-list refuses every message because no sender can be a
        member of it, which is what makes it safe to start unconfigured: the
        first message reveals the open_id to whitelist without running anything.
        """
        return not self.allowed_users

    @classmethod
    def from_env(cls, workspace: Path) -> FeishuConfig:
        """Settings saved from the UI, overridable by the environment.

        The stored file is what the settings screen writes; process environment
        variables still win so a terminal can point one run at a
        different app without touching saved state.
        """
        workspace = workspace.resolve()
        stored = feishu_credentials()
        app_id = (os.getenv("FRIDAY_FEISHU_APP_ID") or stored["app_id"]).strip()
        app_secret = (os.getenv("FRIDAY_FEISHU_APP_SECRET") or stored["app_secret"]).strip()
        listed = os.getenv("FRIDAY_FEISHU_ALLOWED_USERS")
        allowed = frozenset(
            item.strip() for item in listed.split(",") if item.strip()
        ) if listed is not None else frozenset(stored["allowed_users"])
        group_flag = os.getenv("FRIDAY_FEISHU_ALLOW_GROUP")
        allow_group = (
            group_flag.strip().lower() in {"1", "true", "yes"} if group_flag is not None else stored["allow_group"]
        )
        missing = [
            name
            for name, value in (
                ("app id", app_id),
                ("app secret", app_secret),
            )
            if not value
        ]
        if missing:
            raise SystemExit(
                "The Feishu bridge needs an " + " and an ".join(missing) + ". Set it in Friday settings."
            )
        return cls(
            app_id=app_id,
            app_secret=app_secret,
            allowed_users=allowed,
            workspace=workspace,
            allow_group=allow_group,
        )


class FeishuBridge:
    """Connects one Friday workspace to Feishu over a WebSocket long connection."""

    def __init__(self, config: FeishuConfig) -> None:
        self.config = config
        self._seen: dict[str, None] = {}
        self._unknown: set[str] = set()
        self._seen_lock = threading.Lock()
        self._client = GatewayClient(config.workspace, withhold_env=IM_BRIDGE_ENV_NAMES)
        self._bridge = FridayBridge(
            self._client,
            self._reply,
            workspace=config.workspace,
            open_stream=self._open_stream,
        )
        self._client.on_event = self._bridge.on_event
        self._lark: Any = None

    def run(self) -> None:
        lark = _import_lark()
        # The long connection retries bad credentials forever, which would leave the
        # desktop switch claiming the phone is reachable when it never will be. One
        # token request settles that before anything else starts.
        refused = credential_problem(self.config)
        if refused:
            raise SystemExit(f"Feishu refused these credentials: {refused}")
        self._lark = lark.Client.builder().app_id(self.config.app_id).app_secret(self.config.app_secret).build()
        handler = (
            lark.EventDispatcherHandler.builder("", "")
            .register_p2_im_message_receive_v1(self._on_message)
            .build()
        )
        socket = lark.ws.Client(
            self.config.app_id,
            self.config.app_secret,
            event_handler=handler,
            log_level=lark.LogLevel.INFO,
        )
        print(f"Friday Feishu bridge on {self.config.workspace}")
        if self.config.pairing:
            print(
                "No account is allowed yet, so every message is refused.\n"
                "Send the bot one direct message, then add the open_id printed below to\n"
                "the allowed accounts in Friday settings and switch the bridge off and on."
            )
        else:
            print(
                f"Allowed open_ids: {len(self.config.allowed_users)}; "
                f"group chats: {'on' if self.config.allow_group else 'off'}"
            )
        try:
            self._client.start()
            socket.start()
        finally:
            self._client.close()

    def _on_message(self, data: Any) -> None:
        target = self._target(data)
        if target is None:
            return
        # Return inside the ack budget; the turn itself runs for minutes.
        threading.Thread(
            target=self._run_turn,
            args=target,
            name="friday-im-turn",
            daemon=True,
        ).start()

    def _run_turn(self, chat_id: str, text: str, message_id: str) -> None:
        """Run one turn, bracketing it with reactions on the user's message."""
        react(self._lark, message_id, RECEIVED_EMOJI)
        try:
            self._bridge.handle(chat_id, text)
        except Exception:
            react(self._lark, message_id, FAILED_EMOJI)
            raise
        react(self._lark, message_id, DONE_EMOJI)

    def _open_stream(self, chat_id: str) -> Stream | None:
        if self._lark is None:
            return None
        return FeishuStream(self._lark, chat_id)

    def _target(self, data: Any) -> tuple[str, str, str] | None:
        """Decide whether one Feishu event may drive this workspace."""
        try:
            event = data.event
            message = event.message
            chat_id = str(getattr(message, "chat_id", "") or "")
            message_id = str(getattr(message, "message_id", "") or "")
            sender = str(getattr(getattr(event.sender, "sender_id", None), "open_id", "") or "")
        except AttributeError:
            return None
        if not chat_id:
            return None
        if sender not in self.config.allowed_users:
            self._report_unknown(sender)
            return None
        mentions = list(getattr(message, "mentions", None) or [])
        is_group = str(getattr(message, "chat_type", "") or "") == "group"
        if is_group and (not self.config.allow_group or not mentions):
            return None
        if self._duplicate(message_id):
            return None
        text = _strip_mentions(_message_text(message), mentions)
        return (chat_id, text, message_id) if text else None

    def _report_unknown(self, sender: str) -> None:
        """Name the rejected open_id once, so a first-time setup can find its own."""
        with self._seen_lock:
            if not sender or sender in self._unknown:
                return
            self._unknown.add(sender)
        print(f"Refused a message from open_id {sender}: add it to the allowed accounts to let it in.")

    def _duplicate(self, message_id: str) -> bool:
        if not message_id:
            return False
        with self._seen_lock:
            if message_id in self._seen:
                return True
            self._seen[message_id] = None
            for stale in list(self._seen)[:-SEEN_MESSAGE_LIMIT]:
                del self._seen[stale]
        return False

    def _reply(self, chat_id: str, text: str) -> None:
        if self._lark is None:
            return
        for chunk in _chunks(text):
            if not send_markdown(self._lark, chat_id, chunk):
                print("Feishu send failed.")
                return


def run_feishu_bridge(workspace: Path) -> None:
    FeishuBridge(FeishuConfig.from_env(workspace)).run()


def credential_problem(config: FeishuConfig) -> str:
    """Why Feishu rejects this app, or empty when it accepts it.

    Only the app id and secret are involved, so no permission scope can turn a
    working app into a reported failure. An unreachable network says nothing about
    the credentials, so it is not treated as a rejection.
    """
    import urllib.error
    import urllib.request

    body = json.dumps({"app_id": config.app_id, "app_secret": config.app_secret}).encode("utf-8")
    request = urllib.request.Request(
        TOKEN_URL,
        data=body,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=TOKEN_TIMEOUT_SECONDS) as response:
            answer = json.loads(response.read().decode("utf-8"))
    except (OSError, urllib.error.URLError, json.JSONDecodeError, ValueError):
        return ""
    if not isinstance(answer, dict) or answer.get("code") == 0:
        return ""
    return str(answer.get("msg") or f"error code {answer.get('code')}")


def _import_lark() -> Any:
    try:
        import lark_oapi
    except ModuleNotFoundError as exc:
        raise SystemExit(PACKAGED_HINT if frozen() else INSTALL_HINT) from exc
    return lark_oapi


def _message_text(message: Any) -> str:
    if str(getattr(message, "message_type", "") or "") != "text":
        return ""
    try:
        content = json.loads(str(getattr(message, "content", "") or "{}"))
    except json.JSONDecodeError:
        return ""
    return str(content.get("text") or "") if isinstance(content, dict) else ""


def _strip_mentions(text: str, mentions: list[Any]) -> str:
    for mention in mentions:
        key = str(getattr(mention, "key", "") or "")
        if key:
            text = text.replace(key, " ")
    return " ".join(text.split())


def _chunks(text: str) -> list[str]:
    body = text.strip()
    if not body:
        return []
    return [body[start : start + MAX_CARD_CHARS] for start in range(0, len(body), MAX_CARD_CHARS)]
