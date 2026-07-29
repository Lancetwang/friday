from __future__ import annotations

import hashlib
import json
import re
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from friday.config import build_model, load_model_config, load_model_environment, output_token_limit
from friday.prompts import MEMORY_CONSOLIDATE_PROMPT, SECURITY_NOTES
from friday.storage import friday_home, project_state_dir

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
_PERMANENT_RE = re.compile(
    r"(?:永远|始终)(?:记住|记得|不要忘记)|永久(?:记住|保存)|"
    r"(?i:\balways remember\b|\bremember (?:this|that|it|me) forever\b|\bnever forget\b)"
)
_PROJECT_RE = re.compile(
    r"这个项目|当前项目|本项目|这个仓库|当前仓库|这个分支|"
    r"(?i:\bthis (?:project|repository|repo|branch|workspace)\b|\bcurrent (?:project|repository|repo|branch|workspace)\b)"
)
_HOT_USER_RE = re.compile(
    r"我(?:更)?(?:喜欢|不喜欢|偏好|倾向|习惯)|我叫|我的名字是|记住我的|"
    r"(?:默认|请).{0,30}(?:中文|英文).{0,20}(?:回答|回复|交流)|"
    r"我是.{0,30}(?:开发者|工程师|学生|研究员|作者|产品经理|设计师)|"
    r"(?i:\bi (?:prefer|like|dislike|usually|tend)\b|my name is|"
    r"\bi am (?:an? )?(?:developer|engineer|student|researcher|writer|designer)\b)"
)
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
    count: int = 1,
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

    timestamp = now or datetime.now()
    existing = list_memories(workspace, scope=scope, home=home)
    duplicate = next((item for item in existing if _normalize(item["content"]) == _normalize(text)), None)
    if duplicate:
        if scope == "episode":
            return _increment_episode(workspace.resolve(), duplicate["id"], max(1, count), timestamp, session_id, home)
        return {**duplicate, "duplicate": True}

    path, limit = _write_target(workspace.resolve(), scope, home, timestamp)
    record_id = hashlib.sha256(f"{scope}\0{text}".encode("utf-8")).hexdigest()[:12]
    metadata = {
        "id": record_id,
        "source": source,
        "created": timestamp.isoformat(timespec="seconds"),
    }
    if session_id:
        metadata["session"] = session_id
    if scope == "episode":
        metadata["count"] = max(1, count)
        metadata["workspaces"] = [str(workspace.resolve())]
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
    if _SECRET_RE.search(text):
        return None
    permanent_signal = _PERMANENT_RE.search(text)
    if permanent_signal:
        permanent = add_memory(
            workspace,
            _permanent_scope(text),
            text,
            home=home,
            source="user",
            session_id=session_id,
        )
        return {"episode": None, "promoted": [permanent]}
    if not _CAPTURE_RE.search(text):
        return None
    episode = add_memory(workspace, "episode", text, home=home, source="user", session_id=session_id)
    return {"episode": episode, "promoted": []}


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


def consolidate_memory(
    workspace: Path,
    *,
    days: int = 2,
    home: Path | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    if days < 1:
        raise ValueError("days must be a positive integer.")
    root = workspace.resolve()
    timestamp = now or datetime.now()
    episodes = _recent_episode_entries(root, days, home, timestamp.date())
    if not episodes:
        return {"reviewed": 0, "merged": 0, "promoted": 0, "remaining": 0}

    operations = _review_memory(root, episodes, home)
    candidate_ids = {record["id"] for record in episodes}
    used: set[str] = set()
    merged = promoted = 0
    for operation in operations:
        if not isinstance(operation, dict):
            continue
        source_ids = [
            str(record_id)
            for record_id in operation.get("source_ids", [])
            if str(record_id) in candidate_ids and str(record_id) not in used
        ]
        records = []
        for record_id in dict.fromkeys(source_ids):
            try:
                record = _find_memory(root, record_id, home)
            except ValueError:
                continue
            if record["scope"] == "episode":
                records.append(record)
        content = _clean_content(str(operation.get("content") or ""))
        if not records or not content or len(content) > EPISODE_LIMIT or _SECRET_RE.search(content):
            continue
        total_count = sum(_record_count(record) for record in records)
        action = str(operation.get("action") or "").lower()
        if action == "promote":
            scope = str(operation.get("scope") or "").lower()
            if total_count < 2 or scope not in {"user", "global", "project"}:
                continue
            if scope == "project" and any(_record_workspaces(record) != {root} for record in records):
                continue
            try:
                add_memory(root, scope, content, home=home, source="consolidation", now=timestamp)
            except ValueError:
                continue
            _remove_records(records)
            promoted += 1
        elif action == "merge" and (len(records) > 1 or _normalize(content) != _normalize(records[0]["content"])):
            _merge_episode_records(records, content, total_count, timestamp)
            merged += 1
        else:
            continue
        used.update(record["id"] for record in records)

    remaining = len(_recent_episode_entries(root, days, home, timestamp.date()))
    return {
        "reviewed": len(episodes),
        "merged": merged,
        "promoted": promoted,
        "remaining": remaining,
    }


def _review_memory(workspace: Path, episodes: list[dict[str, Any]], home: Path | None) -> list[dict[str, Any]]:
    load_model_environment(workspace, home=home)
    config = load_model_config(workspace, home=home)
    permanent = [record for record in _all_entries(workspace, "all", home) if record["scope"] != "episode"]
    payload = {
        "workspace": str(workspace),
        "episodes": [_public_record(record) for record in episodes],
        "permanent_memory": [_public_record(record) for record in permanent],
    }
    response = build_model(config).chat_message(
        [
            {"role": "system", "content": f"{SECURITY_NOTES}\n\n{MEMORY_CONSOLIDATE_PROMPT}"},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
        ],
        stream=False,
        **output_token_limit(config, 4000),
    )
    content = str(response.get("content") or "")
    start, end = content.find("{"), content.rfind("}")
    if start < 0 or end < start:
        raise ValueError("Memory consolidation model returned invalid JSON.")
    try:
        value = json.loads(content[start : end + 1])
    except json.JSONDecodeError as exc:
        raise ValueError("Memory consolidation model returned invalid JSON.") from exc
    operations = value.get("operations") if isinstance(value, dict) else None
    if not isinstance(operations, list):
        raise ValueError("Memory consolidation model did not return an operations list.")
    return operations


def memory_help() -> str:
    return """Memory commands:
  status                         Show memory counts, sizes, and files.
  list [user|global|project|episode|all]
  search <query>                 Search Markdown memory.
  add <scope> <text>             Store one durable fact or episode.
  update <id> <text>             Replace an existing entry.
  remove <id>                    Forget an entry.
  consolidate [--days N]         Merge and promote recent episodes with one LLM call.

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
        for item in memories:
            count = f" x{item['count']}" if item.get("count", 1) > 1 else ""
            lines.append(f"- `{item['id']}` [{item['scope']}]{count} {item['content']}")
        return "\n".join(lines)
    if "reviewed" in value:
        return (
            f"Consolidated {value['reviewed']} episodic notes: "
            f"{value['merged']} merged, {value['promoted']} promoted, {value['remaining']} remaining."
        )
    if value.get("removed"):
        return f"Removed memory `{value['id']}`: {value['content']}"
    if value.get("id"):
        suffix = ""
        if value.get("duplicate"):
            suffix = f" (count {value['count']})" if value.get("scope") == "episode" else " (already present)"
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
    if action == "consolidate":
        days = 2
        if "--days" in words:
            index = words.index("--days")
            if index + 1 >= len(words):
                raise ValueError("--days requires a positive integer.")
            days = int(words[index + 1])
        return consolidate_memory(workspace, days=days, home=home)
    raise ValueError(memory_help())


def _scope_paths(workspace: Path, home: Path | None) -> dict[str, list[Path]]:
    user_dir = friday_home(home)
    episodes = user_dir / "memory"
    project_paths = [project_state_dir(workspace, home) / "MEMORY.md"]
    legacy_project = workspace / ".friday" / "MEMORY.md"
    if legacy_project.exists():
        project_paths.append(legacy_project)
    return {
        "user": [user_dir / "USER.md"],
        "global": [user_dir / "MEMORY.md"],
        "project": project_paths,
        "episode": sorted(episodes.glob("*.md")) if episodes.exists() else [],
    }


def _write_target(workspace: Path, scope: str, home: Path | None, now: datetime) -> tuple[Path, int | None]:
    paths = _scope_paths(workspace, home)
    if scope == "episode":
        return friday_home(home) / "memory" / f"{now.date().isoformat()}.md", None
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


def _increment_episode(
    workspace: Path,
    record_id: str,
    increment: int,
    now: datetime,
    session_id: str,
    home: Path | None,
) -> dict[str, Any]:
    record = _find_memory(workspace, record_id, home)
    metadata = dict(record["metadata"])
    metadata["count"] = _record_count(record) + increment
    metadata["last_seen"] = now.isoformat(timespec="seconds")
    if session_id:
        metadata["last_session"] = session_id
    workspaces = _record_workspaces(record)
    workspaces.add(workspace.resolve())
    metadata["workspaces"] = sorted(str(path) for path in workspaces)
    _replace_entry(record, [f"- {record['content']}", _metadata_line(metadata)])
    return {**_public_record({**record, "metadata": metadata}), "duplicate": True}


def _recent_episode_entries(workspace: Path, days: int, home: Path | None, today: date) -> list[dict[str, Any]]:
    cutoff = today - timedelta(days=days - 1)
    records = []
    for record in _all_entries(workspace, "episode", home):
        try:
            observed = str(record["metadata"].get("last_seen") or record["metadata"].get("created") or Path(record["path"]).stem)
            recorded = date.fromisoformat(observed[:10])
        except (TypeError, ValueError):
            continue
        if recorded >= cutoff:
            records.append(record)
    return records


def _merge_episode_records(records: list[dict[str, Any]], content: str, count: int, now: datetime) -> None:
    primary, rest = records[0], records[1:]
    workspaces = set().union(*(_record_workspaces(record) for record in records))
    metadata = dict(primary["metadata"])
    metadata.update(
        id=hashlib.sha256(f"episode\0{content}".encode("utf-8")).hexdigest()[:12],
        count=max(1, count),
        consolidated=now.isoformat(timespec="seconds"),
        workspaces=sorted(str(path) for path in workspaces),
    )
    _replace_entry(primary, [f"- {content}", _metadata_line(metadata)])
    _remove_records(rest)


def _remove_records(records: list[dict[str, Any]]) -> None:
    by_path: dict[str, list[dict[str, Any]]] = {}
    for record in records:
        by_path.setdefault(record["path"], []).append(record)
    for grouped in by_path.values():
        for record in sorted(grouped, key=lambda item: item["_line"], reverse=True):
            _replace_entry(record, [])


def _record_count(record: dict[str, Any]) -> int:
    value = record.get("metadata", {}).get("count", 1)
    return max(1, value) if isinstance(value, int) and not isinstance(value, bool) else 1


def _record_workspaces(record: dict[str, Any]) -> set[Path]:
    metadata = record.get("metadata", {})
    values = metadata.get("workspaces")
    if not isinstance(values, list):
        values = [metadata.get("workspace")] if metadata.get("workspace") else []
    return {Path(str(value)).resolve() for value in values if str(value).strip()}


def _metadata_line(metadata: dict[str, Any]) -> str:
    return f"<!-- friday-memory {json.dumps(metadata, ensure_ascii=False, separators=(',', ':'))} -->"


def _permanent_scope(text: str) -> str:
    if _PROJECT_RE.search(text):
        return "project"
    if _HOT_USER_RE.search(text):
        return "user"
    return "global"


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
    result["count"] = _record_count(record)
    for key in ("created", "updated", "session", "last_seen", "last_session", "workspace", "workspaces"):
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
