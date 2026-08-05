from __future__ import annotations

import json
import os
import tempfile
import threading
import time
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable
from unittest.mock import MagicMock, patch

from friday.config import (
    FEISHU_FILE,
    IM_BRIDGE_ENV_NAMES,
    feishu_credentials,
    save_feishu_settings,
)
from friday.im.bridge import FridayBridge
from friday.im.feishu import (
    FeishuBridge,
    FeishuConfig,
    _chunks,
    _message_text,
    _strip_mentions,
    credential_problem,
)
from friday.im.feishu_card import (
    ANSWER_ELEMENT,
    MAX_CARD_CHARS,
    STATUS_ELEMENT,
    FeishuStream,
    markdown_card,
    streaming_card,
)
from friday.im.gateway_client import GatewayClient, GatewayError
from friday.im.supervisor import BridgeSupervisor

FEISHU_ENV = {
    "FRIDAY_FEISHU_APP_ID": "app",
    "FRIDAY_FEISHU_APP_SECRET": "secret",
    "FRIDAY_FEISHU_ALLOWED_USERS": "owner",
    "FRIDAY_FEISHU_ALLOW_GROUP": "",
}


def _lark_installed() -> bool:
    """Card streaming builds real SDK requests, which the extra may not provide."""
    try:
        import lark_oapi  # noqa: F401
    except ImportError:
        return False
    return True


class FakeGatewayClient:
    """Answers gateway RPC the way `friday app-server` shapes its results."""

    def __init__(self, workspace: Path) -> None:
        self.workspace = workspace
        self.on_event: Callable[[str, dict], None] | None = None
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.answers: dict[str, Any] = {}
        self.approval: dict[str, Any] = {"pending": False}
        self.fail: set[str] = set()
        self._seq = 0

    def request(self, method: str, params: dict[str, Any] | None = None, *, timeout: float = 60.0) -> Any:
        params = params or {}
        self.calls.append((method, params))
        if method in self.fail:
            raise GatewayError(f"{method} failed")
        if method in self.answers:
            answer = self.answers[method]
            return answer(params) if callable(answer) else answer
        if method == "session.new":
            self._seq += 1
            return {"info": {"session_id": f"s{self._seq}"}}
        if method == "session.resume":
            return {"info": {"session_id": params.get("id", "")}}
        if method == "approval.pending":
            return self.approval
        if method == "chat.cancel":
            return {"cancelled": True}
        if method in {"chat.send", "goal.run"}:
            return {"text": "done"}
        if method in {"approval.approve", "approval.reject", "approval.instruct"}:
            return {"message": {"text": "continued"}}
        if method == "session.info":
            return {
                "cwd": str(self.workspace),
                "model": "deepseek/chat",
                "permission_mode": "manual",
                "progress": {"objective": "ship it"},
                "session_id": "s1",
            }
        return {}

    def methods(self) -> list[str]:
        return [method for method, _ in self.calls]

    def params_for(self, method: str) -> dict[str, Any]:
        return next(params for name, params in self.calls if name == method)


class _IsolatedHome(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"FRIDAY_HOME": str(Path(self.tmp.name) / ".friday")})
        self.env.start()
        self.workspace = Path(self.tmp.name) / "workspace"
        self.workspace.mkdir()

    def tearDown(self) -> None:
        self.env.stop()
        self.tmp.cleanup()


class FakeStream:
    """Records what the bridge would show in a live message."""

    def __init__(self) -> None:
        self.pushes: list[str] = []
        self.statuses: list[str] = []
        self.closed: str | None = None

    def push(self, body: str) -> None:
        self.pushes.append(body)

    def status(self, note: str) -> None:
        self.statuses.append(note)

    def close(self, body: str) -> None:
        self.closed = body


class ImBridgeTests(_IsolatedHome):
    def _bridge(self, *, notice_seconds: float = 0.0, stream: FakeStream | None = None):
        client = FakeGatewayClient(self.workspace)
        replies: list[tuple[str, str]] = []
        bridge = FridayBridge(
            client,
            lambda chat, text: replies.append((chat, text)),
            workspace=self.workspace,
            progress_notice_seconds=notice_seconds,
            open_stream=(lambda _chat: stream) if stream is not None else None,
        )
        return bridge, client, replies

    def test_first_message_opens_a_session_and_returns_the_answer(self) -> None:
        bridge, client, replies = self._bridge()

        bridge.handle("chat-1", "hello")

        self.assertEqual(client.methods(), ["session.new", "chat.send", "approval.pending"])
        self.assertEqual(replies, [("chat-1", "done")])

    def test_blank_messages_and_help_never_reach_the_gateway(self) -> None:
        bridge, client, replies = self._bridge()

        bridge.handle("chat-1", "   ")
        bridge.handle("chat-1", "/help")

        self.assertEqual(client.methods(), [])
        self.assertIn("/goal", replies[-1][1])

    def test_each_chat_keeps_its_own_session(self) -> None:
        bridge, client, _ = self._bridge()

        bridge.handle("chat-1", "one")
        bridge.handle("chat-1", "two")
        bridge.handle("chat-2", "three")

        resumed = [params["id"] for method, params in client.calls if method == "session.resume"]
        self.assertEqual(resumed, ["s1"])
        self.assertEqual(client.methods().count("session.new"), 2)

    def test_session_mapping_survives_a_restart(self) -> None:
        first, _, _ = self._bridge()
        first.handle("chat-1", "hello")

        client = FakeGatewayClient(self.workspace)
        second = FridayBridge(client, lambda chat, text: None, workspace=self.workspace, progress_notice_seconds=0)
        second.handle("chat-1", "again")

        self.assertEqual(client.methods()[0], "session.resume")
        self.assertEqual(client.params_for("session.resume")["id"], "s1")

    def test_new_command_starts_a_fresh_session(self) -> None:
        bridge, client, replies = self._bridge()

        bridge.handle("chat-1", "hello")
        bridge.handle("chat-1", "/new")
        bridge.handle("chat-1", "next")

        resumed = [params["id"] for method, params in client.calls if method == "session.resume"]
        self.assertEqual(resumed, ["s2"])
        self.assertIn("Started a new conversation.", [text for _, text in replies])

    def test_goal_command_runs_the_verified_loop(self) -> None:
        bridge, client, _ = self._bridge()

        bridge.handle("chat-1", "/goal ship the report")

        self.assertIn("goal.run", client.methods())
        self.assertEqual(client.params_for("goal.run")["text"], "ship the report")

    def test_status_reports_the_workspace_and_model(self) -> None:
        bridge, _, replies = self._bridge()

        bridge.handle("chat-1", "/status")

        self.assertIn(str(self.workspace), replies[-1][1])
        self.assertIn("deepseek/chat", replies[-1][1])

    def test_cancel_is_not_blocked_by_the_running_turn(self) -> None:
        bridge, client, replies = self._bridge()
        started = threading.Event()
        release = threading.Event()

        def slow(_params: dict[str, Any]) -> dict[str, Any]:
            started.set()
            release.wait(5)
            return {"text": "late"}

        client.answers["chat.send"] = slow
        worker = threading.Thread(target=bridge.handle, args=("chat-1", "long job"), daemon=True)
        worker.start()
        self.assertTrue(started.wait(5))

        bridge.handle("chat-1", "/cancel")

        self.assertIn(("chat-1", "Cancelled."), replies)
        self.assertEqual(client.params_for("chat.cancel")["session_id"], "s1")
        release.set()
        worker.join(5)
        self.assertFalse(worker.is_alive())

    def test_cancelled_turn_reports_cancellation(self) -> None:
        bridge, client, replies = self._bridge()
        client.answers["chat.send"] = {"cancelled": True}

        bridge.handle("chat-1", "hello")

        self.assertEqual(replies[-1], ("chat-1", "Cancelled."))

    def test_pending_approval_asks_for_a_decision_then_approve_continues(self) -> None:
        bridge, client, replies = self._bridge()
        client.approval = {"pending": True, "command": "rm -rf build", "reason": "destructive"}

        bridge.handle("chat-1", "clean the build")
        prompt = replies[-1][1]
        client.approval = {"pending": False}
        bridge.handle("chat-1", "y")

        self.assertIn("rm -rf build", prompt)
        self.assertIn("destructive", prompt)
        self.assertIn("approval.approve", client.methods())
        self.assertEqual(replies[-1], ("chat-1", "continued"))

    def test_no_during_approval_rejects_the_command(self) -> None:
        bridge, client, _ = self._bridge()
        client.approval = {"pending": True, "command": "rm -rf build"}

        bridge.handle("chat-1", "clean the build")
        client.approval = {"pending": False}
        bridge.handle("chat-1", "n")

        self.assertIn("approval.reject", client.methods())

    def test_free_text_during_approval_becomes_an_instruction(self) -> None:
        bridge, client, _ = self._bridge()
        client.approval = {"pending": True, "command": "rm -rf build"}

        bridge.handle("chat-1", "clean the build")
        client.approval = {"pending": False}
        bridge.handle("chat-1", "use git clean instead")

        self.assertEqual(client.params_for("approval.instruct")["text"], "use git clean instead")

    def test_a_second_approval_keeps_the_chat_waiting(self) -> None:
        bridge, client, replies = self._bridge()
        client.approval = {"pending": True, "command": "rm -rf build"}

        bridge.handle("chat-1", "clean the build")
        bridge.handle("chat-1", "y")

        self.assertIn("Approval needed", replies[-1][1])
        self.assertEqual(client.methods().count("approval.approve"), 1)

    def test_gateway_errors_are_reported_instead_of_crashing(self) -> None:
        bridge, client, replies = self._bridge()
        client.fail = {"chat.send"}

        bridge.handle("chat-1", "hello")

        self.assertIn("Friday gateway error", replies[-1][1])

    def test_an_unusable_snapshot_falls_back_to_a_new_session(self) -> None:
        bridge, client, replies = self._bridge()
        bridge.handle("chat-1", "hello")
        client.fail = {"session.resume"}

        bridge.handle("chat-1", "again")

        self.assertEqual(client.methods().count("session.new"), 2)
        self.assertEqual(replies[-1], ("chat-1", "done"))

    def test_progress_notice_names_the_running_tool(self) -> None:
        bridge, client, replies = self._bridge(notice_seconds=0.05)

        def slow(_params: dict[str, Any]) -> dict[str, Any]:
            bridge.on_event("tool.start", {"name": "Bash"})
            time.sleep(0.3)
            return {"text": "done"}

        client.answers["chat.send"] = slow
        bridge.handle("chat-1", "long job")

        notices = [text for _, text in replies if "Still working" in text]
        self.assertTrue(notices)
        self.assertIn("Bash", notices[0])

    def test_streaming_grows_the_live_message_and_settles_on_the_answer(self) -> None:
        stream = FakeStream()
        bridge, client, replies = self._bridge(stream=stream)

        def talk(_params: dict[str, Any]) -> dict[str, Any]:
            bridge.on_event("message.delta", {"text": "Hel"})
            bridge.on_event("message.delta", {"text": "lo"})
            return {"text": "Hello"}

        client.answers["chat.send"] = talk
        bridge.handle("chat-1", "hi")

        self.assertEqual(stream.pushes, ["Hel", "Hello"])
        self.assertEqual(stream.closed, "Hello")
        # The live message is the reply, so nothing is sent a second time.
        self.assertEqual(replies, [])

    def test_streaming_replaces_the_periodic_progress_message(self) -> None:
        stream = FakeStream()
        bridge, client, replies = self._bridge(notice_seconds=0.05, stream=stream)

        def slow(_params: dict[str, Any]) -> dict[str, Any]:
            bridge.on_event("tool.start", {"name": "Bash"})
            time.sleep(0.2)
            return {"text": "done"}

        client.answers["chat.send"] = slow
        bridge.handle("chat-1", "long job")

        self.assertEqual([text for _, text in replies if "Still working" in text], [])
        self.assertIn("Bash", stream.statuses[0])

    def test_a_gateway_failure_still_closes_the_live_message(self) -> None:
        stream = FakeStream()
        bridge, client, _ = self._bridge(stream=stream)
        client.fail.add("chat.send")

        bridge.handle("chat-1", "hi")

        self.assertIsNotNone(stream.closed)

    def test_a_cancelled_turn_settles_the_live_message(self) -> None:
        stream = FakeStream()
        bridge, client, _ = self._bridge(stream=stream)
        client.answers["chat.send"] = {"cancelled": True}

        bridge.handle("chat-1", "hi")

        self.assertEqual(stream.closed, "Cancelled.")

    def test_deltas_outside_a_turn_are_ignored(self) -> None:
        stream = FakeStream()
        bridge, _, _ = self._bridge(stream=stream)

        bridge.handle("chat-1", "hi")
        bridge.on_event("message.delta", {"text": "late"})

        self.assertEqual(stream.pushes, [])


class FeishuTargetTests(_IsolatedHome):
    def _bridge(self, **env: str) -> FeishuBridge:
        with patch.dict(os.environ, {**FEISHU_ENV, **env}):
            return FeishuBridge(FeishuConfig.from_env(self.workspace))

    def test_missing_credentials_refuse_to_start(self) -> None:
        with patch.dict(os.environ, {**FEISHU_ENV, "FRIDAY_FEISHU_APP_SECRET": ""}):
            with self.assertRaises(SystemExit) as error:
                FeishuConfig.from_env(self.workspace)

        self.assertIn("app secret", str(error.exception))

    def test_empty_whitelist_pairs_without_running_anything(self) -> None:
        bridge = self._bridge(FRIDAY_FEISHU_ALLOWED_USERS="")

        self.assertTrue(bridge.config.pairing)
        self.assertIsNone(bridge._target(_event(sender="owner")))

    def test_no_stream_opens_before_the_sdk_client_exists(self) -> None:
        bridge = self._bridge()

        self.assertIsNone(bridge._open_stream("chat-1"))

    def test_gateway_never_inherits_the_feishu_secret(self) -> None:
        bridge = self._bridge()

        self.assertIn("FRIDAY_FEISHU_APP_SECRET", bridge._client.withhold_env)

    def test_only_whitelisted_senders_reach_friday(self) -> None:
        bridge = self._bridge()

        self.assertIsNone(bridge._target(_event(sender="stranger")))
        self.assertEqual(bridge._target(_event(sender="owner")), ("chat-1", "hi", "m1"))

    def test_a_replayed_message_is_handled_once(self) -> None:
        bridge = self._bridge()

        first = bridge._target(_event(sender="owner", message_id="m1"))
        replay = bridge._target(_event(sender="owner", message_id="m1"))

        self.assertEqual(first, ("chat-1", "hi", "m1"))
        self.assertIsNone(replay)

    def test_group_chats_are_off_until_enabled_and_then_need_a_mention(self) -> None:
        closed = self._bridge()
        opened = self._bridge(FRIDAY_FEISHU_ALLOW_GROUP="1")
        mention = SimpleNamespace(key="@_user_1")

        self.assertIsNone(closed._target(_event(sender="owner", chat_type="group", mentions=[mention])))
        self.assertIsNone(opened._target(_event(sender="owner", chat_type="group")))
        self.assertEqual(
            opened._target(_event(sender="owner", chat_type="group", text="@_user_1 build it", mentions=[mention])),
            ("chat-1", "build it", "m1"),
        )

    def test_non_text_messages_are_ignored(self) -> None:
        self.assertEqual(_message_text(SimpleNamespace(message_type="image", content="{}")), "")
        self.assertEqual(_message_text(SimpleNamespace(message_type="text", content="not json")), "")

    def test_mentions_are_stripped_from_the_prompt(self) -> None:
        mentions = [SimpleNamespace(key="@_user_1")]

        self.assertEqual(_strip_mentions("@_user_1   build   it", mentions), "build it")

    def test_long_answers_are_split_into_sendable_chunks(self) -> None:
        sizes = [len(chunk) for chunk in _chunks("x" * (MAX_CARD_CHARS + 500))]

        self.assertEqual(sizes, [MAX_CARD_CHARS, 500])
        self.assertEqual(_chunks("   "), [])


class FeishuSettingsTests(_IsolatedHome):
    def test_a_saved_secret_is_reported_but_never_returned(self) -> None:
        view = save_feishu_settings(self.workspace, app_id="cli_x", app_secret="s3cret")

        self.assertEqual(view["app_id"], "cli_x")
        self.assertTrue(view["app_secret_configured"])
        self.assertNotIn("app_secret", view)
        self.assertEqual(feishu_credentials()["app_secret"], "s3cret")

    def test_saving_other_fields_keeps_the_secret(self) -> None:
        save_feishu_settings(self.workspace, app_id="cli_x", app_secret="s3cret")

        view = save_feishu_settings(self.workspace, allowed_users="ou_a, ou_b", allow_group=True)

        self.assertTrue(view["app_secret_configured"])
        self.assertEqual(view["allowed_users"], ["ou_a", "ou_b"])
        self.assertTrue(view["allow_group"])

    def test_clearing_the_secret_leaves_the_app_id(self) -> None:
        save_feishu_settings(self.workspace, app_id="cli_x", app_secret="s3cret")

        view = save_feishu_settings(self.workspace, clear_app_secret=True)

        self.assertEqual(view["app_id"], "cli_x")
        self.assertFalse(view["app_secret_configured"])

    def test_duplicate_and_blank_open_ids_are_dropped(self) -> None:
        view = save_feishu_settings(self.workspace, allowed_users=["ou_a", " ou_a ", "", "ou_b"])

        self.assertEqual(view["allowed_users"], ["ou_a", "ou_b"])

    def test_the_secret_file_is_not_world_readable(self) -> None:
        save_feishu_settings(self.workspace, app_secret="s3cret")
        path = Path(os.environ["FRIDAY_HOME"]) / FEISHU_FILE

        self.assertTrue(path.exists())
        if os.name != "nt":
            self.assertEqual(path.stat().st_mode & 0o077, 0)

    def test_stored_settings_drive_the_bridge_when_the_env_is_quiet(self) -> None:
        save_feishu_settings(
            self.workspace, app_id="cli_x", app_secret="s3cret", allowed_users=["ou_a"], allow_group=True
        )

        with patch.dict(os.environ, {}, clear=False):
            for name in IM_BRIDGE_ENV_NAMES:
                os.environ.pop(name, None)
            config = FeishuConfig.from_env(self.workspace)

        self.assertEqual(config.app_id, "cli_x")
        self.assertEqual(config.allowed_users, frozenset({"ou_a"}))
        self.assertTrue(config.allow_group)

    def test_the_environment_overrides_stored_settings(self) -> None:
        save_feishu_settings(self.workspace, app_id="stored", app_secret="s3cret")

        with patch.dict(os.environ, {"FRIDAY_FEISHU_APP_ID": "from-env"}):
            config = FeishuConfig.from_env(self.workspace)

        self.assertEqual(config.app_id, "from-env")


class FeishuCredentialCheckTests(unittest.TestCase):
    def setUp(self) -> None:
        self.config = FeishuConfig(
            app_id="cli_x",
            app_secret="s3cret",
            allowed_users=frozenset({"ou_a"}),
            workspace=Path.cwd(),
        )

    def test_an_accepted_app_reports_no_problem(self) -> None:
        with _feishu_token_reply({"code": 0, "tenant_access_token": "t-1"}):
            self.assertEqual(credential_problem(self.config), "")

    def test_a_rejected_app_reports_what_feishu_said(self) -> None:
        with _feishu_token_reply({"code": 10014, "msg": "invalid app_secret"}):
            self.assertEqual(credential_problem(self.config), "invalid app_secret")

    def test_an_unreachable_network_is_not_blamed_on_the_credentials(self) -> None:
        with patch("urllib.request.urlopen", side_effect=OSError("offline")):
            self.assertEqual(credential_problem(self.config), "")

    def test_a_refused_app_stops_the_bridge_before_it_retries_forever(self) -> None:
        bridge = FeishuBridge(self.config)

        with patch("friday.im.feishu._import_lark"):
            with patch("friday.im.feishu.credential_problem", return_value="invalid app_id"):
                with self.assertRaises(SystemExit) as error:
                    bridge.run()

        self.assertIn("invalid app_id", str(error.exception))


class BridgeSupervisorTests(_IsolatedHome):
    def test_a_stopped_bridge_reports_itself_as_off(self) -> None:
        supervisor = BridgeSupervisor()

        status = supervisor.status()

        self.assertFalse(status["running"])
        self.assertIsNone(status["pid"])

    def test_starting_reports_running_and_stopping_reports_off(self) -> None:
        supervisor = BridgeSupervisor()
        with patch.object(BridgeSupervisor, "_spawn", return_value=_FakeChild()):
            started = supervisor.start(self.workspace)
            stopped = supervisor.stop()

        self.assertTrue(started["running"])
        self.assertEqual(started["workspace"], str(self.workspace))
        self.assertFalse(stopped["running"])

    def test_starting_twice_keeps_one_process(self) -> None:
        supervisor = BridgeSupervisor()
        with patch.object(BridgeSupervisor, "_spawn", return_value=_FakeChild()) as spawn:
            supervisor.start(self.workspace)
            supervisor.start(self.workspace)

        self.assertEqual(spawn.call_count, 1)

    def test_a_bridge_that_exits_reports_its_output_for_diagnosis(self) -> None:
        supervisor = BridgeSupervisor()
        child = _FakeChild(lines=["The Feishu bridge needs an app secret."], returncode=1, alive=False)
        with patch.object(BridgeSupervisor, "_spawn", return_value=child):
            supervisor.start(self.workspace)
            _wait_for(lambda: bool(supervisor.status()["log"]))
            status = supervisor.status()

        self.assertFalse(status["running"])
        self.assertEqual(status["exit_code"], 1)
        self.assertIn("app secret", status["log"][0])

    def test_a_spawn_failure_is_reported_instead_of_raising(self) -> None:
        supervisor = BridgeSupervisor()
        with patch.object(BridgeSupervisor, "_spawn", side_effect=OSError("no python")):
            status = supervisor.start(self.workspace)

        self.assertFalse(status["running"])
        self.assertIn("no python", status["log"][0])


class FeishuCardTests(unittest.TestCase):
    def test_markdown_card_renders_the_body_as_markdown(self) -> None:
        card = json.loads(markdown_card("**bold**"))
        element = card["body"]["elements"][0]

        self.assertEqual(card["schema"], "2.0")
        self.assertEqual(element["tag"], "markdown")
        self.assertEqual(element["content"], "**bold**")

    def test_streaming_card_keeps_answer_and_status_apart(self) -> None:
        card = json.loads(streaming_card())

        self.assertTrue(card["config"]["streaming_mode"])
        # The API rejects streaming on a card that is not shared.
        self.assertTrue(card["config"]["update_multi"])
        elements = [element["element_id"] for element in card["body"]["elements"]]
        self.assertEqual(elements, [ANSWER_ELEMENT, STATUS_ELEMENT])

    def test_an_overlong_body_is_truncated_rather_than_rejected(self) -> None:
        content = json.loads(markdown_card("x" * (MAX_CARD_CHARS + 50)))["body"]["elements"][0]["content"]

        self.assertTrue(content.startswith("x"))
        self.assertIn("truncated", content)


@unittest.skipUnless(_lark_installed(), "needs the feishu extra")
class FeishuStreamTests(unittest.TestCase):
    def test_a_turn_that_finishes_fast_sends_one_plain_card(self) -> None:
        lark = _FakeLark()
        stream = FeishuStream(lark, "chat-1", interval=5.0, log=lambda _line: None)

        stream.close("done")

        self.assertEqual(lark.names(), ["message.create"])

    def test_a_streamed_turn_opens_a_card_and_leaves_streaming_mode(self) -> None:
        lark = _FakeLark()
        stream = FeishuStream(lark, "chat-1", interval=0.02, log=lambda _line: None)

        stream.push("Hel")
        _wait_for(lambda: "element.content" in lark.names())
        stream.close("Hello")

        self.assertEqual(lark.names()[:3], ["card.create", "message.create", "element.content"])
        self.assertEqual(lark.names()[-1], "card.settings")

    def test_card_operations_use_strictly_increasing_sequences(self) -> None:
        lark = _FakeLark()
        stream = FeishuStream(lark, "chat-1", interval=0.02, log=lambda _line: None)

        stream.push("a")
        _wait_for(lambda: "element.content" in lark.names())
        stream.push("ab")
        _wait_for(lambda: lark.names().count("element.content") >= 2)
        stream.close("abc")

        sequences = [
            request.request_body.sequence
            for name, request in lark.calls
            if name in {"element.content", "card.settings"}
        ]
        self.assertEqual(sequences, sorted(sequences))
        self.assertEqual(len(sequences), len(set(sequences)))

    def test_status_notes_go_to_their_own_element(self) -> None:
        lark = _FakeLark()
        stream = FeishuStream(lark, "chat-1", interval=0.02, log=lambda _line: None)

        stream.status("Running Bash...")
        _wait_for(lambda: "element.content" in lark.names())
        stream.close("done")

        targets = [request.element_id for name, request in lark.calls if name == "element.content"]
        self.assertIn(STATUS_ELEMENT, targets)

    def test_a_broken_card_still_delivers_the_answer(self) -> None:
        lark = _FakeLark(fail={"card.create"})
        stream = FeishuStream(lark, "chat-1", interval=0.02, log=lambda _line: None)

        stream.push("partial")
        _wait_for(lambda: "card.create" in lark.names())
        stream.close("final answer")

        sent = [request for name, request in lark.calls if name == "message.create"]
        self.assertTrue(sent)
        self.assertIn("final answer", sent[-1].request_body.content)


class GatewayClientTests(_IsolatedHome):
    def test_responses_resolve_requests_and_errors_raise(self) -> None:
        client = GatewayClient(self.workspace)

        with patch.object(client, "start"), patch.object(client, "_proc", _FakeProc()):
            answered = _respond(client, {"result": {"text": "ok"}})
            self.assertEqual(answered, {"text": "ok"})
            with self.assertRaises(GatewayError):
                _respond(client, {"error": {"message": "boom"}})

    def test_events_are_forwarded_with_type_and_payload(self) -> None:
        seen: list[tuple[str, dict]] = []
        client = GatewayClient(self.workspace, on_event=lambda event_type, payload: seen.append((event_type, payload)))

        client._dispatch(
            {"jsonrpc": "2.0", "method": "event", "params": {"type": "tool.start", "payload": {"name": "Bash"}}}
        )

        self.assertEqual(seen, [("tool.start", {"name": "Bash"})])

    def test_a_dead_gateway_fails_waiting_requests(self) -> None:
        client = GatewayClient(self.workspace)
        failed: list[str] = []

        with patch.object(client, "start"), patch.object(client, "_proc", _FakeProc()):
            thread = threading.Thread(
                target=lambda: failed.append(_capture(lambda: client.request("session.info", timeout=5))),
                daemon=True,
            )
            thread.start()
            _wait_for(lambda: bool(client._pending))
            client._fail_all("gateway exited")
            thread.join(5)

        self.assertEqual(failed, ["gateway exited"])


@contextmanager
def _feishu_token_reply(payload: dict[str, Any]):
    """Answer the token request without touching the network."""
    response = MagicMock()
    response.read.return_value = json.dumps(payload).encode("utf-8")
    response.__enter__ = lambda self: self
    response.__exit__ = lambda *_args: False
    with patch("urllib.request.urlopen", return_value=response):
        yield


class _FakeChild:
    """Stands in for the bridge subprocess so tests never spawn one."""

    def __init__(self, *, lines: list[str] | None = None, returncode: int = 0, alive: bool = True) -> None:
        self.stdout = iter([f"{line}\n" for line in (lines or [])])
        self.returncode = returncode
        self.pid = 4242
        self._alive = alive
        self.terminated = False

    def poll(self) -> int | None:
        return None if self._alive else self.returncode

    def terminate(self) -> None:
        self.terminated = True
        self._alive = False

    def wait(self, timeout: float | None = None) -> int:
        self._alive = False
        return self.returncode

    def kill(self) -> None:
        self._alive = False


class _FakeLark:
    """Mimics the slice of the lark SDK that card streaming calls."""

    def __init__(self, *, fail: set[str] | frozenset[str] = frozenset()) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.fail = set(fail)
        self.cardkit = SimpleNamespace(
            v1=SimpleNamespace(
                card=SimpleNamespace(create=self._create, settings=self._settings),
                card_element=SimpleNamespace(content=self._content),
            )
        )
        self.im = SimpleNamespace(v1=SimpleNamespace(message=SimpleNamespace(create=self._send)))

    def names(self) -> list[str]:
        return [name for name, _ in self.calls]

    def _answer(self, name: str, **data: Any) -> SimpleNamespace:
        ok = name not in self.fail
        return SimpleNamespace(
            success=lambda: ok,
            code=0 if ok else 1,
            msg="ok" if ok else "boom",
            data=SimpleNamespace(**data),
        )

    def _create(self, request: Any) -> SimpleNamespace:
        self.calls.append(("card.create", request))
        return self._answer("card.create", card_id="card-1")

    def _send(self, request: Any) -> SimpleNamespace:
        self.calls.append(("message.create", request))
        return self._answer("message.create", message_id="om-1")

    def _content(self, request: Any) -> SimpleNamespace:
        self.calls.append(("element.content", request))
        return self._answer("element.content")

    def _settings(self, request: Any) -> SimpleNamespace:
        self.calls.append(("card.settings", request))
        return self._answer("card.settings")


class _FakeProc:
    def __init__(self) -> None:
        self.stdin = _FakeStdin()
        self.stdout = None
        self.stderr = None


class _FakeStdin:
    def __init__(self) -> None:
        self.written: list[bytes] = []

    def write(self, data: bytes) -> None:
        self.written.append(data)

    def flush(self) -> None:
        return None


def _respond(client: GatewayClient, reply: dict[str, Any]) -> Any:
    """Run one request and answer it from another thread, like the read loop."""
    result: list[Any] = []

    def call() -> None:
        result.append(_capture(lambda: client.request("session.info", timeout=5)))

    thread = threading.Thread(target=call, daemon=True)
    thread.start()
    _wait_for(lambda: bool(client._pending))
    rid = next(iter(client._pending))
    client._dispatch({"jsonrpc": "2.0", "id": rid, **reply})
    thread.join(5)
    if isinstance(result[0], str):
        raise GatewayError(result[0])
    return result[0]


def _capture(call: Callable[[], Any]) -> Any:
    try:
        return call()
    except GatewayError as exc:
        return str(exc)


def _wait_for(predicate: Callable[[], bool], timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.005)
    raise AssertionError("condition was never met")


def _event(
    *,
    sender: str,
    chat_id: str = "chat-1",
    text: str = "hi",
    message_id: str = "m1",
    chat_type: str = "p2p",
    mentions: list[Any] | None = None,
) -> SimpleNamespace:
    message = SimpleNamespace(
        chat_id=chat_id,
        chat_type=chat_type,
        content=json.dumps({"text": text}, ensure_ascii=False),
        mentions=mentions,
        message_id=message_id,
        message_type="text",
    )
    return SimpleNamespace(
        event=SimpleNamespace(
            message=message,
            sender=SimpleNamespace(sender_id=SimpleNamespace(open_id=sender)),
        )
    )


if __name__ == "__main__":
    unittest.main()
