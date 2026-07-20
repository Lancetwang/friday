from __future__ import annotations

import json
import os
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from agent_core import LLM


@dataclass(frozen=True)
class ModelConfig:
    provider: str = "deepseek"
    model: str = "deepseek-v4-flash"
    base_url: str = "https://api.deepseek.com"
    context_window: int = 353000
    max_output_tokens: int = 65536
    run_token_budget: int = 2824000


DEFAULT_MODEL_CONFIG = ModelConfig()
CONFIG_FIELDS = set(asdict(DEFAULT_MODEL_CONFIG))


def load_model_config(workspace: Path, *, home: Path | None = None) -> ModelConfig:
    values = asdict(DEFAULT_MODEL_CONFIG)
    user_dir = (home or Path.home()) / ".friday"
    for path in (user_dir / "config.json", workspace.resolve() / ".friday" / "config.json"):
        values.update(_read_config(path))
    return _validate(values)


def build_model(config: ModelConfig) -> LLM:
    provider_key = re.sub(r"[^A-Z0-9]+", "_", config.provider.upper()).strip("_")
    api_key = _first_env(f"{provider_key}_API_KEY", "LLM_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY")
    return LLM(api_key=api_key, base_url=config.base_url or None, model=config.model)


def load_model_environment(workspace: Path, *, home: Path | None = None) -> None:
    for path in (workspace.resolve() / ".env", (home or Path.home()) / ".friday" / ".env"):
        if not path.exists():
            continue
        for raw_line in path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip().lstrip("\ufeff")
            if not key or key in os.environ:
                continue
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
                value = value[1:-1]
            os.environ[key] = value


def default_config_text() -> str:
    return json.dumps(asdict(DEFAULT_MODEL_CONFIG), ensure_ascii=False, indent=2) + "\n"


def _read_config(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        raise ValueError(f"Invalid Friday config {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"Invalid Friday config {path}: expected a JSON object.")
    unknown = sorted(set(value) - CONFIG_FIELDS)
    if unknown:
        raise ValueError(f"Unknown Friday config keys in {path}: {', '.join(unknown)}")
    return value


def _validate(values: dict[str, Any]) -> ModelConfig:
    for key in ("provider", "model", "base_url"):
        if not isinstance(values.get(key), str):
            raise ValueError(f"Friday config '{key}' must be a string.")
    if not values["provider"].strip() or not values["model"].strip():
        raise ValueError("Friday config 'provider' and 'model' cannot be empty.")
    for key in ("context_window", "max_output_tokens", "run_token_budget"):
        if not isinstance(values.get(key), int) or isinstance(values.get(key), bool) or values[key] < 1:
            raise ValueError(f"Friday config '{key}' must be a positive integer.")
    if values["max_output_tokens"] > values["context_window"]:
        raise ValueError("Friday config 'max_output_tokens' cannot exceed 'context_window'.")
    return ModelConfig(**values)


def _first_env(*names: str) -> str | None:
    return next((value for name in names if (value := os.getenv(name))), None)
