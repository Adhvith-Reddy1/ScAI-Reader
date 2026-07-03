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


def test_is_gemini_endpoint():
    assert llm._is_gemini_endpoint(
        "https://generativelanguage.googleapis.com/v1beta/openai/"
    )
    assert not llm._is_gemini_endpoint("https://api.openai.com/v1")
    assert not llm._is_gemini_endpoint(None)


def test_gemini_endpoint_disables_thinking_via_reasoning_effort(monkeypatch):
    """Gemini's OpenAI-compatible endpoint bills hidden "thinking" tokens out
    of the same max_tokens budget as the visible answer, so a short cap (kept
    small for snappy tooltips) can get consumed by invisible reasoning and
    truncate the visible reply to a couple of words. We must explicitly send
    reasoning_effort="none" for Gemini endpoints to avoid this."""
    captured: dict = {}

    class _FakeStream:
        def __aiter__(self):
            async def gen():
                return
                yield  # pragma: no cover - empty async generator

            return gen()

    class _FakeCompletions:
        async def create(self, **kwargs):
            captured.update(kwargs)
            return _FakeStream()

    class _FakeChat:
        completions = _FakeCompletions()

    class _FakeClient:
        def __init__(self, **kwargs):
            pass

        chat = _FakeChat()

    import openai

    monkeypatch.setattr(openai, "AsyncOpenAI", _FakeClient)

    cfg = ProviderConfig(
        "openai",
        "key",
        model="gemini-2.5-flash",
        base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
    )
    _collect(
        llm.stream_completion(
            cfg, system="s", messages=[llm.user_text("hi")], max_tokens=80
        )
    )
    assert captured.get("extra_body") == {"reasoning_effort": "none"}


def test_non_gemini_endpoint_does_not_send_reasoning_effort(monkeypatch):
    captured: dict = {}

    class _FakeStream:
        def __aiter__(self):
            async def gen():
                return
                yield  # pragma: no cover

            return gen()

    class _FakeCompletions:
        async def create(self, **kwargs):
            captured.update(kwargs)
            return _FakeStream()

    class _FakeChat:
        completions = _FakeCompletions()

    class _FakeClient:
        def __init__(self, **kwargs):
            pass

        chat = _FakeChat()

    import openai

    monkeypatch.setattr(openai, "AsyncOpenAI", _FakeClient)

    cfg = ProviderConfig("openai", "key", model="gpt-4o-mini")
    _collect(
        llm.stream_completion(
            cfg, system="s", messages=[llm.user_text("hi")], max_tokens=80
        )
    )
    assert "extra_body" not in captured


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
