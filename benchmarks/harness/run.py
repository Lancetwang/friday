"""Small, deterministic local benchmark for Friday's shared Harness session."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
from datetime import datetime
from pathlib import Path
from typing import Any

from friday.session import FridaySession
from friday.state import conversation_body, fork_session, read_session, session_path
from friday.tools import pending_approval

ROOT = Path(__file__).resolve().parent
CASES_PATH = ROOT / "cases.jsonl"
RUNS_DIR = ROOT / "runs"
SOURCE_HOME = Path(os.getenv("FRIDAY_HOME") or Path.home() / ".friday").expanduser().resolve()
CONFIG_FILES = ("config.json", "models.json", "model-credentials.json", "web-credentials.json", ".env")
ACTIONS = {"chat", "goal", "approve", "reject", "assert_pending", "compact", "resume", "undo", "fork"}
CHECKS = {
    "file_exists",
    "file_absent",
    "file_equals",
    "file_contains",
    "file_not_contains",
    "json_equals",
    "python",
    "response_contains",
    "response_not_contains",
}


def load_cases(path: Path = CASES_PATH) -> list[dict[str, Any]]:
    cases = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    validate_cases(cases)
    return cases


def validate_cases(cases: list[dict[str, Any]]) -> None:
    if not cases:
        raise ValueError("Harness benchmark requires at least one case.")
    ids: set[str] = set()
    for case in cases:
        case_id = str(case.get("id") or "")
        if not case_id or case_id in ids:
            raise ValueError(f"Invalid or duplicate case id: {case_id!r}")
        ids.add(case_id)
        if not case.get("category") or not isinstance(case.get("steps"), list) or not case["steps"]:
            raise ValueError(f"{case_id}: category and steps are required.")
        for relative in case.get("files", {}):
            _safe_relative(relative)
        for step in case["steps"]:
            if step.get("action") not in ACTIONS:
                raise ValueError(f"{case_id}: unsupported action {step.get('action')!r}")
        for check in case.get("checks", []):
            if not isinstance(check, list) or not check or check[0] not in CHECKS:
                raise ValueError(f"{case_id}: unsupported check {check!r}")
            if check[0].startswith("file_") or check[0] == "json_equals":
                _safe_relative(check[1])


def run_case(case: dict[str, Any], run_root: Path, profile: str | None = None) -> dict[str, Any]:
    workspace = run_root / "workspaces" / case["id"]
    workspace.mkdir(parents=True, exist_ok=True)
    for relative, content in case.get("files", {}).items():
        target = workspace / _safe_relative(relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(str(content), encoding="utf-8")

    os.environ["FRIDAY_PERMISSION_MODE"] = str(case.get("permission_mode") or "bypass")
    session = FridaySession(workspace, stream=False)
    if profile:
        session.model_profile = profile
    responses: list[str] = []
    metrics = {"requests": 0, "input_tokens": 0, "output_tokens": 0, "elapsed_ms": 0}
    estimated_turns = 0
    action_log: list[dict[str, Any]] = []
    started = time.perf_counter()
    error = ""
    error_traceback = ""
    checks: list[dict[str, Any]] = []
    try:
        for step in case["steps"]:
            session, result = _run_step(session, workspace, step)
            if result is not None:
                responses.append(result.answer)
                for key in metrics:
                    metrics[key] += int(result.metrics.get(key) or 0)
                estimated_turns += int(bool(result.metrics.get("estimated_tokens")))
                action_log.append(
                    {
                        "action": step["action"],
                        "status": result.progress.get("status"),
                        "requests": result.metrics.get("requests"),
                    }
                )
            else:
                action_log.append({"action": step["action"], "status": "ok"})
        checks = [_run_check(check, workspace, responses) for check in case.get("checks", [])]
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"
        error_traceback = traceback.format_exc()
    passed = not error and all(check["passed"] for check in checks)
    config = session.context.metadata.get("friday.model_config") if session.context is not None else {}
    return {
        "id": case["id"],
        "category": case["category"],
        "source": case.get("source", "friday-local"),
        "difficulty": case.get("difficulty", "unspecified"),
        "capabilities": case.get("capabilities", []),
        "passed": passed,
        "duration_ms": int((time.perf_counter() - started) * 1000),
        "metrics": {**metrics, "estimated_turns": estimated_turns},
        "model": {
            key: config.get(key)
            for key in ("profile_id", "provider", "model")
            if isinstance(config, dict) and config.get(key)
        },
        "actions": action_log,
        "checks": checks,
        "error": error,
        "traceback": error_traceback,
        "session_id": session.session_id,
        "workspace": str(workspace),
    }


def _run_step(
    session: FridaySession, workspace: Path, step: dict[str, Any]
) -> tuple[FridaySession, Any | None]:
    action = step["action"]
    if action in {"chat", "goal"}:
        return session, session.chat(str(step["text"]), goal=action == "goal")
    if action == "approve":
        outcome = session.approve(for_session=bool(step.get("for_session")))
        return session, outcome.get("turn")
    if action == "reject":
        outcome = session.reject(str(step.get("guidance") or ""))
        return session, outcome.get("turn")
    if action == "assert_pending":
        actual = bool(pending_approval(workspace).get("pending"))
        expected = bool(step["value"])
        if actual != expected:
            raise AssertionError(f"pending approval is {actual}, expected {expected}")
        return session, None
    if action == "compact":
        session.compact()
        return session, None
    if action == "resume":
        resumed = FridaySession(workspace, stream=False, session_id=session.session_id)
        resumed.model_profile = session.model_profile
        resumed.resume(session.session_id)
        return resumed, None
    if action == "undo":
        session.undo(force=True)
        return session, None
    if action == "fork":
        saved = read_session(session_path(workspace, session.session_id))
        if saved is None:
            raise RuntimeError("source session was not persisted")
        body = conversation_body(saved.get("messages", []))
        index = next((index for index in range(len(body) - 1, -1, -1) if body[index].get("role") == "assistant"), -1)
        if index < 0:
            raise RuntimeError("source session has no assistant response")
        snapshot = fork_session(workspace, session.session_id, index)
        forked = FridaySession(workspace, stream=False, session_id=str(snapshot["session_id"]))
        forked.model_profile = session.model_profile
        forked.resume(str(snapshot["session_id"]))
        return forked, None
    raise AssertionError(f"unhandled action: {action}")


def _run_check(check: list[Any], workspace: Path, responses: list[str]) -> dict[str, Any]:
    kind = check[0]
    passed = False
    detail = ""
    if kind.startswith("file_") or kind == "json_equals":
        path = workspace / _safe_relative(check[1])
    if kind == "file_exists":
        passed, detail = path.is_file(), str(path)
    elif kind == "file_absent":
        passed, detail = not path.exists(), str(path)
    elif kind == "file_equals":
        actual = _text(path)
        expected = str(check[2]).replace("\r\n", "\n").rstrip("\n")
        passed, detail = actual.rstrip("\n") == expected, f"expected {expected!r}, got {actual!r}"
    elif kind == "file_contains":
        actual, expected = _text(path), str(check[2])
        passed, detail = expected in actual, f"missing {expected!r}"
    elif kind == "file_not_contains":
        actual, rejected = _text(path), str(check[2])
        passed, detail = rejected not in actual, f"unexpected {rejected!r}"
    elif kind == "json_equals":
        value: Any = json.loads(_text(path))
        for part in str(check[2]).split(".") if check[2] else []:
            value = value[int(part)] if isinstance(value, list) else value[part]
        passed, detail = value == check[3], f"expected {check[3]!r}, got {value!r}"
    elif kind == "python":
        completed = subprocess.run(
            [sys.executable, "-c", str(check[1])],
            cwd=workspace,
            text=True,
            capture_output=True,
            timeout=30,
        )
        passed = completed.returncode == 0
        detail = (completed.stdout + completed.stderr).strip()[-1000:]
    elif kind in {"response_contains", "response_not_contains"}:
        actual, needle = "\n".join(responses), str(check[1])
        passed = needle in actual if kind == "response_contains" else needle not in actual
        detail = f"response {'missing' if kind == 'response_contains' else 'contains'} {needle!r}"
    return {"type": kind, "passed": passed, "detail": detail if not passed else ""}


def _text(path: Path) -> str:
    return path.read_text(encoding="utf-8-sig").replace("\r\n", "\n")


def _safe_relative(value: str) -> Path:
    path = Path(value)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError(f"benchmark paths must stay relative: {value}")
    return path


def _prepare_run(run_root: Path) -> Path:
    execution_root = Path(tempfile.mkdtemp(prefix="friday-run-"))
    isolated_home = execution_root / "home"
    isolated_home.mkdir(parents=True, exist_ok=True)
    for name in CONFIG_FILES:
        source = SOURCE_HOME / name
        if source.is_file():
            shutil.copy2(source, isolated_home / name)
    os.environ.update(
        {
            "FRIDAY_HOME": str(isolated_home),
            "FRIDAY_OBSERVABILITY_DIR": str(run_root / "traces"),
            "FRIDAY_CHECKPOINT_DIR": str(execution_root / "checkpoints"),
        }
    )
    return execution_root


def _write_results(path: Path, results: list[dict[str, Any]], started: str) -> None:
    totals = {
        "cases": len(results),
        "passed": sum(result["passed"] for result in results),
        "failed": sum(not result["passed"] for result in results),
        "duration_ms": sum(result["duration_ms"] for result in results),
        "requests": sum(result["metrics"]["requests"] for result in results),
        "input_tokens": sum(result["metrics"]["input_tokens"] for result in results),
        "output_tokens": sum(result["metrics"]["output_tokens"] for result in results),
        "estimated_turns": sum(result["metrics"]["estimated_turns"] for result in results),
    }
    categories: dict[str, dict[str, int]] = {}
    sources: dict[str, dict[str, int]] = {}
    for result in results:
        bucket = categories.setdefault(
            result["category"],
            {"cases": 0, "passed": 0, "requests": 0, "input_tokens": 0, "output_tokens": 0},
        )
        bucket["cases"] += 1
        bucket["passed"] += int(result["passed"])
        for key in ("requests", "input_tokens", "output_tokens"):
            bucket[key] += int(result["metrics"][key])
        source_bucket = sources.setdefault(
            result["source"],
            {"cases": 0, "passed": 0, "requests": 0, "input_tokens": 0, "output_tokens": 0},
        )
        source_bucket["cases"] += 1
        source_bucket["passed"] += int(result["passed"])
        for key in ("requests", "input_tokens", "output_tokens"):
            source_bucket[key] += int(result["metrics"][key])
    payload = {
        "started": started,
        "finished": datetime.now().astimezone().isoformat(),
        "model": next((result["model"] for result in results if result["model"]), {}),
        "totals": totals,
        "categories": categories,
        "sources": sources,
        "results": results,
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", type=Path, default=CASES_PATH, help="case JSONL file")
    parser.add_argument("--run-root", type=Path, default=RUNS_DIR, help="directory for results and traces")
    parser.add_argument("--validate", action="store_true", help="validate all case definitions without model calls")
    parser.add_argument("--case", action="append", default=[], help="run one case id; repeatable")
    parser.add_argument("--category", action="append", default=[], help="run one category; repeatable")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--profile", help="Friday model profile id")
    parser.add_argument("--run-id", help="output directory name")
    args = parser.parse_args()
    cases = load_cases(args.cases)
    if args.validate:
        print(f"Validated {len(cases)} Harness benchmark cases.")
        return 0
    if args.case:
        wanted = set(args.case)
        cases = [case for case in cases if case["id"] in wanted]
        missing = wanted - {case["id"] for case in cases}
        if missing:
            parser.error(f"unknown case ids: {', '.join(sorted(missing))}")
    if args.category:
        cases = [case for case in cases if case["category"] in set(args.category)]
    if args.limit:
        cases = cases[: args.limit]
    if not cases:
        parser.error("no cases selected")

    run_id = args.run_id or datetime.now().strftime("%Y%m%d-%H%M%S")
    run_root = args.run_root / run_id
    run_root.mkdir(parents=True, exist_ok=False)
    execution_root = _prepare_run(run_root)
    result_path = run_root / "results.json"
    started = datetime.now().astimezone().isoformat()
    results: list[dict[str, Any]] = []
    for index, case in enumerate(cases, 1):
        print(f"[{index:02d}/{len(cases):02d}] {case['id']} ...", end=" ", flush=True)
        result = run_case(case, execution_root, args.profile)
        results.append(result)
        _write_results(result_path, results, started)
        print("PASS" if result["passed"] else f"FAIL {result['error'] or ''}", flush=True)
    passed = sum(result["passed"] for result in results)
    print(f"\n{passed}/{len(results)} passed. Results: {result_path}")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
