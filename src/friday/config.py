from __future__ import annotations

import json
import os
import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from agent_core import ChatModel, LLM

from friday.providers import AnthropicModel
from friday.storage import friday_home, project_state_dir


@dataclass(frozen=True)
class ModelConfig:
    profile_id: str = "default"
    profile_name: str = "DeepSeek"
    provider: str = "deepseek"
    model: str = "deepseek-v4-flash"
    base_url: str = "https://api.deepseek.com"
    vision: bool = False
    context_window: int = 353000
    max_output_tokens: int = 65536
    run_token_budget: int = 2824000


DEFAULT_MODEL_CONFIG = ModelConfig()
CONFIG_FIELDS = {
    "provider",
    "model",
    "base_url",
    "context_window",
    "max_output_tokens",
    "run_token_budget",
}
PROFILES_FILE = "models.json"
CREDENTIALS_FILE = "model-credentials.json"
WEB_CREDENTIALS_FILE = "web-credentials.json"
WEB_SEARCH_KEYS = {"tavily": "TAVILY_API_KEY", "anysearch": "ANYSEARCH_API_KEY"}
PROVIDERS = (
    {
        "id": "deepseek",
        "label": "DeepSeek",
        "base_url": "https://api.deepseek.com",
        "models": (
            {"id": "deepseek-v4-flash", "vision": False},
            {"id": "deepseek-v4-pro", "vision": False},
        ),
    },
    {
        "id": "mimo",
        "label": "Xiaomi MiMo",
        "base_url": "https://api.xiaomimimo.com/v1",
        "models": (
            {"id": "mimo-v2.5", "vision": True},
            {"id": "mimo-v2.5-pro", "vision": False},
        ),
    },
    {
        "id": "openai",
        "label": "OpenAI",
        "base_url": "https://api.openai.com/v1",
        "models": (
            {"id": "gpt-5.1", "vision": True},
            {"id": "gpt-5-mini", "vision": True},
            {"id": "gpt-4.1", "vision": True},
        ),
    },
    {
        "id": "anthropic",
        "label": "Anthropic",
        "base_url": "https://api.anthropic.com",
        "models": (
            {"id": "claude-sonnet-4-20250514", "vision": True},
            {"id": "claude-opus-4-20250514", "vision": True},
        ),
    },
)


def load_model_config(
    workspace: Path,
    *,
    home: Path | None = None,
    profile_id: str | None = None,
) -> ModelConfig:
    base = _load_base_config(workspace, home=home)
    catalog = load_model_catalog(workspace, home=home)
    selected = next(
        (profile for profile in catalog["profiles"] if profile["id"] == (profile_id or catalog["active"])),
        catalog["profiles"][0],
    )
    return ModelConfig(
        profile_id=selected["id"],
        profile_name=selected["name"],
        provider=selected["provider"],
        model=selected["model"],
        base_url=selected["base_url"],
        vision=selected["vision"],
        context_window=int(selected.get("context_window") or base.context_window),
        max_output_tokens=int(selected.get("max_output_tokens") or base.max_output_tokens),
        run_token_budget=int(selected.get("run_token_budget") or base.run_token_budget),
    )


def load_model_catalog(workspace: Path, *, home: Path | None = None) -> dict[str, Any]:
    base = _load_base_config(workspace, home=home)
    user_dir = friday_home(home)
    path = user_dir / PROFILES_FILE
    data = _read_json_object(path)
    raw_profiles = data.get("profiles") if isinstance(data.get("profiles"), list) else []
    profiles: list[dict[str, Any]] = []
    for value in raw_profiles:
        if not isinstance(value, dict):
            continue
        try:
            profiles.append(_validate_profile(value, base))
        except ValueError:
            continue
    if not profiles:
        profiles = [
            {
                "id": "default",
                "name": _provider_label(base.provider),
                "provider": base.provider,
                "model": base.model,
                "base_url": base.base_url,
                "vision": _supports_vision(base.provider, base.model),
                "context_window": base.context_window,
                "max_output_tokens": base.max_output_tokens,
                "run_token_budget": base.run_token_budget,
            }
        ]
    active = str(data.get("active") or "")
    if not any(profile["id"] == active for profile in profiles):
        active = profiles[0]["id"]
    credentials = _read_credentials(home)
    return {
        "active": active,
        "profiles": [
            {
                **profile,
                "api_key_configured": bool(
                    credentials.get(profile["id"])
                    or _provider_env(profile["provider"])
                    or _env_file_has_key(workspace, profile["provider"], home)
                ),
            }
            for profile in profiles
        ],
        "providers": [dict(provider) for provider in PROVIDERS],
    }


def save_model_profile(
    workspace: Path,
    value: dict[str, Any],
    *,
    api_key: str | None = None,
    clear_api_key: bool = False,
    activate: bool = True,
    home: Path | None = None,
) -> dict[str, Any]:
    base = _load_base_config(workspace, home=home)
    catalog = load_model_catalog(workspace, home=home)
    profile_id = str(value.get("id") or uuid.uuid4().hex[:12])
    profile = _validate_profile({**value, "id": profile_id}, base)
    profiles = [
        profile
        if current["id"] == profile_id
        else {key: item for key, item in current.items() if key != "api_key_configured"}
        for current in catalog["profiles"]
    ]
    if not any(current["id"] == profile_id for current in profiles):
        profiles.append(profile)
    active = profile_id if activate else catalog["active"]
    user_dir = friday_home(home)
    _write_json(user_dir / PROFILES_FILE, {"active": active, "profiles": profiles})
    credentials = _read_credentials(home)
    if clear_api_key:
        credentials.pop(profile_id, None)
    elif api_key is not None and api_key.strip():
        credentials[profile_id] = api_key.strip()
    _write_json(user_dir / CREDENTIALS_FILE, credentials, private=True)
    return load_model_catalog(workspace, home=home)


def delete_model_profile(workspace: Path, profile_id: str, *, home: Path | None = None) -> dict[str, Any]:
    catalog = load_model_catalog(workspace, home=home)
    profiles = [profile for profile in catalog["profiles"] if profile["id"] != profile_id]
    if not profiles:
        raise ValueError("Friday needs at least one model configuration.")
    active = catalog["active"] if catalog["active"] != profile_id else profiles[0]["id"]
    user_dir = friday_home(home)
    _write_json(
        user_dir / PROFILES_FILE,
        {
            "active": active,
            "profiles": [
                {key: value for key, value in profile.items() if key != "api_key_configured"}
                for profile in profiles
            ],
        },
    )
    credentials = _read_credentials(home)
    credentials.pop(profile_id, None)
    _write_json(user_dir / CREDENTIALS_FILE, credentials, private=True)
    return load_model_catalog(workspace, home=home)


def select_model_profile(workspace: Path, profile_id: str, *, home: Path | None = None) -> dict[str, Any]:
    catalog = load_model_catalog(workspace, home=home)
    if not any(profile["id"] == profile_id for profile in catalog["profiles"]):
        raise ValueError(f"Unknown Friday model configuration: {profile_id}")
    _write_json(
        friday_home(home) / PROFILES_FILE,
        {
            "active": profile_id,
            "profiles": [
                {key: value for key, value in profile.items() if key != "api_key_configured"}
                for profile in catalog["profiles"]
            ],
        },
    )
    return load_model_catalog(workspace, home=home)


def model_api_key(config: ModelConfig, *, home: Path | None = None) -> str | None:
    return _read_credentials(home).get(config.profile_id) or _provider_env(config.provider)


def load_web_search_settings(workspace: Path, *, home: Path | None = None) -> dict[str, bool]:
    saved = _read_web_credentials(home)
    return {
        f"{provider}_configured": bool(
            saved.get(env_name) or os.getenv(env_name) or _env_files_have_names(workspace, {env_name}, home)
        )
        for provider, env_name in WEB_SEARCH_KEYS.items()
    }


def save_web_search_settings(
    workspace: Path,
    *,
    tavily_api_key: str | None = None,
    anysearch_api_key: str | None = None,
    clear_tavily: bool = False,
    clear_anysearch: bool = False,
    home: Path | None = None,
) -> dict[str, bool]:
    saved = _read_web_credentials(home)
    cleared: list[tuple[str, str | None]] = []
    for provider, value, clear in (
        ("tavily", tavily_api_key, clear_tavily),
        ("anysearch", anysearch_api_key, clear_anysearch),
    ):
        env_name = WEB_SEARCH_KEYS[provider]
        previous = saved.get(env_name)
        if clear:
            saved.pop(env_name, None)
            cleared.append((env_name, previous))
        elif value is not None and value.strip():
            secret = value.strip()
            if len(secret) > 4096 or "\n" in secret or "\r" in secret:
                raise ValueError(f"Invalid {provider} API key.")
            saved[env_name] = secret
            os.environ[env_name] = secret
    _write_json(friday_home(home) / WEB_CREDENTIALS_FILE, saved, private=True)
    for env_name, previous in cleared:
        if previous and os.getenv(env_name) == previous:
            os.environ.pop(env_name, None)
    if cleared:
        load_model_environment(workspace, home=home)
    return load_web_search_settings(workspace, home=home)


def output_token_limit(config: ModelConfig, value: int) -> dict[str, int]:
    key = "max_completion_tokens" if config.provider in {"mimo", "openai"} else "max_tokens"
    return {key: min(value, config.max_output_tokens)}


def _load_base_config(workspace: Path, *, home: Path | None = None) -> ModelConfig:
    values = {key: getattr(DEFAULT_MODEL_CONFIG, key) for key in CONFIG_FIELDS}
    user_dir = friday_home(home)
    for path in (
        user_dir / "config.json",
        project_state_dir(workspace, home) / "config.json",
    ):
        values.update(_read_config(path))
    return _validate(values)


def build_model(config: ModelConfig) -> ChatModel:
    api_key = model_api_key(config)
    if config.provider == "anthropic":
        return AnthropicModel(api_key=api_key, base_url=config.base_url or None, model=config.model)
    return LLM(
        api_key=api_key,
        base_url=config.base_url or None,
        model=config.model,
    )


def load_model_environment(workspace: Path, *, home: Path | None = None) -> None:
    allowed = {
        "ANYSEARCH_API_KEY",
        "JINA_API_KEY",
        "TAVILY_API_KEY",
        *(name for provider in PROVIDERS for name in _provider_env_names(str(provider["id"])) if name),
    }
    for path in (workspace.resolve() / ".env", friday_home(home) / ".env"):
        if not path.exists():
            continue
        for raw_line in path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip().lstrip("\ufeff")
            if key not in allowed or key in os.environ:
                continue
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
                value = value[1:-1]
            os.environ[key] = value
    os.environ.update(_read_web_credentials(home))


def default_config_text() -> str:
    return json.dumps(
        {key: getattr(DEFAULT_MODEL_CONFIG, key) for key in CONFIG_FIELDS},
        ensure_ascii=False,
        indent=2,
    ) + "\n"


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


def _validate_profile(value: dict[str, Any], base: ModelConfig) -> dict[str, Any]:
    profile_id = re.sub(r"[^A-Za-z0-9_-]+", "-", str(value.get("id") or "")).strip("-")
    provider = str(value.get("provider") or "").strip().lower()
    name = str(value.get("name") or "").strip()
    model = str(value.get("model") or "").strip()
    base_url = str(value.get("base_url") or "").strip().rstrip("/")
    if not profile_id or not name or not model:
        raise ValueError("Model configuration id, name, and model are required.")
    if provider not in {item["id"] for item in PROVIDERS}:
        raise ValueError(f"Unsupported model provider: {provider}")
    if not re.match(r"^https?://", base_url):
        raise ValueError("Model Base URL must start with http:// or https://.")
    numbers: dict[str, int] = {}
    for key in ("context_window", "max_output_tokens", "run_token_budget"):
        raw = value.get(key, getattr(base, key))
        if not isinstance(raw, int) or isinstance(raw, bool) or raw < 1:
            raise ValueError(f"Model configuration '{key}' must be a positive integer.")
        numbers[key] = raw
    if numbers["max_output_tokens"] > numbers["context_window"]:
        raise ValueError("Maximum output tokens cannot exceed the context window.")
    return {
        "id": profile_id,
        "name": name,
        "provider": provider,
        "model": model,
        "base_url": base_url,
        "vision": _supports_vision(provider, model),
        **numbers,
    }


def _supports_vision(provider: str, model: str) -> bool:
    lowered = model.lower()
    if provider == "mimo":
        return lowered == "mimo-v2.5"
    if provider == "anthropic":
        return lowered.startswith("claude-")
    if provider == "openai":
        return lowered.startswith(("gpt-4o", "gpt-4.1", "gpt-5"))
    return False


def _provider_label(provider: str) -> str:
    return next((str(item["label"]) for item in PROVIDERS if item["id"] == provider), provider.title())


def _provider_env(provider: str) -> str | None:
    return _first_env(*_provider_env_names(provider))


def _provider_env_names(provider: str) -> tuple[str, ...]:
    provider_key = re.sub(r"[^A-Z0-9]+", "_", provider.upper()).strip("_")
    return (
        f"{provider_key}_API_KEY",
        "LLM_API_KEY",
        "OPENAI_API_KEY" if provider == "openai" else "",
        "DEEPSEEK_API_KEY" if provider == "deepseek" else "",
        "ANTHROPIC_API_KEY" if provider == "anthropic" else "",
        "MIMO_API_KEY" if provider == "mimo" else "",
    )


def _env_file_has_key(workspace: Path, provider: str, home: Path | None) -> bool:
    return _env_files_have_names(workspace, set(filter(None, _provider_env_names(provider))), home)


def _env_files_have_names(workspace: Path, names: set[str], home: Path | None) -> bool:
    for path in (workspace.resolve() / ".env", friday_home(home) / ".env"):
        if not path.exists():
            continue
        for raw_line in path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            if key.strip().lstrip("\ufeff") in names and value.strip().strip("'\""):
                return True
    return False


def _read_json_object(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        raise ValueError(f"Invalid Friday config {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"Invalid Friday config {path}: expected a JSON object.")
    return value


def _read_credentials(home: Path | None = None) -> dict[str, str]:
    values = _read_json_object(friday_home(home) / CREDENTIALS_FILE)
    return {str(key): str(value) for key, value in values.items() if isinstance(value, str) and value}


def _read_web_credentials(home: Path | None = None) -> dict[str, str]:
    values = _read_json_object(friday_home(home) / WEB_CREDENTIALS_FILE)
    return {
        key: str(values[key])
        for key in WEB_SEARCH_KEYS.values()
        if isinstance(values.get(key), str) and str(values[key]).strip()
    }


def _write_json(path: Path, value: Any, *, private: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if private:
        try:
            temporary.chmod(0o600)
        except OSError:
            pass
    temporary.replace(path)


def _first_env(*names: str) -> str | None:
    return next((value for name in names if name and (value := os.getenv(name))), None)
