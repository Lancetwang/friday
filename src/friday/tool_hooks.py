from __future__ import annotations

import hashlib
import json
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Protocol

from agent_core import ExecResult, Node, RunContext, ToolCall, ToolExecutor, ToolResult, get_current_context

from friday.storage import migrate_legacy_runtime
from friday.text import clip
from friday.tools import SHELL_PERMISSION_PREFLIGHT, create_pending_approval, preflight_shell_permission

GUARD_STOP_REASON = "friday.guard_stop_reason"
NO_PROGRESS_STATE = "friday.no_progress"
NO_PROGRESS_WINDOW = 3
NO_PROGRESS_REPEAT_LIMIT = 3


@dataclass(frozen=True)
class ToolBatch:
    calls: tuple[ToolCall, ...]


@dataclass(frozen=True)
class PreToolDecision:
    action: Literal["continue", "deny", "suspend"] = "continue"
    tool_call_id: str = ""
    reason: str = ""
    result: Any = None


@dataclass(frozen=True)
class PostToolDecision:
    action: Literal["continue", "feedback", "halt", "suspend"] = "continue"
    reason: str = ""
    data: Mapping[str, Any] | None = None


class PreToolHook(Protocol):
    name: str
    priority: int

    def before_tool_batch(self, context: RunContext, batch: ToolBatch) -> PreToolDecision: ...


class PostToolHook(Protocol):
    name: str
    priority: int

    def after_tool_batch(
        self,
        context: RunContext,
        batch: ToolBatch,
        results: Sequence[ToolResult],
    ) -> PostToolDecision: ...


class ShellPermissionHook:
    name = "permission"
    priority = 100

    def before_tool_batch(self, context: RunContext, batch: ToolBatch) -> PreToolDecision:
        workspace = Path(str(context.metadata.get("workspace") or Path.cwd())).resolve()
        friday_dir = migrate_legacy_runtime(workspace)
        allowed: dict[str, dict[str, str]] = {}
        approval: tuple[ToolCall, int, str] | None = None

        for call in batch.calls:
            if call.name != "Bash":
                continue
            command = str(call.arguments.get("command") or "")
            timeout = _positive_int(call.arguments.get("timeout_seconds"), 60)
            decision, reason = preflight_shell_permission(friday_dir, command)
            if decision == "deny":
                return PreToolDecision(
                    action="deny",
                    tool_call_id=call.id,
                    reason=reason,
                    result={"blocked": True, "message": f"Command blocked before execution: {reason}"},
                )
            if decision == "approval" and approval is None:
                approval = (call, timeout, reason)
            allowed[call.id] = {"command": command, "decision": decision, "reason": reason}

        if approval is not None:
            call, timeout, reason = approval
            pending = create_pending_approval(
                friday_dir,
                str(call.arguments.get("command") or ""),
                timeout,
                reason,
            )
            return PreToolDecision(
                action="suspend",
                tool_call_id=call.id,
                reason=reason,
                result={**pending, "approval_required": True, "message": "Execution paused for human approval."},
            )

        context.metadata[SHELL_PERMISSION_PREFLIGHT] = allowed
        return PreToolDecision()


class PendingApprovalHook:
    """Preserve tools that implement their own side-effect-free approval gate."""

    name = "pending-approval"
    priority = 100

    def after_tool_batch(
        self,
        _context: RunContext,
        _batch: ToolBatch,
        results: Sequence[ToolResult],
    ) -> PostToolDecision:
        for result in results:
            try:
                value = json.loads(result.content)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict) and value.get("approval_required"):
                return PostToolDecision(action="suspend", reason="approval required", data=value)
        return PostToolDecision()


class NoProgressHook:
    name = "no-progress"
    priority = 200

    def after_tool_batch(
        self,
        context: RunContext,
        batch: ToolBatch,
        results: Sequence[ToolResult],
    ) -> PostToolDecision:
        entries = _round_entries(batch.calls, results)
        if not entries:
            return PostToolDecision()

        state = context.metadata.setdefault(NO_PROGRESS_STATE, {"rounds": [], "warned": {}})
        rounds = state.setdefault("rounds", [])
        current_round = _collapse_round(entries)
        rounds.append(current_round)
        del rounds[:-NO_PROGRESS_WINDOW]

        warned = state.setdefault("warned", {})
        repeated_after_warning = {
            signature: entry
            for signature, entry in current_round.items()
            if entry.get("result") and warned.get(signature) == entry["result"]
        }
        if repeated_after_warning:
            return PostToolDecision(
                action="halt",
                reason="The same tool calls continued after a no-progress warning.",
                data={
                    "repeated_calls": _decision_details(repeated_after_warning, scope="after_warning"),
                    "window": NO_PROGRESS_WINDOW,
                },
            )

        batch_stalled = _batch_repetitions(entries)
        round_stalled = _round_repetitions(rounds)
        stalled = {**round_stalled, **batch_stalled}
        if not stalled:
            state["warned"] = {}
            return PostToolDecision()

        state["warned"] = {signature: entry["result"] for signature, entry in stalled.items()}
        return PostToolDecision(
            action="feedback",
            reason=(
                "Exact tool calls repeated within one batch or across three rounds without a changed result. "
                "Do not repeat them; change approach or report the concrete blocker."
            ),
            data={"repeated_calls": _decision_details(stalled), "window": NO_PROGRESS_WINDOW},
        )


class PreToolHookNode(Node):
    def __init__(self, executor: ToolExecutor, hooks: Sequence[PreToolHook]) -> None:
        super().__init__()
        self.executor = executor
        self.hooks = tuple(sorted(hooks, key=lambda hook: hook.priority))

    def exec(self, payload: Any) -> ExecResult:
        state = dict(payload or {})
        batch = ToolBatch(tuple(self.executor.parse_tool_calls(state.get("assistant_message", {}))))
        context = get_current_context()
        if context is None:
            return "execute", state

        for hook in self.hooks:
            decision = hook.before_tool_batch(context, batch)
            if decision.action == "continue":
                continue
            results = _short_circuit_results(batch.calls, decision)
            _record_results(context, state, batch.calls, results)
            context.emit(
                "hook.decision",
                category="tool",
                action=decision.action,
                data={"hook": hook.name, "reason": decision.reason, "tool_call_id": decision.tool_call_id},
            )
            if decision.action == "suspend":
                data = decision.result if isinstance(decision.result, Mapping) else {"reason": decision.reason}
                context.emit("approval.pending", category="tool", action="suspend", data=data)
                return "suspend", state
            return "observed", state
        return "execute", state


class PostToolHookNode(Node):
    def __init__(self, executor: ToolExecutor, hooks: Sequence[PostToolHook]) -> None:
        super().__init__()
        self.executor = executor
        self.hooks = tuple(sorted(hooks, key=lambda hook: hook.priority))

    def exec(self, payload: Any) -> ExecResult:
        state = dict(payload or {})
        batch = ToolBatch(tuple(self.executor.parse_tool_calls(state.get("assistant_message", {}))))
        results = tuple(result for result in state.get("tool_results", []) if isinstance(result, ToolResult))
        context = get_current_context()
        if context is None:
            return "guard", state

        feedback: list[str] = []
        for hook in self.hooks:
            decision = hook.after_tool_batch(context, batch, results)
            if decision.action == "continue":
                continue
            context.emit(
                "hook.decision",
                category="tool",
                action=decision.action,
                data={"hook": hook.name, "reason": decision.reason, **dict(decision.data or {})},
            )
            if decision.action == "suspend":
                context.emit("approval.pending", category="tool", action="suspend", data=dict(decision.data or {}))
                return "suspend", state
            if decision.action == "halt":
                context.metadata[GUARD_STOP_REASON] = "no_progress"
                context.add_message(
                    "system",
                    "Loop guard: repeated tool calls continued after a correction. Do not call more tools. "
                    "Return the best supported answer, state unresolved items, and stop.",
                    friday_internal=True,
                )
                state["chat_kwargs"] = {**dict(state.get("chat_kwargs", {}) or {}), "tool_choice": "none"}
                return "chat", state
            feedback.append(decision.reason)

        if feedback:
            context.add_message("system", "\n".join(feedback), friday_internal=True)
        return "guard", state


def reset_no_progress(context: RunContext) -> None:
    context.metadata[NO_PROGRESS_STATE] = {"rounds": [], "warned": {}}


def inherit_no_progress(target: RunContext, source: RunContext) -> None:
    value = source.metadata.get(NO_PROGRESS_STATE)
    if not isinstance(value, dict):
        reset_no_progress(target)
        return
    target.metadata[NO_PROGRESS_STATE] = json.loads(json.dumps(value, ensure_ascii=False))


def _round_entries(calls: Sequence[ToolCall], results: Sequence[ToolResult]) -> list[dict[str, str]]:
    result_by_id = {result.tool_call_id: result for result in results}
    entries = []
    for call in calls:
        result = result_by_id.get(call.id)
        if result is None:
            continue
        canonical = json.dumps(
            {"name": call.name, "arguments": call.arguments},
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        )
        outcome = json.dumps(
            {"is_error": result.is_error, "content": result.content},
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        entries.append(
            {
                "call": _digest(canonical),
                "result": _digest(outcome),
                "summary": clip(canonical, 500),
            }
        )
    return entries


def _collapse_round(entries: Sequence[dict[str, str]]) -> dict[str, dict[str, Any]]:
    grouped: dict[str, list[dict[str, str]]] = {}
    for entry in entries:
        grouped.setdefault(entry["call"], []).append(entry)
    collapsed = {}
    for signature, items in grouped.items():
        result_hashes = {item["result"] for item in items}
        collapsed[signature] = {
            "occurrences": len(items),
            "result": next(iter(result_hashes)) if len(result_hashes) == 1 else "",
            "scope": "round",
            "summary": items[-1]["summary"],
        }
    return collapsed


def _batch_repetitions(entries: Sequence[dict[str, str]]) -> dict[str, dict[str, Any]]:
    counts = Counter(entry["call"] for entry in entries)
    repeated = {}
    for signature, count in counts.items():
        if count < NO_PROGRESS_REPEAT_LIMIT:
            continue
        items = [entry for entry in entries if entry["call"] == signature]
        repeated[signature] = {
            "occurrences": count,
            "result": items[-1]["result"],
            "scope": "batch",
            "summary": items[-1]["summary"],
        }
    return repeated


def _round_repetitions(rounds: Sequence[Mapping[str, dict[str, Any]]]) -> dict[str, dict[str, Any]]:
    if len(rounds) < NO_PROGRESS_WINDOW:
        return {}
    common = set(rounds[0])
    for round_entries in rounds[1:]:
        common.intersection_update(round_entries)
    repeated = {}
    for signature in common:
        items = [round_entries[signature] for round_entries in rounds]
        results = {str(item.get("result") or "") for item in items}
        if "" in results or len(results) != 1:
            continue
        repeated[signature] = {
            "occurrences": NO_PROGRESS_WINDOW,
            "result": items[-1]["result"],
            "scope": "rounds",
            "summary": items[-1]["summary"],
        }
    return repeated


def _decision_details(
    repeated: Mapping[str, Mapping[str, Any]],
    *,
    scope: str | None = None,
) -> list[dict[str, Any]]:
    return [
        {
            "call": item.get("summary", ""),
            "occurrences": int(item.get("occurrences", 1)),
            "scope": scope or str(item.get("scope") or "rounds"),
        }
        for item in repeated.values()
    ]


def _short_circuit_results(calls: Sequence[ToolCall], decision: PreToolDecision) -> list[ToolResult]:
    results = []
    for call in calls:
        if not decision.tool_call_id or call.id == decision.tool_call_id:
            value = decision.result or {"blocked": True, "message": decision.reason}
            is_error = decision.action == "deny"
        else:
            value = {
                "cancelled": True,
                "message": f"Tool batch was not executed because another call was blocked ({decision.action}).",
            }
            is_error = decision.action == "deny"
        content = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
        results.append(ToolResult(tool_call_id=call.id, content=content, is_error=is_error, elapsed_ms=0.0))
    return results


def _record_results(
    context: RunContext,
    state: dict[str, Any],
    calls: Sequence[ToolCall],
    results: Sequence[ToolResult],
) -> None:
    for call in calls:
        context.emit(
            "tool.call",
            category="tool",
            data={"tool_call_id": call.id, "name": call.name, "arguments": call.arguments},
        )
    messages = list(state.get("history", []))
    for result in results:
        context.emit(
            "tool.result",
            category="tool",
            data={
                "tool_call_id": result.tool_call_id,
                "content": result.content,
                "is_error": result.is_error,
                "elapsed_ms": result.elapsed_ms,
            },
        )
        message = result.to_message()
        messages.append(message)
        context.add_message("tool", result.content, tool_call_id=result.tool_call_id)
    state["tool_results"] = list(results)
    state["history"] = messages


def _positive_int(value: Any, default: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()
