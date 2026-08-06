"""How a long conversation keeps running: the context compaction kernel.

Compaction fires exactly when the session is already under pressure, so it has
to hold three properties, in this order of importance:

1. It never fails the turn. An exception here ends the conversation at the
   moment it is most expensive to lose, so every step degrades instead of
   raising: the summary falls back to one Friday writes from its own state.
2. It always shrinks. A pass that leaves the context above the target makes the
   next turn compact again, and the session spends the rest of its life paying
   for compaction that buys nothing. The rebuilt body is sized against the
   measured overhead of the fresh prefix, not against a guess.
3. It never leaks model plumbing into the product. The summary is prose a user
   may read, so tool-call markup and fences are stripped and an unusable answer
   is rejected in favour of the deterministic one.

The summary is one tool-free model call over a rendered transcript rather than
an agent run. Running it through the tool loop coupled compaction to the loop
guard -- which fires by definition when the window is full -- and to the flow's
step budget, so a model that saved more than one memory entry aborted the whole
turn with a step-budget error.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path
from typing import Any

from agent_core import RunContext

from friday.config import ModelConfig, build_model, load_model_config, output_token_limit
from friday.context import content_text, context_window, estimate_tokens, token_estimate
from friday.memory import add_memory
from friday.progress import current_progress
from friday.prompts import COMPACT_PROMPT, COMPACT_SYSTEM_PROMPT
from friday.state import COMPACTION_ARTIFACT, archive_compacted, recent_turns
from friday.text import preview

LAST_COMPACTION = "friday.last_compaction"
# How much of the window a freshly compacted context may occupy. Compaction
# starts at 0.85, so landing anywhere near it would re-trigger immediately;
# the gap between the two is the room the next turns get to work in.
COMPACT_TARGET_RATIO = 0.55
# How many recent user turns to keep verbatim, tried largest first until the
# rebuilt context fits the target.
RECENT_TURN_STEPS = (10, 6, 3, 2, 1)
SUMMARY_MAX_TOKENS = 4000
SUMMARY_TRANSCRIPT_CHARS = 120_000
TRANSCRIPT_MESSAGE_CHARS = 2000
MEMORY_HEADING = "## Memory"
MEMORY_MAX_ITEMS = 12
SUMMARY_SECTIONS = (
    "## Current Goal",
    "## Completed",
    "## Open Items",
    "## Tried Methods",
    "## Decisions",
    "## Working Files",
    "## Commands And Results",
    "## Verification State",
    "## Next Steps",
)
# Tool calls a model wrote as text instead of through the function interface.
# Different providers spell it differently; all of them are noise in prose.
_TOOL_CALL_BLOCKS = re.compile(
    r"<(tool_call|tool_calls|function_calls|antml:function_calls|invoke|antml:invoke)\b[^>]*>.*?"
    r"</\1>|<\|tool_calls?_section_begin\|>.*?<\|tool_calls?_section_end\|>",
    re.DOTALL | re.IGNORECASE,
)
_TOOL_CALL_TAGS = re.compile(
    r"</?(tool_call|tool_calls|function_calls|antml:function_calls|invoke|antml:invoke|"
    r"parameter|antml:parameter|tool_response)\b[^>]*>|<\|tool_calls?_section_(?:begin|end)\|>|"
    r"<\|tool_call_(?:begin|end|argument_begin)\|>",
    re.IGNORECASE,
)
_TOOL_CALL_MARKERS = re.compile(
    r"<(?:antml:)?(?:tool_call|tool_calls|function_calls|invoke)\b|<\|tool_calls?_section_begin\|>",
    re.IGNORECASE,
)


@dataclass
class CompactionRecord:
    """What happened in one compaction, for the frontends and the trace."""

    kind: str = "conversation"
    ok: bool = True
    fallback: bool = False
    reason: str = ""
    before_tokens: int = 0
    after_tokens: int = 0
    window: int = 0
    kept_turns: int = 0
    tool_results: int = 0
    memories: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def notice(self) -> str:
        """One short line. The prefix before ':' is what the UIs label it with."""
        if self.kind == "tool_results":
            return f"tool results compacted: {self.tool_results}"
        if not self.ok:
            return f"conversation compaction skipped: {self.reason or 'unavailable'}"
        saved = f"{self.before_tokens} -> {self.after_tokens} tokens"
        suffix = " (offline summary)" if self.fallback else ""
        return f"conversation compacted: {saved}{suffix}"


def announce_compaction(
    context: RunContext,
    record: CompactionRecord,
    on_context_notice: Any = None,
) -> dict[str, Any]:
    """Report one compaction exactly once per host.

    Compaction silently drops conversation the user can still see scrolled up,
    so it is a first-class event rather than something to infer from the model
    suddenly forgetting things. Hosts that subscribe to the event stream (the
    gateway) read it there; hosts that do not (the CLI) get the callback.
    """
    payload = {**record.to_dict(), "notice": record.notice()}
    context.emit("context.compacted", category="context", action=record.kind, data=payload)
    if on_context_notice is not None:
        on_context_notice(payload)
    return payload


def compaction_record(value: Any) -> CompactionRecord:
    """Rebuild a record from stored metadata, ignoring keys it does not know.

    Records travel through context metadata and event payloads, which pick up
    extra keys on the way; reading one back must not depend on that shape.
    """
    known = {item.name for item in fields(CompactionRecord)}
    data = {key: item for key, item in value.items() if key in known} if isinstance(value, Mapping) else {}
    return CompactionRecord(**data)


def summarize_conversation(context: RunContext, config: ModelConfig) -> str:
    """One tool-free model call that turns the conversation into session state.

    Raises on provider failure; the caller decides whether to fall back. No
    tools are advertised, so the model cannot emit a tool call and the loop
    guard is not involved. The call never streams: a compaction summary is
    bookkeeping, and streaming it would print it into the user's chat.
    """
    body = transcript(context.get_messages(), SUMMARY_TRANSCRIPT_CHARS)
    if not body.strip():
        return ""
    response = build_model(config).chat_message(
        [
            {"role": "system", "content": COMPACT_SYSTEM_PROMPT},
            {"role": "user", "content": f"{COMPACT_PROMPT}\n\n# Conversation\n\n{body}"},
        ],
        stream=False,
        **output_token_limit(config, SUMMARY_MAX_TOKENS),
    )
    context.record_model_usage(response.get("usage") if isinstance(response, Mapping) else None)
    return clean_summary(str(response.get("content") or "") if isinstance(response, Mapping) else "")


def compact_in_place(context: RunContext, *, tools: list[Any] | None = None) -> CompactionRecord:
    """Rewrite the running conversation so the run can continue instead of stopping.

    The between-turn path rebuilds the agent to pick up a fresh system prefix.
    Mid-run there is no safe moment to swap the agent the flow is executing, so
    only the conversation body is replaced, in the live message list, leaving the
    system prefix and the tool set exactly as the flow found them.

    Never raises. Compaction runs when the window is already under pressure, and
    an exception here would end the run at the point it is most expensive to lose.
    """
    window = context_window(context)
    before_tokens = token_estimate(context, tools)
    try:
        return _rewrite_conversation(context, tools=tools, window=window, before_tokens=before_tokens)
    except Exception as exc:
        return CompactionRecord(
            ok=False,
            reason=f"{type(exc).__name__}: {exc}",
            before_tokens=before_tokens,
            after_tokens=before_tokens,
            window=window,
        )


def _rewrite_conversation(
    context: RunContext,
    *,
    tools: list[Any] | None,
    window: int,
    before_tokens: int,
) -> CompactionRecord:
    messages = context.get_messages()
    prefix = _system_prefix(messages)
    body = messages[len(prefix) :]
    summary, fallback, reason = summary_or_fallback(context, model_config(context))
    summary, facts = split_memory_section(summary)

    overhead = before_tokens - estimate_tokens(_body_text(body))
    budget = int(window * COMPACT_TARGET_RATIO) - overhead - estimate_tokens(summary)
    recent, kept = fit_recent_steps(body, budget_tokens=max(budget, 0))
    if not recent:
        return CompactionRecord(
            ok=False,
            reason="the run has no completed step to replay",
            before_tokens=before_tokens,
            after_tokens=before_tokens,
            window=window,
        )

    # The prompt loses these; the session does not. Archive before rewriting.
    archive_compacted(context, body[: len(body) - len(recent)])

    replacement = [{"role": "assistant", "content": f"## Session Summary\n{summary.strip()}", COMPACTION_ARTIFACT: True}]
    request = _continuation_request(context, body)
    if request is not None:
        replacement.append(request)
    # Slice assignment keeps the list the flow is holding; rebinding it would
    # leave the running model node reading the conversation Friday just dropped.
    messages[len(prefix) :] = [*replacement, *recent]

    return CompactionRecord(
        fallback=fallback,
        reason=reason,
        before_tokens=before_tokens,
        after_tokens=token_estimate(context, tools),
        window=window,
        kept_turns=kept,
        memories=_remember(context, facts),
    )


def model_config(context: RunContext) -> ModelConfig:
    """The model settings the run is using, falling back to the stored config."""
    stored = context.metadata.get("friday.model_config")
    if isinstance(stored, Mapping):
        try:
            return ModelConfig(**dict(stored))
        except TypeError:
            pass
    return load_model_config(Path(str(context.metadata.get("workspace") or ".")))


def summary_or_fallback(context: RunContext, config: ModelConfig) -> tuple[str, bool, str]:
    """The written summary, or the one Friday assembles when that is not usable."""
    try:
        summary = summarize_conversation(context, config)
    except Exception as exc:
        reason = f"{type(exc).__name__}: {exc}"
        return fallback_summary(context, reason=type(exc).__name__), True, reason
    if not summary_is_usable(summary):
        reason = "the model did not return session state"
        return fallback_summary(context, reason=reason), True, reason
    return summary, False, ""


def _system_prefix(messages: Sequence[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    """The leading system messages, which describe Friday rather than the work."""
    end = 0
    while end < len(messages) and messages[end].get("role") == "system":
        end += 1
    return list(messages[:end])


def _continuation_request(context: RunContext, body: Sequence[Mapping[str, Any]]) -> dict[str, Any] | None:
    """The request the run is serving, replayed so the goal survives the rewrite."""
    for message in body:
        if message.get("role") == "user" and not message.get("friday_internal"):
            return {"role": "user", "content": message.get("content"), COMPACTION_ARTIFACT: True}
    text = str(context.metadata.get("friday.user_request") or "").strip()
    return {"role": "user", "content": text, COMPACTION_ARTIFACT: True} if text else None


def _remember(context: RunContext, facts: list[str]) -> list[str]:
    """Persist the summary's memory candidates; a rejected fact is not fatal."""
    workspace = str(context.metadata.get("workspace") or "").strip()
    if not facts or not workspace:
        return []
    session_id = str(context.metadata.get("session_id") or "")
    saved = []
    for fact in facts:
        try:
            add_memory(Path(workspace), "episode", fact, source="compaction", session_id=session_id)
        except (OSError, ValueError):
            continue
        saved.append(fact)
    return saved


def clean_summary(raw: str) -> str:
    """Strip tool-call markup and fences so the summary reads as prose."""
    text = _TOOL_CALL_BLOCKS.sub("", raw)
    text = _TOOL_CALL_TAGS.sub("", text)
    text = re.sub(r"^\s*```[a-zA-Z0-9_-]*\s*$", "", text, flags=re.MULTILINE)
    return "\n".join(line.rstrip() for line in text.splitlines()).strip()


def summary_is_usable(text: str) -> bool:
    """True when the reply is session state rather than junk or a refusal."""
    if len(text.strip()) < 40 or _TOOL_CALL_MARKERS.search(text):
        return False
    return any(section in text for section in SUMMARY_SECTIONS)


def split_memory_section(summary: str) -> tuple[str, list[str]]:
    """Separate the memory candidates from the state Friday keeps in context.

    Memory belongs on disk, not in the next prompt, so the section is removed
    from the summary that gets replayed.
    """
    lines = summary.splitlines()
    start = next((index for index, line in enumerate(lines) if line.strip() == MEMORY_HEADING), None)
    if start is None:
        return summary.strip(), []
    end = next(
        (index for index in range(start + 1, len(lines)) if lines[index].startswith("## ")),
        len(lines),
    )
    facts = []
    for line in lines[start + 1 : end]:
        item = line.strip()
        if not item.startswith(("- ", "* ")):
            continue
        fact = " ".join(item[2:].split()).strip()
        if fact and fact.lower() not in {"none", "(none)", "n/a"}:
            facts.append(fact)
    remainder = "\n".join([*lines[:start], *lines[end:]]).strip()
    return remainder, facts[:MEMORY_MAX_ITEMS]


def fallback_summary(context: RunContext, *, reason: str = "") -> str:
    """Session state assembled from what Friday owns, with no model involved.

    This is what keeps a session alive when the provider is down or answers
    with something unusable: less detail than a written summary, but the goal,
    the plan, and the files in play survive the rebuild.
    """
    progress = current_progress(context)
    messages = context.get_messages()
    objective = str(progress.get("objective") or context.metadata.get("friday.user_request") or "").strip()
    requests = [
        preview(content_text(message.get("content")), 300)
        for message in messages
        if message.get("role") == "user" and not message.get("friday_internal")
    ]
    steps = progress.get("steps") if isinstance(progress.get("steps"), list) else []
    completed = [str(step.get("step") or "") for step in steps if step.get("status") == "completed"]
    open_items = [str(step.get("step") or "") for step in steps if step.get("status") != "completed"]

    lines = [
        "## Current Goal",
        objective or (requests[-1] if requests else "Continue the current request."),
        "",
        "## Completed",
        *(f"- {item}" for item in completed[-12:]),
        "",
        "## Open Items",
        *(f"- {item}" for item in open_items[-12:]),
        "",
        "## Working Files",
        *(f"- {path}" for path in _touched_paths(messages)),
        "",
        "## Next Steps",
        str(progress.get("next_action") or "").strip() or "Re-read the recent turns below and continue.",
        "",
        "## Verification State",
        f"status: {progress.get('status') or 'working'}",
        "",
        "Friday wrote this summary locally because the compaction model call did not produce one"
        + (f" ({reason})" if reason else "")
        + ". Earlier detail beyond the turns replayed below was dropped.",
    ]
    return "\n".join(lines).strip()


def transcript(messages: Sequence[Mapping[str, Any]], budget_chars: int) -> str:
    """Render the conversation as plain text the summarizer can safely read.

    Replaying raw messages would carry the tool-call/tool-result pairing, the
    tool schemas, and the provider's own validation rules into a request that
    is already near the window. A transcript has none of that and its size is
    ours to control.
    """
    rows = [row for message in messages if (row := _transcript_row(message))]
    if not rows:
        return ""
    head, rest = rows[:2], rows[2:]
    used = sum(len(row) for row in head)
    tail: list[str] = []
    for row in reversed(rest):
        if used + len(row) > budget_chars:
            break
        tail.append(row)
        used += len(row)
    tail.reverse()
    dropped = len(rest) - len(tail)
    middle = [f"[... {dropped} earlier messages omitted ...]"] if dropped > 0 else []
    return "\n\n".join([*head, *middle, *tail])


def fit_recent_turns(
    messages: Sequence[Mapping[str, Any]],
    *,
    budget_tokens: int,
) -> tuple[list[dict[str, Any]], int]:
    """Largest verbatim tail that fits the budget, and how many turns that was.

    The smallest step is returned even when it does not fit: some live context
    always beats none, and the loop guard covers what is left.
    """
    selected: list[dict[str, Any]] = []
    kept = RECENT_TURN_STEPS[-1]
    for limit in RECENT_TURN_STEPS:
        candidate = _repair_body(list(recent_turns(list(messages), limit)))
        if not candidate:
            continue
        selected, kept = candidate, limit
        if estimate_tokens(_body_text(candidate)) <= budget_tokens:
            return candidate, limit
    return selected, kept


def fit_recent_steps(
    messages: Sequence[Mapping[str, Any]],
    *,
    budget_tokens: int,
) -> tuple[list[dict[str, Any]], int]:
    """Largest trailing run of complete tool cycles that fits the budget.

    Turn-based selection cannot shrink a long single-turn run: one user message
    means one turn, so its tail is the entire run. Mid-run the unit that
    actually repeats is the assistant/tool cycle, so that is what gets counted.

    A cycle is never split. Every candidate starts at an assistant message, which
    keeps two provider rules satisfied at once: no tool result is left without
    the call that produced it, and the replayed body can follow the summary and
    the request without two same-role messages meeting. The newest cycle is kept
    even when it alone exceeds the budget.
    """
    body = [dict(message) for message in messages if isinstance(message, Mapping)]
    starts = [index for index, message in enumerate(body) if message.get("role") == "assistant"]
    if not starts:
        return [], 0
    selected, kept = body[starts[-1] :], 1
    for count, index in enumerate(reversed(starts), start=1):
        candidate = body[index:]
        if estimate_tokens(_body_text(candidate)) > budget_tokens:
            break
        selected, kept = candidate, count
    return selected, kept


def _repair_body(body: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop leading tool results that lost the assistant message calling them.

    A conversation body may only start with a user or assistant message;
    providers reject a tool result with nothing to attach it to.
    """
    start = 0
    while start < len(body) and body[start].get("role") == "tool":
        start += 1
    return body[start:]


def _body_text(messages: Sequence[Mapping[str, Any]]) -> str:
    return "\n".join(content_text(message.get("content")) for message in messages)


def _transcript_row(message: Mapping[str, Any]) -> str:
    role = str(message.get("role") or "")
    if role not in {"user", "assistant", "tool"}:
        return ""
    text = content_text(message.get("content")).strip()
    names = _tool_call_names(message.get("tool_calls"))
    if names:
        text = f"{text}\n[called {', '.join(names)}]".strip()
    if not text:
        return ""
    label = "tool result" if role == "tool" else role
    return f"### {label}\n{_clip_middle(text, TRANSCRIPT_MESSAGE_CHARS)}"


def _tool_call_names(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    names = []
    for item in value:
        function = item.get("function") if isinstance(item, Mapping) else None
        name = function.get("name") if isinstance(function, Mapping) else None
        if isinstance(name, str) and name:
            names.append(name)
    return names


def _clip_middle(text: str, limit: int) -> str:
    """Keep both ends: a tool result's verdict is usually at the bottom."""
    if len(text) <= limit:
        return text
    head = limit * 2 // 3
    tail = limit - head
    return f"{text[:head]}\n[... {len(text) - limit} characters omitted ...]\n{text[-tail:]}"


def _touched_paths(messages: Sequence[Mapping[str, Any]]) -> list[str]:
    paths: list[str] = []
    for message in messages:
        for item in message.get("tool_calls") or []:
            function = item.get("function") if isinstance(item, Mapping) else None
            if not isinstance(function, Mapping) or function.get("name") not in {"Edit", "Read", "Write"}:
                continue
            match = re.search(r'"path"\s*:\s*"((?:[^"\\]|\\.)*)"', str(function.get("arguments") or ""))
            if match:
                paths.append(Path(match.group(1).encode().decode("unicode_escape")).as_posix())
    return list(dict.fromkeys(reversed(paths)))[:15]
