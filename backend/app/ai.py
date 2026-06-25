"""Anthropic API key management.

The AI features need a key. Rather than force users to export an environment
variable from a terminal, the key can be entered once inside the app and is
stored in the data directory. An ``ANTHROPIC_API_KEY`` environment variable
still wins when present (for advanced/hosted setups), so this layer just
augments the env var — it never overrides it.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from .config import Settings

# Shown to the reader (and matched by the frontend) when no key is available.
AI_NOT_CONFIGURED_MESSAGE = (
    "AI isn't set up yet. Add an Anthropic API key under “AI Setup” "
    "to turn on explanations."
)
# Stable code on the SSE error frame so the UI can offer a one-click setup.
AI_NOT_CONFIGURED_CODE = "ai_not_configured"

_CONFIG_FILENAME = "ai_config.json"


def _config_path(settings: Settings) -> Path:
    return settings.data_dir / _CONFIG_FILENAME


def get_api_key(settings: Settings) -> str | None:
    """Return the active API key: env var first, then the stored key."""
    env = os.environ.get("ANTHROPIC_API_KEY")
    if env and env.strip():
        return env.strip()
    path = _config_path(settings)
    if path.is_file():
        try:
            data = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            return None
        key = data.get("api_key")
        if isinstance(key, str) and key.strip():
            return key.strip()
    return None


def key_source(settings: Settings) -> str | None:
    """Where the active key comes from: 'env', 'stored', or None."""
    env = os.environ.get("ANTHROPIC_API_KEY")
    if env and env.strip():
        return "env"
    path = _config_path(settings)
    if path.is_file():
        try:
            data = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            return None
        key = data.get("api_key")
        if isinstance(key, str) and key.strip():
            return "stored"
    return None


def is_configured(settings: Settings) -> bool:
    return get_api_key(settings) is not None


def set_api_key(settings: Settings, key: str) -> None:
    """Persist the key to the data dir with owner-only permissions."""
    path = _config_path(settings)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"api_key": key.strip()}))
    try:
        path.chmod(0o600)
    except OSError:
        # Best-effort on filesystems that don't support chmod (e.g. Windows).
        pass


def clear_stored_key(settings: Settings) -> None:
    """Remove the stored key. The env var, if any, is untouched."""
    path = _config_path(settings)
    if path.is_file():
        path.unlink()


def looks_like_anthropic_key(key: str) -> bool:
    """Loose format check to catch obvious paste mistakes before a live call."""
    return key.strip().startswith("sk-ant-")
