from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _clear_env(monkeypatch):
    # Tests assert behaviour with no env key; don't let the dev shell leak in.
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)


@pytest.mark.integration
def test_status_unconfigured_by_default(app_client):
    r = app_client.get("/settings/ai")
    assert r.status_code == 200
    assert r.json() == {"configured": False, "source": None, "editable": True}


@pytest.mark.integration
def test_save_key_then_status_configured(app_client):
    # validate_key=False so the test never reaches out to Anthropic.
    r = app_client.put(
        "/settings/ai",
        json={"api_key": "sk-ant-test-1234567890", "validate_key": False},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["configured"] is True
    assert body["source"] == "stored"

    r2 = app_client.get("/settings/ai")
    assert r2.json()["configured"] is True
    assert r2.json()["editable"] is True


@pytest.mark.integration
def test_save_malformed_key_rejected(app_client):
    r = app_client.put(
        "/settings/ai",
        json={"api_key": "totally-not-a-key", "validate_key": False},
    )
    assert r.status_code == 400
    assert "sk-ant-" in r.json()["detail"]


@pytest.mark.integration
def test_empty_key_rejected(app_client):
    r = app_client.put("/settings/ai", json={"api_key": "", "validate_key": False})
    assert r.status_code == 422


@pytest.mark.integration
def test_delete_key(app_client):
    app_client.put(
        "/settings/ai",
        json={"api_key": "sk-ant-test-1234567890", "validate_key": False},
    )
    r = app_client.delete("/settings/ai")
    assert r.status_code == 200
    assert r.json()["configured"] is False
    assert app_client.get("/settings/ai").json()["configured"] is False


@pytest.mark.integration
def test_env_key_is_not_editable(app_client, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-fromenv")
    status = app_client.get("/settings/ai").json()
    assert status == {"configured": True, "source": "env", "editable": False}

    # Can't overwrite an env-provided key from the UI.
    r = app_client.put(
        "/settings/ai",
        json={"api_key": "sk-ant-other", "validate_key": False},
    )
    assert r.status_code == 409
    # And can't delete it either.
    assert app_client.delete("/settings/ai").status_code == 409
