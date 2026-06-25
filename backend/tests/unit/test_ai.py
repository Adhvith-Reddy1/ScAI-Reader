from __future__ import annotations

import pytest

from app import ai
from app.config import Settings


@pytest.fixture
def settings(tmp_path):
    data_dir = tmp_path / "data"
    s = Settings(
        data_dir=data_dir,
        db_path=data_dir / "reader.db",
        pdf_dir=data_dir / "pdfs",
        render_cache_dir=data_dir / "renders",
    )
    s.ensure_dirs()
    return s


@pytest.fixture(autouse=True)
def _clear_env(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)


def test_unconfigured_by_default(settings):
    assert ai.get_provider_config(settings) is None
    assert ai.key_source(settings) is None
    assert ai.is_configured(settings) is False


def test_set_and_get_anthropic(settings):
    ai.set_provider_config(settings, "anthropic", "sk-ant-abc")
    cfg = ai.get_provider_config(settings)
    assert cfg is not None
    assert cfg.provider == "anthropic"
    assert cfg.api_key == "sk-ant-abc"
    assert cfg.source == "stored"
    assert ai.key_source(settings) == "stored"


def test_set_and_get_openai_compatible(settings):
    ai.set_provider_config(
        settings,
        "openai_compatible",
        "ollama",
        model="llama3.1",
        base_url="http://localhost:11434/v1",
    )
    cfg = ai.get_provider_config(settings)
    assert cfg.provider == "openai_compatible"
    assert cfg.model == "llama3.1"
    assert cfg.base_url == "http://localhost:11434/v1"


def test_anthropic_env_wins(settings, monkeypatch):
    ai.set_provider_config(settings, "openai", "sk-stored")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-env")
    cfg = ai.get_provider_config(settings)
    assert cfg.provider == "anthropic"
    assert cfg.api_key == "sk-ant-env"
    assert cfg.source == "env"


def test_openai_env_used_when_no_anthropic(settings, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-env")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://example/v1")
    cfg = ai.get_provider_config(settings)
    assert cfg.provider == "openai"
    assert cfg.api_key == "sk-env"
    assert cfg.base_url == "https://example/v1"
    assert cfg.source == "env"


def test_legacy_config_without_provider_defaults_to_anthropic(settings):
    # Files written by the old single-key version had only {"api_key": ...}.
    (settings.data_dir / "ai_config.json").write_text('{"api_key": "sk-ant-old"}')
    cfg = ai.get_provider_config(settings)
    assert cfg.provider == "anthropic"
    assert cfg.api_key == "sk-ant-old"


def test_resolve_model_uses_tier_default(settings):
    ai.set_provider_config(settings, "anthropic", "sk-ant-abc")
    cfg = ai.get_provider_config(settings)
    assert cfg.resolve_model("fast") == ai.DEFAULT_MODELS["anthropic"]["fast"]
    assert cfg.resolve_model("good") == ai.DEFAULT_MODELS["anthropic"]["good"]


def test_resolve_model_user_override_wins(settings):
    ai.set_provider_config(settings, "openai", "sk-x", model="gpt-4.1")
    cfg = ai.get_provider_config(settings)
    assert cfg.resolve_model("fast") == "gpt-4.1"
    assert cfg.resolve_model("good") == "gpt-4.1"


def test_clear_stored_config(settings):
    ai.set_provider_config(settings, "anthropic", "sk-ant-abc")
    ai.clear_stored_config(settings)
    assert ai.get_provider_config(settings) is None
    ai.clear_stored_config(settings)  # idempotent


def test_stored_config_owner_only_permissions(settings):
    ai.set_provider_config(settings, "anthropic", "sk-ant-abc")
    mode = (settings.data_dir / "ai_config.json").stat().st_mode & 0o777
    assert mode == 0o600 or mode & 0o077 == 0


def test_corrupt_config_is_unconfigured(settings):
    (settings.data_dir / "ai_config.json").write_text("not json{")
    assert ai.get_provider_config(settings) is None


def test_key_format_hint():
    assert ai.key_format_hint("anthropic", "nope") is not None
    assert ai.key_format_hint("anthropic", "sk-ant-x") is None
    assert ai.key_format_hint("openai", "nope") is not None
    assert ai.key_format_hint("openai", "sk-x") is None
    # OpenAI-compatible (e.g. local) accepts any token.
    assert ai.key_format_hint("openai_compatible", "anything") is None
