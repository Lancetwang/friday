from __future__ import annotations

import hashlib
from pathlib import Path

from friday.storage import project_state_dir

DEFAULT_FRIDAY_SKILL = Path(__file__).parent / "default_skills" / "friday-cli" / "SKILL.md"
LEGACY_DEFAULT_SKILL_HASHES = {
    "667187dd2837f6aa0f58c151a82adee3dca6686443cf3bac046e15a9628c8268",
    "2bb93f4e5e10b92552705a4ec17098b5ffe259d29a066cc632cf8da42d522caf",
    "e8066193c1802e58b069cc3f8db619d5e735765dce3a27113026f3f9c4e9b232",
    "a6f0bc0e86c3d578ff3db5d3958b34dd5eefddc55af8449bfb01a2556e176c95",
}


def discover_skills(workspace: Path, user_dir: Path) -> list[dict[str, str]]:
    found: dict[str, dict[str, str]] = {}
    roots = [
        ("project", project_state_dir(workspace) / "FridaySkills"),
        ("project", workspace.resolve() / ".friday" / "FridaySkills"),
        ("user", user_dir.resolve() / "FridaySkills"),
    ]
    for scope, root in roots:
        if not root.exists():
            continue
        for skill_file in sorted(root.glob("*/SKILL.md")):
            try:
                name, description = _skill_metadata(skill_file)
            except (OSError, UnicodeError):
                continue
            key = name.strip().lower() or skill_file.parent.name.lower()
            found.setdefault(
                key,
                {
                    "name": name,
                    "description": description,
                    "scope": scope,
                    "path": str(skill_file.resolve()),
                },
            )
    return sorted(found.values(), key=lambda item: item["name"].lower())


def ensure_default_skill(user_dir: Path) -> Path | None:
    path = user_dir / "FridaySkills" / "friday-cli" / "SKILL.md"
    if path.exists():
        current = path.read_text(encoding="utf-8")
        fingerprint = hashlib.sha256(current.replace("\r\n", "\n").strip().encode("utf-8")).hexdigest()
        if fingerprint in LEGACY_DEFAULT_SKILL_HASHES:
            path.write_text(DEFAULT_FRIDAY_SKILL.read_text(encoding="utf-8"), encoding="utf-8")
            return path
        return None
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(DEFAULT_FRIDAY_SKILL.read_text(encoding="utf-8"), encoding="utf-8")
    return path


def skill_routing() -> str:
    return "Run `friday skill list --json`, then read only the selected `SKILL.md` and resources it references."


def skill_body(text: str) -> str:
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].strip() != "---":
        return text
    for index, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            return "".join(lines[index + 1 :]).lstrip("\r\n")
    return text


def _skill_metadata(path: Path) -> tuple[str, str]:
    text = path.read_text(encoding="utf-8")
    name = path.parent.name
    description = ""
    lines = text.splitlines()
    if lines and lines[0].strip() == "---":
        for line in lines[1:]:
            if line.strip() == "---":
                break
            key, sep, value = line.partition(":")
            if sep and key.strip() == "name":
                name = value.strip().strip("\"'")
            elif sep and key.strip() == "description":
                description = value.strip().strip("\"'")
    if not description:
        for line in lines:
            stripped = line.strip()
            if stripped and not stripped.startswith(("#", "---")):
                description = stripped
                break
    return name, description or "No description."
