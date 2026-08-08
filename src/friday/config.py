from __future__ import annotations

import json
import os
import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from agent_core import ChatModel, LLM

from friday.model_options import model_api_mode
from friday.storage import friday_home, project_state_dir, write_json_atomic


@dataclass(frozen=True)
class ModelConfig:
    profile_id: str = "default"
    profile_name: str = "DeepSeek"
    provider: str = "deepseek"
    model: str = "deepseek-v4-flash"
    base_url: str = "https://api.deepseek.com"
    vision: bool = False
    context_window: int = 1_000_000
    max_output_tokens: int = 65536
    # Kept so existing config files still load, and reported as the turn's cost.
    # Nothing compares a run against it: every step re-sends the conversation, so
    # this total grows with the square of the step count and would stop a long run
    # whose window is still mostly empty. The window bounds a run; spend does not.
    run_token_budget: int = 40000000


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
FEISHU_FILE = "im-feishu.json"
WEB_SEARCH_KEYS = {"tavily": "TAVILY_API_KEY", "anysearch": "ANYSEARCH_API_KEY"}
# Secrets Friday itself put into this process. Tool subprocesses must not inherit
# them: the user never opted their shell into Friday's credential stores.
_INJECTED_ENV_NAMES: set[str] = set()
PROVIDERS = (
    {
        "id": "deepseek",
        "label": "DeepSeek",
        # Built-in providers have a fixed base URL and discover their models
        # through the provider's /models endpoint: configuring one is just
        # pasting an API key.
        "builtin": True,
        "base_url": "https://api.deepseek.com",
        "models": (
            {"id": "deepseek-v4-flash", "vision": False},
            {"id": "deepseek-v4-pro", "vision": False},
        ),
    },
    {
        "id": "mimo",
        "label": "Xiaomi MiMo",
        "builtin": True,
        "base_url": "https://api.xiaomimimo.com/v1",
        "models": (
            {"id": "mimo-v2.5", "vision": True},
            {"id": "mimo-v2.5-pro", "vision": False},
        ),
    },
    {
        "id": "openai",
        "label": "OpenAI",
        "builtin": True,
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
        "builtin": True,
        "base_url": "https://api.anthropic.com",
        "models": (
            {"id": "claude-sonnet-4-20250514", "vision": True},
            {"id": "claude-opus-4-20250514", "vision": True},
        ),
    },
    {
        "id": "opencode-go",
        "label": "OpenCode Go",
        "builtin": True,
        "base_url": "https://opencode.ai/zen/go/v1",
        "models": (
            {"id": "grok-4.5", "vision": True},
            {"id": "gpt-5.6-luna", "vision": True},
            {"id": "glm-5.2", "vision": False},
            {"id": "glm-5.1", "vision": False},
            {"id": "kimi-k3", "vision": True},
            {"id": "kimi-k2.7-code", "vision": True},
            {"id": "kimi-k2.6", "vision": True},
            {"id": "deepseek-v4-pro", "vision": False},
            {"id": "deepseek-v4-flash", "vision": False},
            {"id": "mimo-v2.5", "vision": True},
            {"id": "mimo-v2.5-pro", "vision": False},
            {"id": "minimax-m3", "vision": True},
            {"id": "minimax-m2.7", "vision": False},
            {"id": "minimax-m2.5", "vision": False},
            {"id": "qwen3.8-max", "vision": True},
            {"id": "qwen3.7-max", "vision": False},
            {"id": "qwen3.7-plus", "vision": True},
            {"id": "qwen3.6-plus", "vision": True},
            {"id": "hy3", "vision": False},
        ),
    },
    # Everything else: any service that speaks the OpenAI chat API. The user
    # supplies the base URL, the model id, and the API key.
    {
        "id": "openai-compatible",
        "label": "OpenAI Compatible",
        "builtin": False,
        "base_url": "",
        "models": (),
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
    available = [profile for profile in catalog["profiles"] if profile.get("enabled")]
    candidates = available or catalog["profiles"]
    selected = next(
        (profile for profile in candidates if profile["id"] == (profile_id or catalog["active"])),
        candidates[0],
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


def fetch_provider_models(provider_id: str, base_url: str, api_key: str) -> list[str]:
    """List the model ids a provider advertises through its /models endpoint.

    Every built-in provider except Anthropic speaks the OpenAI-compatible
    models API. Raises ValueError when the API key is rejected so callers can
    surface that to the user; other failures are left to the caller to treat
    as "no listing available".
    """
    if provider_id == "anthropic":
        from anthropic import Anthropic, AuthenticationError

        client = Anthropic(api_key=api_key, base_url=base_url or None)
        try:
            models = client.models.list()
        except AuthenticationError as exc:
            raise ValueError(_key_rejected_message(provider_id, exc)) from exc
        return sorted({str(model.id) for model in models})
    from openai import AuthenticationError, OpenAI, PermissionDeniedError

    client = OpenAI(api_key=api_key, base_url=base_url or None)
    try:
        models = client.models.list()
    except (AuthenticationError, PermissionDeniedError) as exc:
        raise ValueError(_key_rejected_message(provider_id, exc)) from exc
    return sorted({str(model.id) for model in models})


def _key_rejected_message(provider_id: str, exc: Exception) -> str:
    status = getattr(exc, "status_code", None) or getattr(exc, "status", None) or 401
    return (
        f"API key rejected by {_provider_label(provider_id)} (HTTP {status}). "
        "Check the key and try again."
    )


def _fetch_models(provider: Mapping[str, Any], api_key: str) -> list[str] | None:
    """Fetch a built-in provider's model list, or None when it is unavailable.

    A rejected key is a hard error (it is how Friday validates the key on
    save); any other failure falls back to the provider's static model list.
    """
    try:
        return fetch_provider_models(str(provider["id"]), str(provider["base_url"]), api_key)
    except ValueError:
        raise
    except Exception:
        return None


def _provider(provider_id: str) -> dict[str, Any]:
    return next((item for item in PROVIDERS if item["id"] == provider_id), {})


def _profile_id(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "-", value).strip("-")


def _default_profile(base: ModelConfig) -> dict[str, Any]:
    return {
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


def _sync_builtin_profiles(
    provider: Mapping[str, Any],
    model_ids: list[str] | None,
    profiles: list[dict[str, Any]],
    base: ModelConfig,
    credentials: dict[str, str],
    api_key: str,
) -> tuple[list[dict[str, Any]], dict[str, str]]:
    """Turn a built-in provider's model list into one profile per model.

    Each model becomes a profile so the chat model menu can offer everything
    the provider actually serves. The provider's key is copied to each of its
    profiles (the credential store is keyed by profile id), and auto profiles
    for models the provider no longer serves are dropped.
    """
    static = {str(item["id"]) for item in provider["models"]}
    fetched = set(model_ids) if model_ids is not None else static
    profiles = [
        profile
        for profile in profiles
        if not (profile.get("auto") and profile["provider"] == provider["id"])
    ]
    for model_id in sorted(fetched):
        existing = next(
            (profile for profile in profiles if profile["provider"] == provider["id"] and profile["model"] == model_id),
            None,
        )
        if existing is not None:
            existing.update(
                {
                    "auto": True,
                    "name": model_id,
                    "base_url": str(provider["base_url"]),
                    "vision": _supports_vision(str(provider["id"]), model_id),
                }
            )
        else:
            existing = {
                "id": _profile_id(f"{provider['id']}-{model_id}"),
                "name": model_id,
                "provider": provider["id"],
                "model": model_id,
                "base_url": str(provider["base_url"]),
                "vision": _supports_vision(str(provider["id"]), model_id),
                "context_window": base.context_window,
                "max_output_tokens": base.max_output_tokens,
                "run_token_budget": base.run_token_budget,
                "auto": True,
            }
            profiles.append(existing)
        credentials[str(existing["id"])] = api_key
    return profiles, credentials


def _stored_profile(profile: Mapping[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in profile.items()
        if key not in {"api_key_configured", "enabled"}
    }


def _disabled_targets(value: Any) -> set[str]:
    if not isinstance(value, list):
        return set()
    return {str(item) for item in value if isinstance(item, str) and item.strip()}


def _profile_target(profile: Mapping[str, Any]) -> str:
    if profile.get("provider") == "openai-compatible":
        return f"profile:{profile['id']}"
    return f"provider:{profile['provider']}"


def _write_model_state(
    user_dir: Path,
    *,
    active: str,
    profiles: list[dict[str, Any]],
    disabled: set[str],
) -> None:
    write_json_atomic(
        user_dir / PROFILES_FILE,
        {
            "active": active,
            "disabled": sorted(disabled),
            "profiles": [_stored_profile(profile) for profile in profiles],
        },
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
        profiles = [_default_profile(base)]
    disabled = _disabled_targets(data.get("disabled"))
    credentials = _read_credentials(home)
    decorated: list[dict[str, Any]] = []
    for profile in profiles:
        configured = bool(
            credentials.get(profile["id"])
            or _provider_env(profile["provider"])
            or _env_file_has_key(workspace, profile["provider"], home)
        )
        decorated.append(
            {
                **profile,
                "api_key_configured": configured,
                "enabled": configured and _profile_target(profile) not in disabled,
            }
        )
    active = str(data.get("active") or "")
    enabled_profiles = [profile for profile in decorated if profile["enabled"]]
    if enabled_profiles and not any(profile["id"] == active and profile["enabled"] for profile in decorated):
        active = enabled_profiles[0]["id"]
    elif not any(profile["id"] == active for profile in decorated):
        active = decorated[0]["id"]

    providers = []
    for provider in PROVIDERS:
        provider_id = str(provider["id"])
        provider_profiles = [profile for profile in decorated if profile["provider"] == provider_id]
        configured = any(profile["api_key_configured"] for profile in provider_profiles)
        if provider.get("builtin") and not configured:
            configured = bool(
                _provider_env(provider_id)
                or _env_file_has_key(workspace, provider_id, home)
            )
        providers.append(
            {
                **provider,
                "api_key_configured": configured,
                "enabled": configured
                and (
                    f"provider:{provider_id}" not in disabled
                    if provider.get("builtin")
                    else any(profile["enabled"] for profile in provider_profiles)
                ),
            }
        )
    return {
        "active": active,
        "disabled": sorted(disabled),
        "profiles": decorated,
        "providers": providers,
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
    provider = _provider(profile["provider"])
    user_dir = friday_home(home)
    credentials = _read_credentials(home)
    disabled = set(catalog.get("disabled") or [])

    new_key = api_key is not None and bool(api_key.strip()) and not clear_api_key
    fetched: list[str] | None = None
    if provider.get("builtin") and new_key:
        # Fetching the model list also validates the key: a rejected key fails
        # the save before anything is written.
        fetched = _fetch_models(provider, api_key.strip())

    profiles = [_stored_profile(current) for current in catalog["profiles"]]
    # An empty model marks a built-in provider save: the provider's profiles
    # come from the model list, not from one explicit model.
    explicit = bool(profile["model"])
    if explicit:
        replaced = any(current["id"] == profile_id for current in profiles)
        profiles = [profile if current["id"] == profile_id else current for current in profiles]
        if not replaced:
            profiles.append(profile)

    if provider.get("builtin"):
        if clear_api_key:
            for current in profiles:
                if current["provider"] == profile["provider"]:
                    credentials.pop(current["id"], None)
        elif new_key:
            profiles, credentials = _sync_builtin_profiles(
                provider, fetched, profiles, base, credentials, api_key.strip()
            )
    elif clear_api_key:
        credentials.pop(profile_id, None)
    elif new_key:
        credentials[profile_id] = api_key.strip()

    target = _profile_target(profile)
    if new_key:
        disabled.discard(target)
    elif clear_api_key:
        disabled.add(target)

    # Drop credentials whose profile no longer exists (e.g. a provider removed
    # a model, or an entry was deleted elsewhere).
    profile_ids = {current["id"] for current in profiles}
    for key in list(credentials):
        if key not in profile_ids:
            credentials.pop(key, None)

    if not profiles:
        profiles = [_default_profile(base)]

    active = _active_after_save(catalog, profiles, profile, explicit, activate)
    _write_model_state(user_dir, active=active, profiles=profiles, disabled=disabled)
    write_json_atomic(user_dir / CREDENTIALS_FILE, credentials, private=True)
    return load_model_catalog(workspace, home=home)


def _active_after_save(
    catalog: dict[str, Any],
    profiles: list[dict[str, Any]],
    profile: dict[str, Any],
    explicit: bool,
    activate: bool,
) -> str:
    if activate:
        if explicit:
            return profile["id"]
        provider_profiles = [current["id"] for current in profiles if current["provider"] == profile["provider"]]
        if provider_profiles:
            return provider_profiles[0]
    active = catalog["active"]
    return active if any(current["id"] == active for current in profiles) else profiles[0]["id"]


def delete_model_profile(workspace: Path, profile_id: str, *, home: Path | None = None) -> dict[str, Any]:
    catalog = load_model_catalog(workspace, home=home)
    removed = next((profile for profile in catalog["profiles"] if profile["id"] == profile_id), None)
    profiles = [profile for profile in catalog["profiles"] if profile["id"] != profile_id]
    if not profiles:
        raise ValueError("Friday needs at least one model configuration.")
    active = catalog["active"] if catalog["active"] != profile_id else profiles[0]["id"]
    user_dir = friday_home(home)
    disabled = set(catalog.get("disabled") or [])
    if removed and removed["provider"] == "openai-compatible":
        disabled.discard(_profile_target(removed))
    _write_model_state(user_dir, active=active, profiles=profiles, disabled=disabled)
    credentials = _read_credentials(home)
    credentials.pop(profile_id, None)
    write_json_atomic(user_dir / CREDENTIALS_FILE, credentials, private=True)
    return load_model_catalog(workspace, home=home)


def select_model_profile(workspace: Path, profile_id: str, *, home: Path | None = None) -> dict[str, Any]:
    catalog = load_model_catalog(workspace, home=home)
    selected = next((profile for profile in catalog["profiles"] if profile["id"] == profile_id), None)
    if selected is None:
        raise ValueError(f"Unknown Friday model configuration: {profile_id}")
    if not selected.get("enabled"):
        raise ValueError("Enable this model provider before selecting it.")
    _write_model_state(
        friday_home(home),
        active=profile_id,
        profiles=catalog["profiles"],
        disabled=set(catalog.get("disabled") or []),
    )
    return load_model_catalog(workspace, home=home)


def read_model_credential(
    workspace: Path,
    *,
    provider_id: str = "",
    profile_id: str = "",
    home: Path | None = None,
) -> str:
    catalog = load_model_catalog(workspace, home=home)
    profiles = catalog["profiles"]
    if profile_id:
        profiles = [profile for profile in profiles if profile["id"] == profile_id]
    elif provider_id:
        profiles = [profile for profile in profiles if profile["provider"] == provider_id]
    else:
        raise ValueError("A model provider or profile is required.")
    if profile_id and not profiles:
        raise ValueError(f"Unknown Friday model configuration: {profile_id}")
    credentials = _read_credentials(home)
    stored = next((credentials.get(profile["id"]) for profile in profiles if credentials.get(profile["id"])), None)
    provider = provider_id or (str(profiles[0]["provider"]) if profiles else "")
    return str(stored or _provider_env(provider) or "")


def clear_model_credential(
    workspace: Path,
    *,
    provider_id: str = "",
    profile_id: str = "",
    home: Path | None = None,
) -> dict[str, Any]:
    catalog = load_model_catalog(workspace, home=home)
    profiles = catalog["profiles"]
    if profile_id:
        targets = [profile for profile in profiles if profile["id"] == profile_id]
    elif provider_id:
        targets = [profile for profile in profiles if profile["provider"] == provider_id]
    else:
        raise ValueError("A model provider or profile is required.")
    if profile_id and not targets:
        raise ValueError(f"Unknown Friday model configuration: {profile_id}")

    credentials = _read_credentials(home)
    for profile in targets:
        credentials.pop(profile["id"], None)
    disabled = set(catalog.get("disabled") or [])
    disabled.add(f"profile:{profile_id}" if profile_id else f"provider:{provider_id}")
    target_ids = {profile["id"] for profile in targets}
    active = catalog["active"]
    remaining = [profile for profile in profiles if profile.get("enabled") and profile["id"] not in target_ids]
    if active in target_ids and remaining:
        active = remaining[0]["id"]
    user_dir = friday_home(home)
    _write_model_state(
        user_dir,
        active=active,
        profiles=profiles,
        disabled=disabled,
    )
    write_json_atomic(user_dir / CREDENTIALS_FILE, credentials, private=True)
    return load_model_catalog(workspace, home=home)


def set_model_enabled(
    workspace: Path,
    enabled: bool,
    *,
    provider_id: str = "",
    profile_id: str = "",
    home: Path | None = None,
) -> dict[str, Any]:
    catalog = load_model_catalog(workspace, home=home)
    profiles = catalog["profiles"]
    if profile_id:
        targets = [profile for profile in profiles if profile["id"] == profile_id]
        target = f"profile:{profile_id}"
        configured = bool(targets and targets[0]["api_key_configured"])
    elif provider_id:
        provider = next((item for item in catalog["providers"] if item["id"] == provider_id), None)
        if provider is None or not provider.get("builtin"):
            raise ValueError(f"Unknown built-in model provider: {provider_id}")
        targets = [profile for profile in profiles if profile["provider"] == provider_id]
        target = f"provider:{provider_id}"
        configured = bool(provider["api_key_configured"])
    else:
        raise ValueError("A model provider or profile is required.")
    if profile_id and not targets:
        raise ValueError(f"Unknown Friday model configuration: {profile_id}")
    if enabled and not configured:
        raise ValueError("Add an API key before enabling this provider.")

    disabled = set(catalog.get("disabled") or [])
    active = catalog["active"]
    if enabled:
        disabled.discard(target)
    else:
        target_ids = {profile["id"] for profile in targets}
        remaining = [
            profile
            for profile in profiles
            if profile.get("enabled") and profile["id"] not in target_ids
        ]
        if active in target_ids and not remaining:
            raise ValueError("Enable another provider before disabling the active model.")
        disabled.add(target)
        if active in target_ids:
            active = remaining[0]["id"]
    _write_model_state(
        friday_home(home),
        active=active,
        profiles=profiles,
        disabled=disabled,
    )
    return load_model_catalog(workspace, home=home)


def refresh_model_profiles(
    workspace: Path,
    *,
    provider_id: str = "",
    profile_id: str = "",
    home: Path | None = None,
) -> tuple[dict[str, Any], list[str]]:
    catalog = load_model_catalog(workspace, home=home)
    api_key = read_model_credential(
        workspace,
        provider_id=provider_id,
        profile_id=profile_id,
        home=home,
    )
    if not api_key:
        raise ValueError("Add an API key before refreshing models.")

    if profile_id:
        profile = next((item for item in catalog["profiles"] if item["id"] == profile_id), None)
        if profile is None:
            raise ValueError(f"Unknown Friday model configuration: {profile_id}")
        models = fetch_provider_models(profile["provider"], profile["base_url"], api_key)
        return catalog, models

    provider = _provider(provider_id)
    if not provider.get("builtin"):
        raise ValueError(f"Unknown built-in model provider: {provider_id}")
    fetched = _fetch_models(provider, api_key)
    models = fetched if fetched is not None else [str(item["id"]) for item in provider["models"]]
    base = _load_base_config(workspace, home=home)
    credentials = _read_credentials(home)
    profiles, credentials = _sync_builtin_profiles(
        provider,
        models,
        [_stored_profile(profile) for profile in catalog["profiles"]],
        base,
        credentials,
        api_key,
    )
    user_dir = friday_home(home)
    _write_model_state(
        user_dir,
        active=catalog["active"],
        profiles=profiles,
        disabled=set(catalog.get("disabled") or []),
    )
    write_json_atomic(user_dir / CREDENTIALS_FILE, credentials, private=True)
    return load_model_catalog(workspace, home=home), models


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


def read_web_search_credential(provider: str, *, home: Path | None = None) -> str:
    env_name = WEB_SEARCH_KEYS.get(provider)
    if not env_name:
        raise ValueError(f"Unknown web search provider: {provider}")
    return str(_read_web_credentials(home).get(env_name) or os.getenv(env_name) or "")


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
            _INJECTED_ENV_NAMES.add(env_name)
    write_json_atomic(friday_home(home) / WEB_CREDENTIALS_FILE, saved, private=True)
    for env_name, previous in cleared:
        if previous and os.getenv(env_name) == previous:
            os.environ.pop(env_name, None)
    if cleared:
        load_model_environment(workspace, home=home)
    return load_web_search_settings(workspace, home=home)


def load_feishu_settings(workspace: Path, *, home: Path | None = None) -> dict[str, Any]:
    """What the settings UI may see. The app secret is reported, never returned."""
    saved = _read_json_object(friday_home(home) / FEISHU_FILE)
    stored_secret = str(saved.get("app_secret") or "").strip()
    return {
        "app_id": str(saved.get("app_id") or os.getenv("FRIDAY_FEISHU_APP_ID") or "").strip(),
        "app_secret_configured": bool(
            stored_secret
            or os.getenv("FRIDAY_FEISHU_APP_SECRET")
            or _env_files_have_names(workspace, {"FRIDAY_FEISHU_APP_SECRET"}, home)
        ),
        "allowed_users": _feishu_users(saved.get("allowed_users")),
        "allow_group": bool(saved.get("allow_group")),
    }


def feishu_credentials(*, home: Path | None = None) -> dict[str, Any]:
    """Everything the bridge itself needs, secret included."""
    saved = _read_json_object(friday_home(home) / FEISHU_FILE)
    return {
        "app_id": str(saved.get("app_id") or "").strip(),
        "app_secret": str(saved.get("app_secret") or "").strip(),
        "allowed_users": _feishu_users(saved.get("allowed_users")),
        "allow_group": bool(saved.get("allow_group")),
    }


def read_feishu_credential(*, home: Path | None = None) -> str:
    """Return the secret for an explicit reveal action in settings."""
    return str(feishu_credentials(home=home)["app_secret"] or os.getenv("FRIDAY_FEISHU_APP_SECRET") or "")


def save_feishu_settings(
    workspace: Path,
    *,
    app_id: str | None = None,
    app_secret: str | None = None,
    allowed_users: list[str] | str | None = None,
    allow_group: bool | None = None,
    clear_app_secret: bool = False,
    home: Path | None = None,
) -> dict[str, Any]:
    saved = _read_json_object(friday_home(home) / FEISHU_FILE)
    if app_id is not None:
        saved["app_id"] = app_id.strip()
    if clear_app_secret:
        saved.pop("app_secret", None)
    elif app_secret is not None and app_secret.strip():
        secret = app_secret.strip()
        if len(secret) > 4096 or "\n" in secret or "\r" in secret:
            raise ValueError("Invalid Feishu app secret.")
        saved["app_secret"] = secret
    if allowed_users is not None:
        saved["allowed_users"] = _feishu_users(allowed_users)
    if allow_group is not None:
        saved["allow_group"] = bool(allow_group)
    write_json_atomic(friday_home(home) / FEISHU_FILE, saved, private=True)
    return load_feishu_settings(workspace, home=home)


def _feishu_users(value: Any) -> list[str]:
    """Accept a list or a comma separated string, and keep the order stable."""
    if isinstance(value, str):
        items = value.replace("\n", ",").split(",")
    elif isinstance(value, (list, tuple)):
        items = [str(item) for item in value]
    else:
        return []
    return list(dict.fromkeys(item.strip() for item in items if str(item).strip()))


def output_token_limit(config: ModelConfig, value: int) -> dict[str, int]:
    if model_api_mode(config.provider, config.model) == "responses":
        return {"max_output_tokens": min(value, config.max_output_tokens)}
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
    if not api_key:
        raise ValueError(
            f"Model '{config.profile_name}' has no API key. Configure it in Friday Settings "
            "or run `friday model add --help`."
        )
    mode = model_api_mode(config.provider, config.model)
    if mode == "messages":
        # Imported here, not at module scope: the Anthropic SDK pulls in ~1400
        # modules and ~41 MB of resident memory, and every Friday process imports
        # this module. The desktop runs one backend per open project, so that
        # baseline is paid per project -- by users on other providers too.
        from friday.providers import AnthropicModel

        base_url = config.base_url or None
        if config.provider == "opencode-go" and base_url:
            base_url = base_url.removesuffix("/v1")
        return AnthropicModel(api_key=api_key, base_url=base_url, model=config.model)
    if mode == "responses":
        from friday.providers import ResponsesModel

        return ResponsesModel(api_key=api_key, base_url=config.base_url or None, model=config.model)
    return LLM(
        api_key=api_key,
        base_url=config.base_url or None,
        model=config.model,
    )


IM_BRIDGE_ENV_NAMES = (
    "FRIDAY_FEISHU_ALLOW_GROUP",
    "FRIDAY_FEISHU_ALLOWED_USERS",
    "FRIDAY_FEISHU_APP_ID",
    "FRIDAY_FEISHU_APP_SECRET",
)


def load_model_environment(workspace: Path, *, home: Path | None = None) -> None:
    allowed = {
        "ANYSEARCH_API_KEY",
        "JINA_API_KEY",
        "TAVILY_API_KEY",
        *IM_BRIDGE_ENV_NAMES,
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
            _INJECTED_ENV_NAMES.add(key)
    web_credentials = _read_web_credentials(home)
    os.environ.update(web_credentials)
    _INJECTED_ENV_NAMES.update(web_credentials)


def injected_env_names() -> frozenset[str]:
    """Credential variables Friday loaded from its own stores into this process."""
    return frozenset(_INJECTED_ENV_NAMES)


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
    profile_id = _profile_id(str(value.get("id") or ""))
    provider = str(value.get("provider") or "").strip().lower()
    name = str(value.get("name") or "").strip()
    model = str(value.get("model") or "").strip()
    base_url = str(value.get("base_url") or "").strip().rstrip("/")
    if not profile_id or not name:
        raise ValueError("Model configuration id and name are required.")
    if provider not in {item["id"] for item in PROVIDERS}:
        raise ValueError(f"Unsupported model provider: {provider}")
    entry = _provider(provider)
    if entry.get("builtin"):
        # A built-in provider's base URL is fixed; an empty value means the
        # provider default, and an empty model marks a key-only save whose
        # profiles come from the provider's model list.
        base_url = base_url or str(entry["base_url"])
        if base_url and not re.match(r"^https?://", base_url):
            raise ValueError("Model Base URL must start with http:// or https://.")
    else:
        if not model:
            raise ValueError("Model configuration model is required.")
        if not base_url or not re.match(r"^https?://", base_url):
            raise ValueError(
                "Model Base URL is required for OpenAI-compatible providers and must start with http:// or https://."
            )
    numbers: dict[str, int] = {}
    for key in ("context_window", "max_output_tokens", "run_token_budget"):
        raw = value.get(key, getattr(base, key))
        if not isinstance(raw, int) or isinstance(raw, bool) or raw < 1:
            raise ValueError(f"Model configuration '{key}' must be a positive integer.")
        numbers[key] = raw
    if numbers["max_output_tokens"] > numbers["context_window"]:
        raise ValueError("Maximum output tokens cannot exceed the context window.")
    result = {
        "id": profile_id,
        "name": name,
        "provider": provider,
        "model": model,
        "base_url": base_url,
        "vision": _supports_vision(provider, model),
        **numbers,
    }
    if value.get("auto"):
        result["auto"] = True
    return result


def _supports_vision(provider: str, model: str) -> bool:
    lowered = model.lower()
    known = next(
        (item for item in _provider(provider).get("models", ()) if item["id"] == model),
        None,
    )
    if known is not None:
        return bool(known["vision"])
    if provider == "mimo":
        return lowered == "mimo-v2.5"
    if provider == "anthropic":
        return lowered.startswith("claude-")
    if provider == "openai":
        return lowered.startswith(("gpt-4o", "gpt-4.1", "gpt-5"))
    # Unknown models default to text-only: rejecting an image is safe, sending
    # one to a model that cannot see it is not.
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
        "OPENCODE_API_KEY" if provider == "opencode-go" else "",
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


def _first_env(*names: str) -> str | None:
    return next((value for name in names if name and (value := os.getenv(name))), None)
