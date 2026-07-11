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

from app import ai, llm, quota
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


@pytest.mark.integration
def test_figure_ai_explain_with_bbox_sends_a_cropped_image(
    app_client, simple_pdf, monkeypatch
):
    """A double-click on one panel sends that panel's bbox; the vision
    payload should shrink to just that region, not the whole page — the
    entire point of sub-panel detection (see app.pdf.figures)."""
    captured: dict = {}

    async def _gen(config, *, system, messages, max_tokens, tier="good"):
        captured["messages"] = messages
        yield ("done", "ok")

    monkeypatch.setattr(llm, "stream_completion", _gen)
    doc_id = _upload(app_client, simple_pdf)

    full_page = app_client.get(f"/documents/{doc_id}/pages/1.png?dpi=150")
    full_page_bytes = len(full_page.content)

    r = app_client.post(
        f"/documents/{doc_id}/figures/p1_Figure_1/ai-explain",
        json={
            "page": 1,
            "label": "Figure 1",
            "bbox": {"x0": 50, "y0": 50, "x1": 150, "y1": 100},
        },
    )
    assert r.status_code == 200

    import base64

    image_part = captured["messages"][0]["content"][0]
    cropped_bytes = base64.standard_b64decode(image_part["data"])
    assert len(cropped_bytes) < full_page_bytes
    assert "cropped to just this figure/panel" in captured["messages"][0]["content"][1]["text"]


@pytest.mark.integration
def test_figure_ai_explain_without_bbox_mentions_full_page(
    app_client, simple_pdf, monkeypatch
):
    captured: dict = {}

    async def _gen(config, *, system, messages, max_tokens, tier="good"):
        captured["messages"] = messages
        yield ("done", "ok")

    monkeypatch.setattr(llm, "stream_completion", _gen)
    doc_id = _upload(app_client, simple_pdf)

    r = app_client.post(
        f"/documents/{doc_id}/figures/p1_Figure_1/ai-explain",
        json={"page": 1, "label": "Figure 1"},
    )
    assert r.status_code == 200
    assert "disambiguate" in captured["messages"][0]["content"][1]["text"]


@pytest.mark.integration
def test_figure_ai_explain_declares_the_real_image_media_type(
    app_client, page_with_image_pdf, monkeypatch
):
    """render_page now returns JPEG for pages with an embedded image (the
    common case for a figure-explain call, since this IS the figure) — the
    vision payload's declared media type must match, or a provider could
    reject/misdecode the attachment."""
    captured: dict = {}

    async def _gen(config, *, system, messages, max_tokens, tier="good"):
        captured["messages"] = messages
        yield ("done", "ok")

    monkeypatch.setattr(llm, "stream_completion", _gen)
    doc_id = _upload(app_client, page_with_image_pdf)

    r = app_client.post(
        f"/documents/{doc_id}/figures/p1_Figure_1/ai-explain",
        json={"page": 1, "label": "Figure 1"},
    )
    assert r.status_code == 200
    image_part = captured["messages"][0]["content"][0]
    assert image_part["kind"] == "image"
    assert image_part["media_type"] == "image/jpeg"
    assert image_part["data"]  # base64 payload present


# ---------------------------------------------------------------------------
# Figure follow-up chat
# ---------------------------------------------------------------------------


@pytest.mark.integration
def test_figure_ai_chat_streams_and_writes_nothing(
    app_client, simple_pdf, monkeypatch
):
    monkeypatch.setattr(
        llm,
        "stream_completion",
        _fake_stream(("delta", "Because "), ("done", "Because of the trend.")),
    )
    doc_id = _upload(app_client, simple_pdf)

    r = app_client.post(
        f"/documents/{doc_id}/figures/p1_Figure_1/ai-chat",
        json={
            "page": 1,
            "label": "Figure 1",
            "content": "The figure shows a trend.",
            "messages": [{"role": "user", "content": "Why does that matter?"}],
        },
    )
    assert r.status_code == 200
    assert '"type": "done"' in r.text


@pytest.mark.integration
def test_figure_ai_chat_attaches_the_image_on_the_first_turn(
    app_client, simple_pdf, monkeypatch
):
    """The follow-up still needs the figure in view — the image rides on
    the first user turn, same as the initial explain call."""
    captured: dict = {}

    async def _gen(config, *, system, messages, max_tokens, tier="good"):
        captured["messages"] = messages
        yield ("done", "ok")

    monkeypatch.setattr(llm, "stream_completion", _gen)
    doc_id = _upload(app_client, simple_pdf)

    r = app_client.post(
        f"/documents/{doc_id}/figures/p1_Figure_1/ai-chat",
        json={
            "page": 1,
            "label": "Figure 1",
            "content": "The figure shows a trend.",
            "messages": [{"role": "user", "content": "Which panel shows that?"}],
        },
    )
    assert r.status_code == 200
    first_turn = captured["messages"][0]
    assert first_turn["role"] == "user"
    image_part = first_turn["content"][0]
    assert image_part["kind"] == "image"
    assert image_part["data"]
    text_part = first_turn["content"][1]
    assert "Which panel shows that?" in text_part["text"]
    assert "The figure shows a trend." in text_part["text"]


@pytest.mark.integration
def test_figure_ai_chat_only_attaches_the_image_once(
    app_client, simple_pdf, monkeypatch
):
    """A multi-turn thread shouldn't resend the (large) image on every
    turn — only the first user turn carries it."""
    captured: dict = {}

    async def _gen(config, *, system, messages, max_tokens, tier="good"):
        captured["messages"] = messages
        yield ("done", "ok")

    monkeypatch.setattr(llm, "stream_completion", _gen)
    doc_id = _upload(app_client, simple_pdf)

    r = app_client.post(
        f"/documents/{doc_id}/figures/p1_Figure_1/ai-chat",
        json={
            "page": 1,
            "label": "Figure 1",
            "content": "The figure shows a trend.",
            "messages": [
                {"role": "user", "content": "Which panel shows that?"},
                {"role": "assistant", "content": "Panel b."},
                {"role": "user", "content": "Why panel b specifically?"},
            ],
        },
    )
    assert r.status_code == 200
    assert len(captured["messages"]) == 3
    assert captured["messages"][1] == {"role": "assistant", "content": "Panel b."}
    assert captured["messages"][2] == {
        "role": "user",
        "content": "Why panel b specifically?",
    }
    # Only the first turn's content is a list (image + text); later turns are
    # plain strings.
    assert isinstance(captured["messages"][0]["content"], list)
    assert isinstance(captured["messages"][2]["content"], str)


@pytest.mark.integration
def test_figure_ai_chat_404_for_unknown_document(app_client):
    r = app_client.post(
        "/documents/does-not-exist/figures/p1_Figure_1/ai-chat",
        json={
            "page": 1,
            "label": "Figure 1",
            "content": "x",
            "messages": [{"role": "user", "content": "why?"}],
        },
    )
    assert r.status_code == 404


@pytest.mark.integration
def test_figure_ai_chat_quota_exceeded_yields_coded_error(
    app_client, tmp_settings, simple_pdf, monkeypatch
):
    """The follow-up chat route must honor the same daily quota gate as
    every other AI route — it's easy to add a new route and forget to wire
    it into `_ai_gate`/`_gated_stream`."""
    monkeypatch.setattr(
        llm, "stream_completion", _fake_stream(("delta", "Hi"), ("done", "Hi"))
    )
    ai.set_provider_config(tmp_settings, "anthropic", "sk-ant-test")
    doc_id = _upload(app_client, simple_pdf)

    headers = {"X-Client-Id": "quota-test-client-2222222222222222"}
    body = {
        "page": 1,
        "label": "Figure 1",
        "content": "x",
        "messages": [{"role": "user", "content": "why?"}],
    }
    for _ in range(tmp_settings.ai_daily_limit):
        r = app_client.post(
            f"/documents/{doc_id}/figures/p1_Figure_1/ai-chat",
            json=body,
            headers=headers,
        )
        assert r.status_code == 200
        assert '"type": "done"' in r.text

    r = app_client.post(
        f"/documents/{doc_id}/figures/p1_Figure_1/ai-chat",
        json=body,
        headers=headers,
    )
    assert r.status_code == 200
    text = r.text
    assert ai.AI_QUOTA_EXCEEDED_MESSAGE in text
    assert ai.AI_QUOTA_EXCEEDED_CODE in text
    assert text.count('"type": "done"') == 0


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


# ---------------------------------------------------------------------------
# Daily AI quota (anonymous, per-browser client id — see app.quota)
# ---------------------------------------------------------------------------


@pytest.mark.integration
def test_explain_quota_exceeded_yields_coded_error(
    app_client, tmp_settings, simple_pdf, monkeypatch
):
    monkeypatch.setattr(
        llm, "stream_completion", _fake_stream(("delta", "Hi"), ("done", "Hi"))
    )
    ai.set_provider_config(tmp_settings, "anthropic", "sk-ant-test")
    doc_id = _upload(app_client, simple_pdf)

    headers = {"X-Client-Id": "quota-test-client-0000000000000000"}
    for _ in range(tmp_settings.ai_daily_limit):
        r = app_client.post(
            f"/documents/{doc_id}/ai/explain",
            json={"text": "entropy", "page": 1},
            headers=headers,
        )
        assert r.status_code == 200
        assert '"type": "done"' in r.text

    r = app_client.post(
        f"/documents/{doc_id}/ai/explain",
        json={"text": "entropy", "page": 1},
        headers=headers,
    )
    assert r.status_code == 200
    body = r.text
    assert ai.AI_QUOTA_EXCEEDED_MESSAGE in body
    assert ai.AI_QUOTA_EXCEEDED_CODE in body
    # No LLM call for the denied request: the fake only ever yields "done" text.
    assert body.count('"type": "done"') == 0


@pytest.mark.integration
def test_explain_user_supplied_key_bypasses_quota(
    app_client, tmp_settings, simple_pdf, monkeypatch
):
    captured: list[str] = []

    async def _gen(config, *, system, messages, max_tokens, tier="good"):
        captured.append(config.api_key)
        yield ("done", "ok")

    monkeypatch.setattr(llm, "stream_completion", _gen)
    doc_id = _upload(app_client, simple_pdf)

    client_id = "quota-test-client-1111111111111111"
    for _ in range(tmp_settings.ai_daily_limit):
        assert quota.try_consume(
            tmp_settings, f"id:{client_id}", tmp_settings.ai_daily_limit
        )
    # This client's shared-key quota is now exhausted for today.
    assert not quota.try_consume(
        tmp_settings, f"id:{client_id}", tmp_settings.ai_daily_limit
    )

    r = app_client.post(
        f"/documents/{doc_id}/ai/explain",
        json={"text": "entropy", "page": 1},
        headers={"X-Client-Id": client_id, "X-User-Api-Key": "sk-personal-test"},
    )
    assert r.status_code == 200
    body = r.text
    assert ai.AI_QUOTA_EXCEEDED_CODE not in body
    assert '"type": "done"' in body
    assert captured == ["sk-personal-test"]
