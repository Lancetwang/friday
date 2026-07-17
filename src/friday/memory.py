from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any

USER_LIMIT = 1500
MEMORY_LIMIT = 2500
EPISODE_LIMIT = 2000
MEMORY_SCOPES = ("user", "global", "project", "episode")

_META_RE = re.compile(r"^<!-- friday-memory (\{.*\}) -->$")
_SECRET_RE = re.compile(
    r"(?i)(?:api[_ -]?key|password|passwd|secret|access[_ -]?token)\s*[:=]\s*\S+"
    r"|\b(?:sk-|hf_|tvly-|as_sk_)[A-Za-z0-9_-]{8,}"
)
_CAPTURE_RE = re.compile(
    r"记住|以后|今后|别再|不要再|我(?:更)?(?:喜欢|偏好|倾向|习惯)|我不喜欢|"
    r"我叫|我的名字是|纠正一下|不是.{0,80}而是|"
    r"(?i:\bremember\b|from now on|\bi (?:prefer|like|dislike|usually|tend)\b|"
    r"my name is|don't do that again|do not do that again)"
)
_HOT_USER_RE = re.compile(
    r"我(?:更)?(?:喜欢|不喜欢|偏好|倾向|习惯)|我叫|我的名字是|记住我的|"
    r"(?:默认|请).{0,30}(?:中文|英文).{0,20}(?:回答|回复|交流)|"
    r"我是.{0,30}(?:开发者|工程师|学生|研究员|作者|产品经理|设计师)|"
    r"(?i:\bi (?:prefer|like|dislike|usually|tend)\b|my name is|"
    r"\bi am (?:an? )?(?:developer|engineer|student|researcher|writer|designer)\b)"
)
_TRANSIENT_PROFILE_RE = re.compile(r"这个|这种|本次|当前|这次|(?i:\bthis\b|\bthat\b|current task|this time)")


def memory_status(workspace: Path, *, home: Path | None = None) -> dict[str, Any]:
    root = workspace.resolve()
    records = list_memories(root, home=home)
    counts = {scope: sum(item["scope"] == scope for item in records) for scope in MEMORY_SCOPES}
    paths = _scope_paths(root, home)
    return {
        "counts": counts,
        "chars": {
            scope: sum(len(path.read_text(encoding="utf-8")) for path in scope_paths if path.exists())
            for scope, scope_paths in paths.items()
        },
        "paths": {scope: [str(path) for path in scope_paths] for scope, scope_paths in paths.items()},
    }


def list_memories(workspace: Path, *, scope: str = "all", home: Path | None = None) -> list[dict[str, Any]]:
    if scope != "all" and scope not in MEMORY_SCOPES:
        raise ValueError(f"Unknown memory scope: {scope}")
    return [_public_record(record) for record in _all_entries(workspace.resolve(), scope, home)]


def _all_entries(workspace: Path, scope: str, home: Path | None) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for current_scope, paths in _scope_paths(workspace.resolve(), home).items():
        if scope not in {"all", current_scope}:
            continue
        for path in paths:
            records.extend(_read_entries(path, current_scope))
    return records


def add_memory(
    workspace: Path,
    scope: str,
    content: str,
    *,
    home: Path | None = None,
    source: str = "cli",
    session_id: str = "",
    now: datetime | None = None,
) -> dict[str, Any]:
    text = _clean_content(content)
    if scope not in MEMORY_SCOPES:
        raise ValueError(f"Unknown memory scope: {scope}")
    if not text:
        raise ValueError("Memory content is required.")
    if len(text) > EPISODE_LIMIT:
        raise ValueError(f"Memory entry exceeds {EPISODE_LIMIT} characters.")
    if _SECRET_RE.search(text):
        raise ValueError("Memory content appears to contain a secret or credential.")

    existing = list_memories(workspace, scope=scope, home=home)
    duplicate = next((item for item in existing if _normalize(item["content"]) == _normalize(text)), None)
    if duplicate:
        return {**duplicate, "duplicate": True}

    timestamp = now or datetime.now()
    path, limit = _write_target(workspace.resolve(), scope, home, timestamp)
    record_id = hashlib.sha256(f"{scope}\0{text}".encode("utf-8")).hexdigest()[:12]
    metadata = {
        "id": record_id,
        "source": source,
        "created": timestamp.isoformat(timespec="seconds"),
    }
    if session_id:
        metadata["session"] = session_id
    header = _header(scope, timestamp)
    current = path.read_text(encoding="utf-8") if path.exists() else header
    entry = f"- {text}\n<!-- friday-memory {json.dumps(metadata, ensure_ascii=False, separators=(',', ':'))} -->\n"
    updated = current.rstrip() + "\n\n" + entry
    if limit is not None and len(updated) > limit:
        raise ValueError(f"{scope} memory would exceed {limit} characters; update or remove old entries first.")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(updated, encoding="utf-8")
    return {"id": record_id, "scope": scope, "content": text, "path": str(path), "source": source}


def update_memory(workspace: Path, record_id: str, content: str, *, home: Path | None = None) -> dict[str, Any]:
    text = _clean_content(content)
    if not text:
        raise ValueError("Memory content is required.")
    if len(text) > EPISODE_LIMIT:
        raise ValueError(f"Memory entry exceeds {EPISODE_LIMIT} characters.")
    if _SECRET_RE.search(text):
        raise ValueError("Memory content appears to contain a secret or credential.")
    record = _find_memory(workspace.resolve(), record_id, home)
    duplicate = next(
        (
            item
            for item in list_memories(workspace, scope=record["scope"], home=home)
            if item["id"] != record_id and _normalize(item["content"]) == _normalize(text)
        ),
        None,
    )
    if duplicate:
        raise ValueError(f"Memory already exists as id={duplicate['id']}.")
    metadata = dict(record["metadata"])
    metadata["id"] = record["id"]
    metadata["updated"] = datetime.now().isoformat(timespec="seconds")
    replacement = [
        f"- {text}",
        f"<!-- friday-memory {json.dumps(metadata, ensure_ascii=False, separators=(',', ':'))} -->",
    ]
    _replace_entry(record, replacement)
    return _public_record({**record, "content": text, "metadata": metadata})


def remove_memory(workspace: Path, record_id: str, *, home: Path | None = None) -> dict[str, Any]:
    record = _find_memory(workspace.resolve(), record_id, home)
    _replace_entry(record, [])
    return {"id": record["id"], "scope": record["scope"], "removed": True, "content": record["content"]}


def search_memories(
    workspace: Path,
    query: str,
    *,
    scope: str = "all",
    max_results: int = 5,
    home: Path | None = None,
) -> list[dict[str, Any]]:
    # ponytail: scan Markdown directly until measured history size justifies a rebuildable index.
    query = _clean_content(query)
    if not query:
        return []
    scored = []
    for record in list_memories(workspace, scope=scope, home=home):
        score = _score(query, record["content"])
        if score >= 1.0:
            scored.append({**record, "score": round(score, 3)})
    return sorted(scored, key=lambda item: (-item["score"], item["path"]))[: max(1, min(max_results, 20))]


def capture_user_memory(
    workspace: Path,
    text: str,
    *,
    session_id: str = "",
    home: Path | None = None,
) -> dict[str, Any] | None:
    # ponytail: lexical capture stays intentionally conservative; add configurable
    # patterns only after real false-positive/false-negative traces justify them.
    if not _CAPTURE_RE.search(text) or _SECRET_RE.search(text):
        return None
    episode = add_memory(workspace, "episode", text, home=home, source="user", session_id=session_id)
    promoted = []
    for fact in _hot_user_facts(text):
        try:
            promoted.append(add_memory(workspace, "user", fact, home=home, source="user", session_id=session_id))
        except ValueError:
            # The dated evidence remains available even if the bounded hot profile is full.
            pass
    return {"episode": episode, "promoted": promoted}


def relevant_memory(workspace: Path, query: str, *, home: Path | None = None) -> str:
    results = search_memories(workspace, query, scope="episode", max_results=3, home=home)
    if not results:
        return ""
    lines = [
        "## Relevant Memory",
        "Background evidence only. The current user message wins if a memory is stale or conflicts.",
        "",
    ]
    used = 0
    for item in results:
        line = f"- [{Path(item['path']).stem}] {item['content']}"
        if used + len(line) > 2000:
            break
        lines.append(line)
        used += len(line)
    return "\n".join(lines) if len(lines) > 3 else ""


def memory_help() -> str:
    return """Memory commands:
  status                         Show memory counts, sizes, and files.
  list [user|global|project|episode|all]
  search <query>                 Search Markdown memory.
  add <scope> <text>             Store one durable fact or episode.
  update <id> <text>             Replace an existing entry.
  remove <id>                    Forget an entry.

Use `friday memory <command> --help` for CLI flags. Current task progress is not memory."""


def format_memory_result(value: dict[str, Any] | str) -> str:
    if isinstance(value, str):
        return value
    if "counts" in value:
        lines = ["# Memory status", "", "| Scope | Entries | Characters |", "| --- | ---: | ---: |"]
        for scope in MEMORY_SCOPES:
            lines.append(f"| {scope} | {value['counts'][scope]} | {value['chars'][scope]} |")
        return "\n".join(lines)
    if "memories" in value:
        memories = value["memories"]
        if not memories:
            return "No matching memory."
        lines = ["# Memories", ""]
        lines.extend(f"- `{item['id']}` [{item['scope']}] {item['content']}" for item in memories)
        return "\n".join(lines)
    if value.get("removed"):
        return f"Removed memory `{value['id']}`: {value['content']}"
    if value.get("id"):
        suffix = " (already present)" if value.get("duplicate") else ""
        return f"Saved memory `{value['id']}` [{value['scope']}]{suffix}: {value['content']}"
    return json.dumps(value, ensure_ascii=False, indent=2)


def run_memory_command(command: str, workspace: Path, *, home: Path | None = None) -> dict[str, Any] | str:
    words = command.strip().split()
    if not words or words[0] in {"help", "--help", "-h"}:
        return memory_help()
    action = words[0].lower()
    if action == "status":
        return memory_status(workspace, home=home)
    if action == "list":
        return {"memories": list_memories(workspace, scope=words[1] if len(words) > 1 else "all", home=home)}
    if action == "search":
        return {"memories": search_memories(workspace, " ".join(words[1:]), home=home)}
    if action == "add" and len(words) >= 3:
        return add_memory(workspace, words[1], " ".join(words[2:]), home=home)
    if action == "update" and len(words) >= 3:
        return update_memory(workspace, words[1], " ".join(words[2:]), home=home)
    if action == "remove" and len(words) == 2:
        return remove_memory(workspace, words[1], home=home)
    raise ValueError(memory_help())


def _scope_paths(workspace: Path, home: Path | None) -> dict[str, list[Path]]:
    user_dir = (home or Path.home()) / ".friday"
    episodes = user_dir / "memory"
    return {
        "user": [user_dir / "USER.md"],
        "global": [user_dir / "MEMORY.md"],
        "project": [workspace / ".friday" / "MEMORY.md"],
        "episode": sorted(episodes.glob("*.md")) if episodes.exists() else [],
    }


def _write_target(workspace: Path, scope: str, home: Path | None, now: datetime) -> tuple[Path, int | None]:
    paths = _scope_paths(workspace, home)
    if scope == "episode":
        return (home or Path.home()) / ".friday" / "memory" / f"{now.date().isoformat()}.md", None
    limits = {"user": USER_LIMIT, "global": MEMORY_LIMIT, "project": MEMORY_LIMIT}
    return paths[scope][0], limits[scope]


def _read_entries(path: Path, scope: str) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    lines = path.read_text(encoding="utf-8").splitlines()
    records = []
    for index, line in enumerate(lines):
        if not line.startswith("- "):
            continue
        content = line[2:].strip()
        metadata: dict[str, Any] = {}
        meta_index = None
        if index + 1 < len(lines):
            match = _META_RE.match(lines[index + 1].strip())
            if match:
                try:
                    metadata = json.loads(match.group(1))
                    meta_index = index + 1
                except json.JSONDecodeError:
                    metadata = {}
        record_id = str(metadata.get("id") or hashlib.sha256(f"{scope}\0{content}".encode("utf-8")).hexdigest()[:12])
        records.append(
            {
                "id": record_id,
                "scope": scope,
                "content": content,
                "path": str(path),
                "source": str(metadata.get("source") or "manual"),
                "metadata": metadata,
                "_line": index,
                "_meta_line": meta_index,
            }
        )
    return records


def _find_memory(workspace: Path, record_id: str, home: Path | None) -> dict[str, Any]:
    matches = [item for item in _all_entries(workspace, "all", home) if item["id"] == record_id]
    if len(matches) != 1:
        raise ValueError(f"Expected one memory id={record_id}, found {len(matches)}.")
    return matches[0]


def _replace_entry(record: dict[str, Any], replacement: list[str]) -> None:
    path = Path(record["path"])
    lines = path.read_text(encoding="utf-8").splitlines()
    end = record["_meta_line"] + 1 if record["_meta_line"] is not None else record["_line"] + 1
    lines[record["_line"] : end] = replacement
    updated = "\n".join(lines).rstrip() + "\n"
    limit = USER_LIMIT if record["scope"] == "user" else MEMORY_LIMIT if record["scope"] in {"global", "project"} else None
    if limit is not None and len(updated) > limit:
        raise ValueError(f"{record['scope']} memory would exceed {limit} characters; shorten the replacement first.")
    path.write_text(updated, encoding="utf-8")


def _public_record(record: dict[str, Any]) -> dict[str, Any]:
    result = {key: record[key] for key in ("id", "scope", "content", "path", "source")}
    for key in ("created", "updated", "session"):
        if record["metadata"].get(key):
            result[key] = record["metadata"][key]
    return result


def _header(scope: str, now: datetime) -> str:
    if scope == "user":
        return "# User Profile\n"
    if scope == "global":
        return "# User Memory\n"
    if scope == "project":
        return "# Project Memory\n"
    return f"# {now.date().isoformat()}\n"


def _clean_content(text: str) -> str:
    return " ".join(str(text).split()).strip()


def _hot_user_facts(text: str) -> list[str]:
    facts = []
    for sentence in re.split(r"(?<=[。！？.!?])|[\r\n]+", text):
        sentence = _clean_content(sentence)
        if sentence and len(sentence) <= 300 and _HOT_USER_RE.search(sentence) and not _TRANSIENT_PROFILE_RE.search(sentence):
            facts.append(sentence)
    return facts


def _normalize(text: str) -> str:
    return re.sub(r"[^\w\u3400-\u9fff]+", "", text.lower())


def _terms(text: str) -> set[str]:
    lowered = text.lower()
    words = {word for word in re.findall(r"[a-z0-9_+#.-]{2,}", lowered) if word not in {"the", "and", "for", "with"}}
    cjk_terms: set[str] = set()
    for chunk in re.findall(r"[\u3400-\u9fff]+", lowered):
        cjk_terms.update(chunk[index : index + 2] for index in range(max(0, len(chunk) - 1)))
    return words | cjk_terms


def _score(query: str, content: str) -> float:
    normalized_query = _normalize(query)
    normalized_content = _normalize(content)
    exact = 4.0 if len(normalized_query) >= 2 and normalized_query in normalized_content else 0.0
    query_terms = _terms(query)
    if not query_terms:
        return exact
    overlap = query_terms & _terms(content)
    return exact + 4.0 * len(overlap) / len(query_terms)
