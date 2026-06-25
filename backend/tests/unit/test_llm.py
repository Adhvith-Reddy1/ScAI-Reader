from __future__ import annotations

import pytest

from app import ai, llm
from app.ai import ProviderConfig


def _collect(gen):
    async def run():
        return [e async for e in gen]

    import asyncio

    return asyncio.run(run())


def test_no_config_yields_not_configured_error():
    events = _collect(
        llm.stream_completion(
            None, system="s", messages=[llm.user_text("hi")], max_tokens=10
        )
    )
    assert events == [("error", ai.AI_NOT_CONFIGURED_MESSAGE)]


def test_missing_model_for_compatible_yields_error():
    # openai_compatible has no default model; resolve_model returns "".
    cfg = ProviderConfig(
        "openai_compatible", "key", model=None, base_url="http://x/v1"
    )
    events = _collect(
        llm.stream_completion(
            cfg, system="s", messages=[llm.user_text("hi")], max_tokens=10
        )
    )
    assert len(events) == 1 and events[0][0] == "error"
    assert "model" in events[0][1].lower()


def test_anthropic_content_translation():
    content = [llm.text_part("hello"), llm.image_part("image/png", "AAAA")]
    out = llm._anthropic_content(content)
    assert out[0] == {"type": "text", "text": "hello"}
    assert out[1]["type"] == "image"
    assert out[1]["source"]["media_type"] == "image/png"
    assert out[1]["source"]["data"] == "AAAA"
    # Plain strings pass through unchanged.
    assert llm._anthropic_content("plain") == "plain"


def test_openai_content_translation():
    content = [llm.text_part("hello"), llm.image_part("image/png", "AAAA")]
    out = llm._openai_content(content)
    assert out[0] == {"type": "text", "text": "hello"}
    assert out[1]["type"] == "image_url"
    assert out[1]["image_url"]["url"] == "data:image/png;base64,AAAA"
    assert llm._openai_content("plain") == "plain"


def test_validate_config_network_error_warns_not_raises(monkeypatch):
    import anthropic

    class _Boom:
        def list(self, *a, **k):
            raise RuntimeError("connection refused")

    class _Client:
        models = _Boom()

    monkeypatch.setattr(anthropic, "Anthropic", lambda **k: _Client())
    validated, warning = llm.validate_config(
        ProviderConfig("anthropic", "sk-ant-x")
    )
    assert validated is False
    assert warning and "couldn't reach" in warning


def test_validate_config_success(monkeypatch):
    import anthropic

    class _Ok:
        def list(self, *a, **k):
            return ["model"]

    class _Client:
        models = _Ok()

    monkeypatch.setattr(anthropic, "Anthropic", lambda **k: _Client())
    validated, warning = llm.validate_config(
        ProviderConfig("anthropic", "sk-ant-x")
    )
    assert validated is True
    assert warning is None
