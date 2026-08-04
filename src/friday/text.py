"""Text shortening shared by state, traces, checkpoints, tools, and progress.

These live in their own leaf module because every layer needs them and none of them
should have to import a heavier sibling to get one truncation rule.
"""

from __future__ import annotations

from pathlib import Path


def clip(text: str, limit: int) -> str:
    """Shorten to `limit` characters, keeping the text's own line structure."""
    return text if len(text) <= limit else text[: limit - 3] + "..."


def preview(text: str, limit: int = 80) -> str:
    """One-line summary: collapse all whitespace, then shorten."""
    return clip(" ".join(str(text).split()), limit)


def read_limited(path: Path, limit: int) -> str:
    """Read a file, telling the model where to look when the tail is dropped."""
    text = path.read_text(encoding="utf-8")
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + f"\n\n[truncated: read {path} directly for the rest]"
