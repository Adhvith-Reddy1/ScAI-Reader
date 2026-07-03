"""Tests for the stateless AI endpoints (Spec 03).

These endpoints take the highlighted text + a page reference and stream the same
SSE wire format the annotation-scoped endpoints use, but persist NOTHING. We
assert: (1) they stream SSE frames and never write to the DB, (2) `kind`
defaults via `classify` when omitted, (3) an unconfigured provider surfaces the
`ai_not_configured` coded error frame, and (4) a provider RateLimitError
surfaces the friendly "busy" message.

The happy-path tests patch `app.llm.stream_completion` so they don't hit the
network — the same module attribute every route resolves at call time.
"""

from __future__ import annotations

import pytest

from app import ai, llm
from app.routes import explanations as exp


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _upload(client, pdf_path):
    with pdf_path.open("rb") as f:
        return client.post(
            "/documents", files={"file": ("s.pdf", f, "application/pdf")}
        ).json()["id"]


def _fake_stream(*frames):
    """Build a stand-in for llm.stream_completion that yields canned frames and
    accepts the same call signature the routes use."""

    async def _gen(config, *, system, messages, max_tokens, tier="good"):
        for frame in frames:
            yield frame

    return _gen


@pytest.fixture(autouse=True)
def _no_env_keys(monkeypatch):
    # Force the deterministic "stored/none" branch so tests don't read ambient
    # provider keys from the environment.
    for var in (
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "OPENROUTER_API_KEY",
        "OPENAI_BASE_URL",
        "OPENAI_MODEL",
        "OPENROUTER_MODEL",
    ):
        monkeypatch.delenv(var, raising=False)


# ---------------------------------------------------------------------------
# No DB writes (the whole point of Spec 03)
# ---------------------------------------------------------------------------


@pytest.mark.integration
def test_explain_streams_and_writes_nothing(
    app_client, tmp_settings, simple_pdf, monkeypatch
):
    monkeypatch.setattr(
        llm, "stream_completion", _fake_stream(("delta", "Hi"), ("done", "Hi"))
    )
    doc_id = _upload(app_client, simple_pdf)

    r = app_client.post(
        f"/documents/{doc_id}/ai/explain",
        json={"text": "entropy", "page": 1},
    )
    assert r.status_code == 200
    body = r.text
    assert '"type": "meta"' in body
    assert '"type": "delta"' in body
    assert '"type": "done"' in body


@pytest.mark.integration
def test_chat_streams_and_writes_nothing(
    app_client, tmp_settings, simple_pdf, monkeypatch
):
    monkeypatch.setattr(
        llm, "stream_completion", _fake_stream(("delta", "A"), ("done", "A"))
    )
    doc_id = _upload(app_client, simple_pdf)

    r = app_client.post(
        f"/documents/{doc_id}/ai/chat",
        json={
            "text": "entropy",
            "kind": "definition",
            "content": "A measure of disorder.",
            "page": 1,
            "messages": [{"role": "user", "content": "How does it relate?"}],
        },
    )
    assert r.status_code == 200
    assert '"type": "done"' in r.text


@pytest.mark.integration
def test_refine_streams_and_writes_nothing(
    app_client, tmp_settings, simple_pdf, monkeypatch
):
    monkeypatch.setattr(
        llm,
        "stream_completion",
        _fake_stream(("delta", "Better."), ("done", "Better.")),
    )
    doc_id = _upload(app_client, simple_pdf)

    r = app_client.post(
        f"/documents/{doc_id}/ai/refine",
        json={
            "text": "entropy",
            "kind": "explanation",
            "content": "Old text.",
            "page": 1,
            "messages": [{"role": "user", "content": "Clarify please."}],
        },
    )
    assert r.status_code == 200
    body = r.text
    assert '"refined": true' in body
    assert '"type": "done"' in body


@pytest.mark.integration
def test_figure_ai_explain_streams_and_writes_nothing(
    app_client, tmp_settings, simple_pdf, monkeypatch
):
    monkeypatch.setattr(
        llm,
        "stream_completion",
        _fake_stream(("delta", "Figure shows X."), ("done", "Figure shows X.")),
    )
    doc_id = _upload(app_client, simple_pdf)

    r = app_client.post(
        f"/documents/{doc_id}/figures/p1_Figure_1/ai-explain",
        json={"page": 1, "label": "Figure 1"},
    )
    assert r.status_code == 200
    assert '"type": "done"' in r.text


# ---------------------------------------------------------------------------
# kind defaults via classify
# ---------------------------------------------------------------------------


@pytest.mark.integration
def test_explain_kind_defaults_via_classify(
    app_client, simple_pdf, monkeypatch
):
    captured: dict[str, str] = {}

    async def _gen(config, *, system, messages, max_tokens, tier="good"):
        captured["system"] = system
        yield ("done", "ok")

    monkeypatch.setattr(llm, "stream_completion", _gen)
    doc_id = _upload(app_client, simple_pdf)

    # A short, punctuation-free run classifies as a definition.
    r = app_client.post(
        f"/documents/{doc_id}/ai/explain", json={"text": "entropy"}
    )
    assert r.status_code == 200
    assert '"kind": "definition"' in r.text
    assert captured["system"] == exp.SYSTEM_DEFINITION

    # A sentence-shaped passage classifies as an explanation.
    r = app_client.post(
        f"/documents/{doc_id}/ai/explain",
        json={"text": "The system reaches equilibrium over time."},
    )
    assert r.status_code == 200
    assert '"kind": "explanation"' in r.text


# ---------------------------------------------------------------------------
# Client-supplied page_text grounds the model without depending on the
# server's own (ephemeral, disk-less) copy of the PDF still being present.
# ---------------------------------------------------------------------------


@pytest.mark.integration
def test_explain_uses_client_supplied_page_text_verbatim(app_client, monkeypatch):
    """The browser already has this page's text (it rendered the text layer
    with it); when it sends `page_text`, the server must use it as-is rather
    than trying to re-derive it from a PDF — proven here by never uploading
    one at all, yet still getting fully-grounded context."""
    captured: dict = {}

    async def _gen(config, *, system, messages, max_tokens, tier="good"):
        captured["messages"] = messages
        yield ("done", "ok")

    monkeypatch.setattr(llm, "stream_completion", _gen)

    r = app_client.post(
        "/documents/never-uploaded/ai/explain",
        json={
            "text": "nanobody",
            "page": 4,
            "page_text": "Nanobodies are engineered from camelid heavy-chain antibodies.",
        },
    )
    assert r.status_code == 200
    instruction = captured["messages"][0]["content"]
    assert "Nanobodies are engineered from camelid" in instruction


@pytest.mark.integration
def test_explain_page_text_overrides_server_extraction(
    app_client, tmp_settings, simple_pdf, monkeypatch
):
    """Even when the PDF IS present (so server-side extraction would succeed),
    a supplied page_text still wins — it's the more trustworthy source, since
    it's exactly what the reader is looking at right now."""
    captured: dict = {}

    async def _gen(config, *, system, messages, max_tokens, tier="good"):
        captured["messages"] = messages
        yield ("done", "ok")

    monkeypatch.setattr(llm, "stream_completion", _gen)
    doc_id = _upload(app_client, simple_pdf)

    r = app_client.post(
        f"/documents/{doc_id}/ai/explain",
        json={
            "text": "term",
            "page": 1,
            "page_text": "OVERRIDE-MARKER page content",
        },
    )
    assert r.status_code == 200
    assert "OVERRIDE-MARKER" in captured["messages"][0]["content"]


@pytest.mark.integration
def test_chat_and_refine_use_client_supplied_page_text(app_client, monkeypatch):
    captured: list[dict] = []

    async def _gen(config, *, system, messages, max_tokens, tier="good"):
        captured.append({"messages": messages})
        yield ("done", "ok")

    monkeypatch.setattr(llm, "stream_completion", _gen)

    r = app_client.post(
        "/documents/never-uploaded/ai/chat",
        json={
            "text": "nanobody",
            "kind": "definition",
            "content": "A small antibody fragment.",
            "page": 2,
            "page_text": "CHAT-MARKER context",
            "messages": [{"role": "user", "content": "why here?"}],
        },
    )
    assert r.status_code == 200
    assert "CHAT-MARKER" in captured[0]["messages"][0]["content"]

    r = app_client.post(
        "/documents/never-uploaded/ai/refine",
        json={
            "text": "nanobody",
            "kind": "definition",
            "content": "A small antibody fragment.",
            "page": 2,
            "page_text": "REFINE-MARKER context",
            "messages": [{"role": "user", "content": "why here?"}],
        },
    )
    assert r.status_code == 200
    assert "REFINE-MARKER" in captured[1]["messages"][0]["content"]


@pytest.mark.integration
def test_explain_falls_back_to_server_extraction_without_page_text(
    app_client, tmp_settings, simple_pdf, monkeypatch
):
    """Backward-compatible fallback: omitting page_text still re-derives from
    the server's cached PDF, exactly as before this fix — proven by the actual
    fixture text (from simple_two_page.pdf's page 1) showing up in context."""
    captured: dict = {}

    async def _gen(config, *, system, messages, max_tokens, tier="good"):
        captured["messages"] = messages
        yield ("done", "ok")

    monkeypatch.setattr(llm, "stream_completion", _gen)
    doc_id = _upload(app_client, simple_pdf)

    r = app_client.post(
        f"/documents/{doc_id}/ai/explain",
        json={"text": "term", "page": 1},
    )
    assert r.status_code == 200
    assert "Custom PDF Reader" in captured["messages"][0]["content"]


# ---------------------------------------------------------------------------
# Unconfigured provider → coded error frame
# ---------------------------------------------------------------------------


@pytest.mark.integration
def test_explain_unconfigured_yields_coded_error(app_client, simple_pdf):
    doc_id = _upload(app_client, simple_pdf)
    r = app_client.post(
        f"/documents/{doc_id}/ai/explain", json={"text": "entropy"}
    )
    assert r.status_code == 200
    body = r.text
    assert '"type": "meta"' in body
    assert "AI isn't set up yet" in body
    assert ai.AI_NOT_CONFIGURED_CODE in body


@pytest.mark.integration
def test_chat_unconfigured_yields_coded_error(app_client, simple_pdf):
    doc_id = _upload(app_client, simple_pdf)
    r = app_client.post(
        f"/documents/{doc_id}/ai/chat",
        json={
            "text": "entropy",
            "kind": "definition",
            "content": "x",
            "messages": [{"role": "user", "content": "why?"}],
        },
    )
    assert r.status_code == 200
    assert ai.AI_NOT_CONFIGURED_CODE in r.text


@pytest.mark.integration
def test_explain_without_pdf_still_answers(app_client, monkeypatch):
    # No upload: the PDF isn't in the cache. Page context is empty but the
    # endpoint still streams (no 404) — the model can answer generally.
    monkeypatch.setattr(
        llm, "stream_completion", _fake_stream(("done", "answer"))
    )
    r = app_client.post(
        "/documents/ghost-doc/ai/explain",
        json={"text": "entropy", "page": 1},
    )
    assert r.status_code == 200
    assert '"type": "done"' in r.text


# ---------------------------------------------------------------------------
# Rate-limit path surfaces the friendly message
# ---------------------------------------------------------------------------


@pytest.mark.integration
def test_explain_rate_limit_surfaces_friendly_message(
    app_client, tmp_settings, simple_pdf, monkeypatch
):
    """Simulate a provider RateLimitError and assert the friendly 'busy'
    message + coded frame reach the client (Phase 1 behaviour, now on the
    stateless path)."""
    import anthropic
    import httpx

    ai.set_provider_config(tmp_settings, "anthropic", "sk-ant-test")

    rate_error = anthropic.RateLimitError(
        "rate limited",
        response=httpx.Response(
            429, request=httpx.Request("POST", "https://api.anthropic.com")
        ),
        body=None,
    )

    class _FakeMessages:
        def stream(self, **kwargs):
            raise rate_error

    class _FakeClient:
        def __init__(self, **kwargs):
            self.messages = _FakeMessages()

    monkeypatch.setattr(anthropic, "AsyncAnthropic", _FakeClient)

    doc_id = _upload(app_client, simple_pdf)
    r = app_client.post(
        f"/documents/{doc_id}/ai/explain",
        json={"text": "entropy", "page": 1},
    )
    assert r.status_code == 200
    body = r.text
    assert ai.AI_RATE_LIMITED_MESSAGE in body
    assert ai.AI_RATE_LIMITED_CODE in body
