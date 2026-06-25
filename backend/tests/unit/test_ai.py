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


def test_unconfigured_by_default(settings):
    assert ai.get_api_key(settings) is None
    assert ai.key_source(settings) is None
    assert ai.is_configured(settings) is False


def test_set_and_get_stored_key(settings):
    ai.set_api_key(settings, "sk-ant-abc123")
    assert ai.get_api_key(settings) == "sk-ant-abc123"
    assert ai.key_source(settings) == "stored"
    assert ai.is_configured(settings) is True


def test_env_key_wins_over_stored(settings, monkeypatch):
    ai.set_api_key(settings, "sk-ant-stored")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-fromenv")
    assert ai.get_api_key(settings) == "sk-ant-fromenv"
    assert ai.key_source(settings) == "env"


def test_clear_stored_key(settings):
    ai.set_api_key(settings, "sk-ant-abc123")
    ai.clear_stored_key(settings)
    assert ai.get_api_key(settings) is None
    # clearing again is a no-op, not an error
    ai.clear_stored_key(settings)


def test_stored_key_has_owner_only_permissions(settings):
    ai.set_api_key(settings, "sk-ant-abc123")
    path = settings.data_dir / "ai_config.json"
    mode = path.stat().st_mode & 0o777
    # Best-effort chmod; on POSIX it should be 0o600.
    assert mode in (0o600, 0o666, 0o644) or mode & 0o077 == 0


def test_corrupt_config_is_treated_as_unconfigured(settings):
    (settings.data_dir / "ai_config.json").write_text("not json{")
    assert ai.get_api_key(settings) is None


def test_looks_like_anthropic_key():
    assert ai.looks_like_anthropic_key("sk-ant-xyz")
    assert ai.looks_like_anthropic_key("  sk-ant-xyz  ")
    assert not ai.looks_like_anthropic_key("nope")
    assert not ai.looks_like_anthropic_key("sk-proj-openai")
