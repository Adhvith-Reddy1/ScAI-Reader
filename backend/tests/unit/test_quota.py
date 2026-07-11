"""Unit tests for app.quota — the daily AI-call counter keyed by an anonymous
per-browser client id (never a user account; see app.quota's module docstring)."""

from __future__ import annotations

from types import SimpleNamespace

from app import quota


def _settings(tmp_path):
    from app.config import Settings
    from app.storage import db

    data_dir = tmp_path / "data"
    settings = Settings(
        data_dir=data_dir,
        db_path=data_dir / "reader.db",
        pdf_dir=data_dir / "pdfs",
        render_cache_dir=data_dir / "renders",
    )
    settings.ensure_dirs()
    db.init_db(settings.db_path)
    return settings


def test_try_consume_allows_up_to_the_limit(tmp_path):
    settings = _settings(tmp_path)
    for _ in range(3):
        assert quota.try_consume(settings, "id:abc", limit=3) is True
    assert quota.try_consume(settings, "id:abc", limit=3) is False


def test_try_consume_tracks_clients_independently(tmp_path):
    settings = _settings(tmp_path)
    for _ in range(2):
        assert quota.try_consume(settings, "id:a", limit=2) is True
    # A different client still has its own untouched budget.
    assert quota.try_consume(settings, "id:b", limit=2) is True
    assert quota.try_consume(settings, "id:a", limit=2) is False


def test_resolve_client_key_trusts_a_well_formed_header():
    request = SimpleNamespace(client=SimpleNamespace(host="203.0.113.5"))
    key = quota.resolve_client_key(request, "a1b2c3d4-e5f6-4789-9abc-1234567890ab")
    assert key == "id:a1b2c3d4-e5f6-4789-9abc-1234567890ab"


def test_resolve_client_key_falls_back_to_ip_when_missing():
    request = SimpleNamespace(client=SimpleNamespace(host="203.0.113.5"))
    assert quota.resolve_client_key(request, None) == "ip:203.0.113.5"


def test_resolve_client_key_falls_back_to_ip_when_malformed():
    request = SimpleNamespace(client=SimpleNamespace(host="203.0.113.5"))
    # Too short / contains disallowed characters — don't trust it as an id.
    assert quota.resolve_client_key(request, "bad id!") == "ip:203.0.113.5"
