"""LLM provider configuration and key storage.

The AI features need a provider + key. To keep non-technical users out of the
terminal, this is configured in-app and stored in the data directory. The app
supports Anthropic natively and any OpenAI-compatible endpoint (OpenAI, Azure
OpenAI, OpenRouter, Groq, Together, and local servers like Ollama/LM Studio via
a custom base URL).

Environment variables still win when present (advanced/hosted setups):
``ANTHROPIC_API_KEY`` selects Anthropic, otherwise ``OPENAI_API_KEY`` selects
OpenAI. The actual streaming lives in ``app.llm`` (which imports from here).
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

from .config import Settings

# Shown to the reader (and matched by the frontend) when no provider is set up.
AI_NOT_CONFIGURED_MESSAGE = (
    "AI isn't set up yet. Choose a provider and add an API key under "
    "“AI Setup” to turn on explanations."
)
# Stable code on the SSE error frame so the UI can offer one-click setup.
AI_NOT_CONFIGURED_CODE = "ai_not_configured"

# Recognised providers. "openai_compatible" is OpenAI's wire protocol pointed at
# a custom base URL (covers Azure, Groq, Together, Ollama, …); "openrouter" is a
# named preset for that protocol with a fixed base URL.
PROVIDERS = ("anthropic", "openai", "openrouter", "openai_compatible")

# Providers that speak the OpenAI wire protocol (handled by the OpenAI client).
OPENAI_FAMILY = ("openai", "openrouter", "openai_compatible")

# Fixed base URLs for named presets. openai_compatible supplies its own.
DEFAULT_BASE_URLS: dict[str, str] = {
    "openrouter": "https://openrouter.ai/api/v1",
}

# Per-provider default models for the two quality tiers the app uses: "fast"
# for short glossary definitions, "good" for explanations/chat/figures. A
# user-supplied model overrides both tiers.
DEFAULT_MODELS: dict[str, dict[str, str]] = {
    "anthropic": {"fast": "claude-haiku-4-5", "good": "claude-sonnet-4-6"},
    "openai": {"fast": "gpt-4o-mini", "good": "gpt-4o"},
    "openrouter": {"fast": "openai/gpt-4o-mini", "good": "openai/gpt-4o"},
    # openai_compatible has no sensible default — the model is required.
}

_CONFIG_FILENAME = "ai_config.json"


@dataclass(frozen=True)
class ProviderConfig:
    provider: str
    api_key: str
    model: str | None = None
    base_url: str | None = None
    source: str = "stored"  # "stored" | "env"

    def resolve_model(self, tier: str) -> str:
        if self.model:
            return self.model
        return DEFAULT_MODELS.get(self.provider, {}).get(tier, "")

    def resolve_base_url(self) -> str | None:
        """The base URL to talk to: an explicit one wins, else a preset's."""
        return self.base_url or DEFAULT_BASE_URLS.get(self.provider)


def _config_path(settings: Settings) -> Path:
    return settings.data_dir / _CONFIG_FILENAME


def _read_stored(settings: Settings) -> dict | None:
    path = _config_path(settings)
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    key = data.get("api_key")
    if not isinstance(key, str) or not key.strip():
        return None
    return data


def get_provider_config(settings: Settings) -> ProviderConfig | None:
    """Resolve the active provider config: env vars first, then stored file."""
    env_anthropic = os.environ.get("ANTHROPIC_API_KEY")
    if env_anthropic and env_anthropic.strip():
        return ProviderConfig("anthropic", env_anthropic.strip(), source="env")
    env_openai = os.environ.get("OPENAI_API_KEY")
    if env_openai and env_openai.strip():
        base = os.environ.get("OPENAI_BASE_URL") or None
        return ProviderConfig(
            "openai", env_openai.strip(), base_url=base, source="env"
        )

    stored = _read_stored(settings)
    if stored is None:
        return None
    provider = stored.get("provider")
    if provider not in PROVIDERS:
        provider = "anthropic"  # back-compat: old files stored only api_key
    model = stored.get("model") or None
    base_url = stored.get("base_url") or None
    return ProviderConfig(
        provider=provider,
        api_key=stored["api_key"].strip(),
        model=model,
        base_url=base_url,
        source="stored",
    )


def key_source(settings: Settings) -> str | None:
    cfg = get_provider_config(settings)
    return cfg.source if cfg else None


def is_configured(settings: Settings) -> bool:
    return get_provider_config(settings) is not None


def set_provider_config(
    settings: Settings,
    provider: str,
    api_key: str,
    model: str | None = None,
    base_url: str | None = None,
) -> None:
    """Persist provider config to the data dir with owner-only permissions."""
    path = _config_path(settings)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "provider": provider,
        "api_key": api_key.strip(),
        "model": (model or "").strip() or None,
        "base_url": (base_url or "").strip() or None,
    }
    path.write_text(json.dumps(payload))
    try:
        path.chmod(0o600)
    except OSError:
        # Best-effort on filesystems without chmod (e.g. Windows).
        pass


def clear_stored_config(settings: Settings) -> None:
    """Remove the stored config. Env vars, if any, are untouched."""
    path = _config_path(settings)
    if path.is_file():
        path.unlink()


def key_format_hint(provider: str, key: str) -> str | None:
    """Return a human hint if the key obviously doesn't match the provider,
    else None. OpenAI-compatible endpoints (incl. local) accept any token."""
    k = key.strip()
    if provider == "anthropic" and not k.startswith("sk-ant-"):
        return "Anthropic keys start with “sk-ant-”. Copy it from console.anthropic.com."
    if provider == "openai" and not k.startswith("sk-"):
        return "OpenAI keys start with “sk-”. Copy it from platform.openai.com/api-keys."
    return None
