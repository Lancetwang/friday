"""Feishu card rendering: markdown replies, live streaming, and reactions.

Feishu renders markdown only inside interactive cards, and only a card entity
can be revised after it is sent. Streaming therefore costs three calls (create,
send, finish) against one for a plain card, so a turn that never streams any
text falls back to the cheap path.

The lark SDK is imported inside functions so that `friday feishu` can still
report a missing dependency itself, and so these helpers stay unit-testable.
"""

from __future__ import annotations

import json
import threading
from itertools import count
from typing import Any, Callable

ANSWER_ELEMENT = "answer"
STATUS_ELEMENT = "status"
# Feishu accepts far more, but a runaway answer should not become a wall of card.
MAX_CARD_CHARS = 60000
PUSH_INTERVAL_SECONDS = 0.45
BLANK = " "

RECEIVED_EMOJI = "OnIt"
DONE_EMOJI = "DONE"
FAILED_EMOJI = "CrossMark"


def markdown_card(body: str) -> str:
    """A one-shot card whose only job is to render markdown."""
    return json.dumps(
        {
            "schema": "2.0",
            "config": {"update_multi": True},
            "body": {"elements": [{"tag": "markdown", "content": _fit(body)}]},
        },
        ensure_ascii=False,
    )


def streaming_card() -> str:
    """A card entity that starts empty and is filled in as Friday writes.

    Answer and status live in separate elements on purpose: the typewriter
    effect only runs when the new text extends the old one, which a changing
    status line appended to the answer would break on every tool call.
    """
    return json.dumps(
        {
            "schema": "2.0",
            "config": {
                "update_multi": True,
                "streaming_mode": True,
                "streaming_config": {
                    "print_frequency_ms": {"default": 30},
                    "print_step": {"default": 2},
                    "print_strategy": "fast",
                },
            },
            "body": {
                "elements": [
                    {"tag": "markdown", "content": BLANK, "element_id": ANSWER_ELEMENT},
                    {"tag": "markdown", "content": BLANK, "element_id": STATUS_ELEMENT},
                ]
            },
        },
        ensure_ascii=False,
    )


def send_markdown(lark_client: Any, chat_id: str, body: str) -> str:
    """Send one rendered card. Returns the message id, or "" on failure."""
    from lark_oapi.api.im.v1 import CreateMessageRequest, CreateMessageRequestBody

    request = (
        CreateMessageRequest.builder()
        .receive_id_type("chat_id")
        .request_body(
            CreateMessageRequestBody.builder()
            .receive_id(chat_id)
            .msg_type("interactive")
            .content(markdown_card(body))
            .build()
        )
        .build()
    )
    response = lark_client.im.v1.message.create(request)
    if not response.success():
        return ""
    return str(getattr(response.data, "message_id", "") or "")


def react(lark_client: Any, message_id: str, emoji: str) -> bool:
    """Mark a user's message with an emoji, as a lighter progress signal."""
    if not message_id:
        return False
    from lark_oapi.api.im.v1 import CreateMessageReactionRequest, CreateMessageReactionRequestBody, Emoji

    request = (
        CreateMessageReactionRequest.builder()
        .message_id(message_id)
        .request_body(
            CreateMessageReactionRequestBody.builder()
            .reaction_type(Emoji.builder().emoji_type(emoji).build())
            .build()
        )
        .build()
    )
    return bool(lark_client.im.v1.message_reaction.create(request).success())


class FeishuStream:
    """A card that Friday keeps rewriting until the turn ends.

    `push` and `status` are called from the gateway's reader thread, so they
    only record intent; a private thread does the network work at a fixed
    interval. If any card call fails the stream gives up and the final answer
    is delivered as a plain card, so a rendering problem never costs the reply.
    """

    def __init__(
        self,
        lark_client: Any,
        chat_id: str,
        *,
        interval: float = PUSH_INTERVAL_SECONDS,
        log: Callable[[str], None] = print,
    ) -> None:
        self._lark = lark_client
        self._chat_id = chat_id
        self._interval = interval
        self._log = log
        self._card_id = ""
        self._sequence = count(1)
        self._body = ""
        self._status = ""
        self._sent_body = ""
        self._sent_status = ""
        self._broken = False
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._done = threading.Event()
        self._pump = threading.Thread(target=self._loop, name="friday-im-card", daemon=True)
        self._pump.start()

    def push(self, body: str) -> None:
        with self._lock:
            self._body = body
        self._wake.set()

    def status(self, note: str) -> None:
        with self._lock:
            self._status = note
        self._wake.set()

    def close(self, body: str) -> None:
        with self._lock:
            self._body = body or self._body
            self._status = ""
        self._done.set()
        self._wake.set()
        # Bounded so a wedged card API cannot hold the turn open forever.
        self._pump.join(timeout=self._interval * 8 + 5)

    def _loop(self) -> None:
        while True:
            self._wake.wait(self._interval)
            self._wake.clear()
            # Checked after waking so that a turn which finishes inside one
            # interval never pays for a card entity it will not update.
            if self._done.is_set():
                break
            self._flush(create=True)
        self._flush(create=False)
        self._finish()

    def _flush(self, *, create: bool) -> None:
        if self._broken:
            return
        with self._lock:
            body, status = _fit(self._body), self._status
        if not body and not status:
            return
        if not self._card_id and not (create and self._open()):
            return
        if body and body != self._sent_body:
            if not self._write(ANSWER_ELEMENT, body):
                return
            self._sent_body = body
        if status != self._sent_status:
            if not self._write(STATUS_ELEMENT, status or BLANK):
                return
            self._sent_status = status

    def _finish(self) -> None:
        with self._lock:
            body = _fit(self._body)
        if self._card_id and not self._broken:
            self._settle()
            return
        # Never streamed, or streaming broke: one plain card still delivers it.
        if body and not send_markdown(self._lark, self._chat_id, body):
            self._log("Feishu send failed for the final answer.")

    def _open(self) -> bool:
        from lark_oapi.api.cardkit.v1 import CreateCardRequest, CreateCardRequestBody

        request = (
            CreateCardRequest.builder()
            .request_body(CreateCardRequestBody.builder().type("card_json").data(streaming_card()).build())
            .build()
        )
        response = self._lark.cardkit.v1.card.create(request)
        if not response.success():
            return self._give_up(f"card create failed: {response.code} {response.msg}")
        card_id = str(getattr(response.data, "card_id", "") or "")
        if not card_id:
            return self._give_up("card create returned no card_id")
        if not self._send(card_id):
            return False
        self._card_id = card_id
        return True

    def _send(self, card_id: str) -> bool:
        from lark_oapi.api.im.v1 import CreateMessageRequest, CreateMessageRequestBody

        content = json.dumps({"type": "card", "data": {"card_id": card_id}}, ensure_ascii=False)
        request = (
            CreateMessageRequest.builder()
            .receive_id_type("chat_id")
            .request_body(
                CreateMessageRequestBody.builder()
                .receive_id(self._chat_id)
                .msg_type("interactive")
                .content(content)
                .build()
            )
            .build()
        )
        response = self._lark.im.v1.message.create(request)
        if not response.success():
            return self._give_up(f"card send failed: {response.code} {response.msg}")
        return True

    def _write(self, element_id: str, content: str) -> bool:
        from lark_oapi.api.cardkit.v1 import ContentCardElementRequest, ContentCardElementRequestBody

        request = (
            ContentCardElementRequest.builder()
            .card_id(self._card_id)
            .element_id(element_id)
            .request_body(
                ContentCardElementRequestBody.builder()
                .content(content)
                .sequence(next(self._sequence))
                .build()
            )
            .build()
        )
        response = self._lark.cardkit.v1.card_element.content(request)
        if not response.success():
            return self._give_up(f"card update failed: {response.code} {response.msg}")
        return True

    def _settle(self) -> None:
        from lark_oapi.api.cardkit.v1 import SettingsCardRequest, SettingsCardRequestBody

        settings = json.dumps({"config": {"streaming_mode": False}}, ensure_ascii=False)
        request = (
            SettingsCardRequest.builder()
            .card_id(self._card_id)
            .request_body(
                SettingsCardRequestBody.builder().settings(settings).sequence(next(self._sequence)).build()
            )
            .build()
        )
        response = self._lark.cardkit.v1.card.settings(request)
        if not response.success():
            self._log(f"Feishu could not leave streaming mode: {response.code} {response.msg}")

    def _give_up(self, reason: str) -> bool:
        self._broken = True
        self._log(f"Feishu card streaming off: {reason}")
        return False


def _fit(body: str) -> str:
    text = body.strip()
    if len(text) <= MAX_CARD_CHARS:
        return text
    return text[:MAX_CARD_CHARS] + "\n\n_...truncated._"
