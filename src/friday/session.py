"""Single owner of a live Friday session and its approval state machine.

The CLI and the TUI gateway are thin views over this facade: they render
events and turn results, and never mutate agent state or re-implement the
approve / reject / continue logic themselves. Every operation that swaps the
agent/context pair (compact, resume, undo, reset) goes through ``_adopt`` so
event subscribers survive the swap.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from agent_core import Agent, AgentEvent, RunContext

from friday.app import build_friday, compact_friday, reset_friday, resume_friday, undo_friday
from friday.checkpoint import finish_pending_checkpoint
from friday.progress import current_progress, finish_progress
from friday.tools import allow_permissions_for_session, approve_pending, pending_approval
from friday.turn import TurnResult, run_turn

APPROVAL_FOLLOWUP_PROMPT = (
    "The user approved the pending command and it has now executed. "
    "Use the approval result in the system context to continue or briefly report the final state to the user. "
    "Do not ask for approval again unless a new dangerous action is required."
)


class FridaySession:
    def __init__(
        self,
        workspace: Path | None = None,
        *,
        stream: bool = True,
        on_delta: Callable[[str], None] | None = None,
        on_verify: Callable[[dict[str, Any]], None] | None = None,
        on_progress: Callable[[dict[str, Any]], None] | None = None,
        on_context_notice: Callable[[str], None] | None = None,
        on_event: Callable[[AgentEvent], None] | None = None,
        on_turn_start: Callable[[str], None] | None = None,
        on_turn_complete: Callable[[TurnResult], None] | None = None,
        on_approval: Callable[[dict[str, Any]], None] | None = None,
        on_rejection: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        self.workspace = (workspace or Path.cwd()).resolve()
        self.stream = stream
        self.on_delta = on_delta
        self.on_verify = on_verify
        self.on_progress = on_progress
        self.on_context_notice = on_context_notice
        self.on_event = on_event
        self.on_turn_start = on_turn_start
        self.on_turn_complete = on_turn_complete
        self.on_approval = on_approval
        self.on_rejection = on_rejection
        self.agent: Agent | None = None
        self.context: RunContext | None = None
        self.suspended: dict[str, Any] | None = None

    def ensure(self) -> tuple[Agent, RunContext]:
        if self.agent is None or self.context is None:
            self._adopt(*build_friday(self.workspace, stream=self.stream))
        return self.agent, self.context

    def progress(self) -> dict[str, Any]:
        return current_progress(self.context) if self.context is not None else {}

    def chat(
        self,
        text: str,
        *,
        goal: bool = False,
        approval_result: dict[str, Any] | None = None,
        user_label: str | None = None,
        continuation: bool = False,
    ) -> TurnResult:
        agent, context = self.ensure()
        if self.on_turn_start is not None:
            self.on_turn_start(text)
        result = run_turn(
            agent,
            context,
            text,
            goal=goal,
            stream=self.stream,
            on_delta=self.on_delta,
            on_verify=self.on_verify,
            on_progress=self.on_progress,
            on_context_notice=self.on_context_notice,
            approval_result=approval_result,
            user_label=user_label,
            continuation=continuation,
        )
        self._adopt(result.agent, result.context)
        self.suspended = {"text": text, "goal": goal} if pending_approval(self.workspace).get("pending") else None
        if self.on_turn_complete is not None:
            self.on_turn_complete(result)
        return result

    def approve(self, *, for_session: bool = False) -> dict[str, Any]:
        """Execute the pending command and continue the suspended work.

        The continuation turn reuses the still-pending checkpoint, so /undo
        rolls back the suspended turn and its continuation together.
        """
        result = approve_pending(self.workspace)
        if not result.get("approved"):
            # No pending command means any remembered suspension is stale.
            self.suspended = None
            return {"approval": result, "continued": False}
        finish_pending_checkpoint(self.workspace, pending=True)
        if self.on_approval is not None:
            self.on_approval(result)
        turn = self._pending_turn()
        self.suspended = None
        if for_session:
            _agent, context = self.ensure()
            allow_permissions_for_session(context)
        if turn is None:
            finish_pending_checkpoint(self.workspace, pending=False)
            return {"approval": result, "continued": False}
        prompt = turn["text"] if turn["goal"] else APPROVAL_FOLLOWUP_PROMPT
        turn_result = self.chat(
            prompt,
            goal=turn["goal"],
            approval_result=result,
            user_label="/approve",
            continuation=True,
        )
        return {"approval": result, "continued": True, "turn": turn_result}

    def reject(self, guidance: str = "") -> dict[str, Any]:
        """Discard the pending command; optionally continue with human guidance."""
        result = approve_pending(self.workspace, reject=True)
        if not result.get("rejected"):
            self.suspended = None
            return {"approval": result, "continued": False}
        if self.on_rejection is not None:
            self.on_rejection(result)
        turn = self._pending_turn()
        self.suspended = None
        outcome: dict[str, Any] = {"approval": result, "continued": False}
        if guidance and turn is not None:
            prompt = guidance
            if turn["goal"] and turn["text"]:
                prompt = f"{turn['text']}\n\nHuman guidance after declining the pending command: {guidance}"
            turn_result = self.chat(
                prompt,
                goal=turn["goal"],
                approval_result={**result, "instruction": guidance},
                user_label=guidance,
                continuation=True,
            )
            outcome = {"approval": result, "continued": True, "turn": turn_result}
        elif self.context is not None:
            finish_progress(
                self.context,
                "blocked",
                [{"verdict": "blocked", "feedback": "User rejected the pending command."}],
            )
        finish_pending_checkpoint(self.workspace, pending=False)
        return outcome

    def compact(self) -> str:
        agent, context = self.ensure()
        new_agent, new_context, summary = compact_friday(agent, context, stream=self.stream)
        self._adopt(new_agent, new_context)
        return summary

    def resume(self, resume_id: str | None = None) -> int:
        agent, context, count = resume_friday(self.workspace, stream=self.stream, resume_id=resume_id)
        self._adopt(agent, context)
        self.suspended = None
        return count

    def new(self) -> None:
        self.agent = None
        self.context = None
        self.suspended = None

    def undo(self, checkpoint_id: str | None = None, *, force: bool = False) -> dict[str, Any]:
        agent, context, restored = undo_friday(
            self.workspace,
            checkpoint_id=checkpoint_id,
            stream=self.stream,
            force=force,
        )
        self._adopt(agent, context)
        self.suspended = None
        return restored

    def reset(self, *, include_user: bool = False) -> list[Path]:
        removed = reset_friday(self.workspace, include_user=include_user)
        self.agent = None
        self.context = None
        self.suspended = None
        return removed

    def _adopt(self, agent: Agent, context: RunContext) -> None:
        self.agent = agent
        self.context = context
        if self.on_event is not None:
            context.on_event = self.on_event

    def _pending_turn(self) -> dict[str, Any] | None:
        """What to continue with after an approval decision.

        An in-memory suspension knows the original request; a fresh process
        (CLI approve/reject after resume) derives it from restored progress.
        """
        if self.suspended:
            return dict(self.suspended)
        progress = self.progress()
        if not progress:
            return None
        if progress.get("mode") == "goal":
            return {"text": str(progress.get("objective") or "Continue the approved goal."), "goal": True}
        return {"text": "", "goal": False}
