from __future__ import annotations

import unittest
from pathlib import Path
from unittest.mock import patch

from agent_core import RunContext

from friday.progress import PROGRESS_ARTIFACT
from friday.session import APPROVAL_FOLLOWUP_PROMPT, FridaySession
from friday.turn import TurnResult


def _turn_result(answer: str) -> TurnResult:
    return TurnResult(
        agent=object(),
        context=RunContext(metadata={"workspace": str(Path.cwd())}),
        answer=answer,
        verifications=[],
        metrics={},
        progress={},
    )


class SessionApprovalTests(unittest.TestCase):
    def test_approve_continues_suspended_goal_with_original_text(self) -> None:
        session = FridaySession()
        session.suspended = {"text": "delete the stale export", "goal": True}

        with patch("friday.session.approve_pending", return_value={"approved": True}) as approve:
            with patch("friday.session.finish_pending_checkpoint") as finish:
                with patch.object(FridaySession, "chat", return_value=_turn_result("done")) as chat:
                    outcome = session.approve()

        approve.assert_called_once_with(session.workspace)
        finish.assert_called_once_with(session.workspace, pending=True)
        chat.assert_called_once_with(
            "delete the stale export",
            goal=True,
            approval_result={"approved": True},
            user_label="/approve",
            continuation=True,
        )
        self.assertTrue(outcome["continued"])
        self.assertIsNone(session.suspended)

    def test_approve_continues_normal_chat_with_followup_prompt(self) -> None:
        session = FridaySession()
        session.suspended = {"text": "clean caches", "goal": False}

        with patch("friday.session.approve_pending", return_value={"approved": True}):
            with patch("friday.session.finish_pending_checkpoint"):
                with patch.object(FridaySession, "chat", return_value=_turn_result("reported")) as chat:
                    session.approve()

        self.assertEqual(chat.call_args.args[0], APPROVAL_FOLLOWUP_PROMPT)
        self.assertFalse(chat.call_args.kwargs["goal"])

    def test_approve_without_session_state_executes_but_does_not_continue(self) -> None:
        session = FridaySession()

        with patch("friday.session.approve_pending", return_value={"approved": True}):
            with patch("friday.session.finish_pending_checkpoint") as finish:
                with patch.object(FridaySession, "chat") as chat:
                    outcome = session.approve()

        chat.assert_not_called()
        self.assertFalse(outcome["continued"])
        # The checkpoint stays pending for the continuation turn, then closes
        # immediately when there is nothing to continue.
        self.assertEqual(
            [call.kwargs["pending"] for call in finish.call_args_list],
            [True, False],
        )

    def test_approve_derives_goal_turn_from_restored_progress(self) -> None:
        session = FridaySession()
        session.agent = object()
        session.context = RunContext(metadata={"workspace": str(session.workspace)})
        session.context.artifacts[PROGRESS_ARTIFACT] = {
            "objective": "ship the release notes",
            "mode": "goal",
            "status": "waiting",
        }

        with patch("friday.session.approve_pending", return_value={"approved": True}):
            with patch("friday.session.finish_pending_checkpoint"):
                with patch.object(FridaySession, "chat", return_value=_turn_result("done")) as chat:
                    session.approve()

        self.assertEqual(chat.call_args.args[0], "ship the release notes")
        self.assertTrue(chat.call_args.kwargs["goal"])

    def test_reject_with_guidance_combines_goal_and_instruction(self) -> None:
        session = FridaySession()
        session.suspended = {"text": "delete file", "goal": True}
        rejection = {"approved": False, "rejected": True, "command": "rm file"}

        with patch("friday.session.approve_pending", return_value=rejection):
            with patch("friday.session.finish_pending_checkpoint") as finish:
                with patch.object(FridaySession, "chat", return_value=_turn_result("edited instead")) as chat:
                    outcome = session.reject("keep the file and edit it instead")

        prompt = chat.call_args.args[0]
        self.assertIn("delete file", prompt)
        self.assertIn("keep the file and edit it instead", prompt)
        self.assertEqual(chat.call_args.kwargs["approval_result"]["instruction"], "keep the file and edit it instead")
        self.assertTrue(outcome["continued"])
        finish.assert_called_once_with(session.workspace, pending=False)

    def test_reject_without_guidance_marks_progress_blocked(self) -> None:
        session = FridaySession()
        session.agent = object()
        session.context = RunContext(metadata={"workspace": str(session.workspace)})

        with patch("friday.session.approve_pending", return_value={"rejected": True}):
            with patch("friday.session.finish_pending_checkpoint"):
                with patch("friday.session.finish_progress") as blocked:
                    outcome = session.reject()

        self.assertFalse(outcome["continued"])
        self.assertEqual(blocked.call_args.args[1], "blocked")

    def test_chat_records_suspension_while_approval_is_pending(self) -> None:
        session = FridaySession()
        session.agent = object()
        session.context = RunContext(metadata={"workspace": str(session.workspace)})
        result = _turn_result("paused")

        with patch("friday.session.run_turn", return_value=result):
            with patch("friday.session.pending_approval", return_value={"pending": True}):
                session.chat("delete it", goal=True)

        self.assertEqual(session.suspended, {"text": "delete it", "goal": True})
        self.assertIs(session.context, result.context)
        self.assertIs(session.agent, result.agent)

    def test_chat_clears_suspension_when_nothing_is_pending(self) -> None:
        session = FridaySession()
        session.agent = object()
        session.context = RunContext(metadata={"workspace": str(session.workspace)})
        session.suspended = {"text": "old", "goal": False}

        with patch("friday.session.run_turn", return_value=_turn_result("done")):
            with patch("friday.session.pending_approval", return_value={"pending": False}):
                session.chat("hello")

        self.assertIsNone(session.suspended)


if __name__ == "__main__":
    unittest.main()
