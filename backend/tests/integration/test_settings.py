from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _clear_env(monkeypatch):
    # Tests assert behaviour with no env key; don't let the dev shell leak in.
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)


@pytest.mark.integration
def test_status_unconfigured_by_default(app_client):
    r = app_client.get("/settings/ai")
    assert r.status_code == 200
    body = r.json()
    assert body["configured"] is False
    assert body["provider"] is None


@pytest.mark.integration
def test_save_anthropic_then_status(app_client):
    # validate_key=False so the test never reaches out over the network.
    r = app_client.put(
        "/settings/ai",
        json={
            "provider": "anthropic",
            "api_key": "sk-ant-test-123",
            "validate_key": False,
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["configured"] is True
    assert body["provider"] == "anthropic"
    assert body["source"] == "stored"

    status = app_client.get("/settings/ai").json()
    assert status["configured"] is True
    assert status["provider"] == "anthropic"
    assert status["editable"] is True


@pytest.mark.integration
def test_save_openai_with_model(app_client):
    r = app_client.put(
        "/settings/ai",
        json={
            "provider": "openai",
            "api_key": "sk-openai-123",
            "model": "gpt-4o",
            "validate_key": False,
        },
    )
    assert r.status_code == 200
    assert r.json()["model"] == "gpt-4o"


@pytest.mark.integration
def test_openai_compatible_requires_base_url_and_model(app_client):
    # Missing base URL.
    r = app_client.put(
        "/settings/ai",
        json={
            "provider": "openai_compatible",
            "api_key": "ollama",
            "model": "llama3.1",
            "validate_key": False,
        },
    )
    assert r.status_code == 400
    assert "base URL" in r.json()["detail"]

    # Missing model.
    r2 = app_client.put(
        "/settings/ai",
        json={
            "provider": "openai_compatible",
            "api_key": "ollama",
            "base_url": "http://localhost:11434/v1",
            "validate_key": False,
        },
    )
    assert r2.status_code == 400
    assert "model" in r2.json()["detail"]

    # Both present → ok.
    r3 = app_client.put(
        "/settings/ai",
        json={
            "provider": "openai_compatible",
            "api_key": "ollama",
            "model": "llama3.1",
            "base_url": "http://localhost:11434/v1",
            "validate_key": False,
        },
    )
    assert r3.status_code == 200


@pytest.mark.integration
def test_save_openrouter_without_base_url(app_client):
    # OpenRouter needs no base URL from the user (it's a preset).
    r = app_client.put(
        "/settings/ai",
        json={
            "provider": "openrouter",
            "api_key": "sk-or-v1-abc",
            "validate_key": False,
        },
    )
    assert r.status_code == 200
    assert r.json()["provider"] == "openrouter"


@pytest.mark.integration
def test_unknown_provider_rejected(app_client):
    r = app_client.put(
        "/settings/ai",
        json={"provider": "cohere", "api_key": "x", "validate_key": False},
    )
    assert r.status_code == 400


@pytest.mark.integration
def test_malformed_key_for_provider_rejected(app_client):
    r = app_client.put(
        "/settings/ai",
        json={
            "provider": "anthropic",
            "api_key": "not-an-anthropic-key",
            "validate_key": False,
        },
    )
    assert r.status_code == 400
    assert "sk-ant-" in r.json()["detail"]


@pytest.mark.integration
def test_empty_key_rejected(app_client):
    r = app_client.put(
        "/settings/ai",
        json={"provider": "anthropic", "api_key": "", "validate_key": False},
    )
    assert r.status_code == 422


@pytest.mark.integration
def test_delete_config(app_client):
    app_client.put(
        "/settings/ai",
        json={
            "provider": "anthropic",
            "api_key": "sk-ant-test-123",
            "validate_key": False,
        },
    )
    r = app_client.delete("/settings/ai")
    assert r.status_code == 200
    assert r.json()["configured"] is False


@pytest.mark.integration
def test_env_key_is_not_editable(app_client, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-fromenv")
    status = app_client.get("/settings/ai").json()
    assert status["configured"] is True
    assert status["source"] == "env"
    assert status["editable"] is False

    r = app_client.put(
        "/settings/ai",
        json={
            "provider": "openai",
            "api_key": "sk-other",
            "validate_key": False,
        },
    )
    assert r.status_code == 409
    assert app_client.delete("/settings/ai").status_code == 409
