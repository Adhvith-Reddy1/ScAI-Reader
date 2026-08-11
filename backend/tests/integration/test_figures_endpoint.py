"""Integration tests for the figure-listing endpoint.

Covers the real pipeline end-to-end (upload -> PDFium text extraction ->
column clustering -> detect_figures -> graphics-based bbox tightening),
which the synthetic-PageText unit tests in test_figures.py cannot exercise
since those build TextRun/TextColumn/BBox fixtures by hand.
"""

from __future__ import annotations

import pytest

from app import ai, llm


def _upload(client, pdf_path):
    with pdf_path.open("rb") as f:
        return client.post(
            "/documents", files={"file": ("s.pdf", f, "application/pdf")}
        ).json()["id"]


def _fake_stream(*frames):
    """Stand-in for llm.stream_completion that yields canned frames and
    accepts the same call signature the verification pass uses."""

    async def _gen(config, *, system, messages, max_tokens, tier="good"):
        for frame in frames:
            yield frame

    return _gen


@pytest.fixture(autouse=True)
def _no_env_keys(monkeypatch):
    # Force the deterministic "stored/none" branch so tests don't read
    # ambient provider keys from the environment (mirrors test_stateless_ai.py).
    for var in (
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "OPENROUTER_API_KEY",
        "OPENAI_BASE_URL",
        "OPENAI_MODEL",
        "OPENROUTER_MODEL",
    ):
        monkeypatch.delenv(var, raising=False)


@pytest.mark.integration
def test_lists_figure_on_single_column_page(app_client, figure_pdf):
    doc_id = _upload(app_client, figure_pdf)

    r = app_client.get(f"/documents/{doc_id}/pages/1/figures")
    assert r.status_code == 200
    body = r.json()

    assert body["page"] == 1
    assert body["page_width_pt"] == pytest.approx(612.0, abs=0.5)
    assert body["page_height_pt"] == pytest.approx(792.0, abs=0.5)
    assert len(body["figures"]) == 1

    fig = body["figures"][0]
    assert fig["label"] == "Figure 1"
    assert fig["figure_id"] == "p0_Figure_1"
    # Bbox is tightened to the actual drawn chart, not the whole text column.
    bbox = fig["bbox"]
    assert bbox["x0"] == pytest.approx(129, abs=3)
    assert bbox["y0"] == pytest.approx(141, abs=3)
    assert bbox["x1"] == pytest.approx(481, abs=3)
    assert bbox["y1"] == pytest.approx(233, abs=3)


@pytest.mark.integration
def test_figure_confined_to_left_column_on_two_column_page(app_client, figure_pdf):
    doc_id = _upload(app_client, figure_pdf)

    r = app_client.get(f"/documents/{doc_id}/pages/2/figures")
    assert r.status_code == 200
    body = r.json()

    assert len(body["figures"]) == 1
    fig = body["figures"][0]
    assert fig["label"] == "Figure 2"
    assert fig["figure_id"] == "p1_Figure_2"

    bbox = fig["bbox"]
    assert bbox["x0"] == pytest.approx(71, abs=3)
    assert bbox["y0"] == pytest.approx(151, abs=3)
    assert bbox["x1"] == pytest.approx(271, abs=3)
    assert bbox["y1"] == pytest.approx(233, abs=3)
    # Confined to the left column: must not bleed across the page midpoint
    # into the right column's text.
    assert bbox["x1"] < body["page_width_pt"] / 2


@pytest.mark.integration
def test_no_figures_on_caption_free_page(app_client, simple_pdf):
    doc_id = _upload(app_client, simple_pdf)

    r = app_client.get(f"/documents/{doc_id}/pages/1/figures")
    assert r.status_code == 200
    assert r.json()["figures"] == []


@pytest.mark.integration
def test_404_for_unknown_document(app_client):
    r = app_client.get("/documents/does-not-exist/pages/1/figures")
    assert r.status_code == 404


@pytest.mark.integration
def test_400_for_invalid_page_number(app_client, figure_pdf):
    doc_id = _upload(app_client, figure_pdf)

    r = app_client.get(f"/documents/{doc_id}/pages/0/figures")
    assert r.status_code == 400


@pytest.mark.integration
def test_figure_resolves_across_a_page_break(app_client, tmp_path):
    """Some journals (Nature-family) give a data-dense figure its own
    dedicated page: the caption is printed in the running text, but the
    actual image is pushed onto a separate page. Page 1 here is all body
    text ending in a caption with no drawn content at all; page 2 opens
    directly with a drawn rectangle and no caption of its own -- the figure
    endpoint for page 2 must resolve the label from page 1's caption."""
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfgen import canvas

    path = tmp_path / "cross_page.pdf"
    c = canvas.Canvas(str(path), pagesize=letter)

    # Page 1: body prose (enough runs to look like real discussion, not a
    # caption with nothing above it) running right up to the caption line
    # with ordinary single-line spacing -- no blank gap for the whitespace
    # heuristic to mistake for a (nonexistent) figure on this page.
    c.setFont("Helvetica", 10)
    y = 700
    for i in range(15):
        c.drawString(40, y, f"This is body sentence number {i} discussing the result.")
        y -= 14
    c.drawString(40, y - 14, "Fig. 1 | A figure whose image is on the next page.")
    c.showPage()

    # Page 2: a drawn rectangle right at the top, no caption of its own.
    c.rect(100, 650, 300, 92, stroke=1, fill=0)
    c.showPage()
    c.save()

    doc_id = _upload(app_client, path)

    r1 = app_client.get(f"/documents/{doc_id}/pages/1/figures")
    assert r1.status_code == 200
    assert r1.json()["figures"] == []  # nothing drawn on the caption's own page

    r2 = app_client.get(f"/documents/{doc_id}/pages/2/figures")
    assert r2.status_code == 200
    figures = r2.json()["figures"]
    assert len(figures) == 1
    assert figures[0]["label"] == "Figure 1"
    assert figures[0]["page"] == 2


# ---------------------------------------------------------------------------
# Vision-LLM verification pass — confirms/corrects the heuristic when a
# provider is configured; must never regress the free path when it isn't.
# ---------------------------------------------------------------------------


@pytest.mark.integration
def test_no_provider_configured_skips_verification_entirely(
    app_client, figure_pdf, monkeypatch
):
    """The free heuristic path must not even attempt an LLM call when no
    provider is set up -- asserted here by making stream_completion blow up
    if it's ever reached."""

    async def _boom(*args, **kwargs):
        raise AssertionError("verification should not run without a provider")
        yield  # pragma: no cover - never reached, keeps this an async gen

    monkeypatch.setattr(llm, "stream_completion", _boom)
    doc_id = _upload(app_client, figure_pdf)

    r = app_client.get(f"/documents/{doc_id}/pages/1/figures")

    assert r.status_code == 200
    assert r.json()["figures"][0]["label"] == "Figure 1"


@pytest.mark.integration
def test_verification_corrects_bbox_and_adds_missed_figure(
    app_client, tmp_settings, figure_pdf, monkeypatch
):
    ai.set_provider_config(tmp_settings, "anthropic", "sk-ant-test")
    reply = (
        '[{"label": "Figure 1", "x0": 0.2, "y0": 0.15, "x1": 0.85, "y1": 0.35}, '
        '{"label": "Table 1", "x0": 0.1, "y0": 0.5, "x1": 0.9, "y1": 0.6}]'
    )
    monkeypatch.setattr(llm, "stream_completion", _fake_stream(("done", reply)))
    doc_id = _upload(app_client, figure_pdf)

    r = app_client.get(f"/documents/{doc_id}/pages/1/figures")

    assert r.status_code == 200
    body = r.json()
    by_label = {f["label"]: f for f in body["figures"]}
    assert set(by_label) == {"Figure 1", "Table 1"}

    corrected = by_label["Figure 1"]["bbox"]
    assert corrected["x0"] == pytest.approx(0.2 * body["page_width_pt"], abs=1)
    assert corrected["x1"] == pytest.approx(0.85 * body["page_width_pt"], abs=1)

    added = by_label["Table 1"]["bbox"]
    assert added["x0"] == pytest.approx(0.1 * body["page_width_pt"], abs=1)
    assert added["y1"] == pytest.approx(0.6 * body["page_height_pt"], abs=1)


@pytest.mark.integration
def test_verification_call_failure_falls_back_to_heuristic(
    app_client, tmp_settings, figure_pdf, monkeypatch
):
    ai.set_provider_config(tmp_settings, "anthropic", "sk-ant-test")
    monkeypatch.setattr(llm, "stream_completion", _fake_stream(("error", "boom")))
    doc_id = _upload(app_client, figure_pdf)

    r = app_client.get(f"/documents/{doc_id}/pages/1/figures")

    assert r.status_code == 200
    figures = r.json()["figures"]
    assert len(figures) == 1
    assert figures[0]["label"] == "Figure 1"


@pytest.mark.integration
def test_verification_skipped_once_daily_quota_is_used_up(
    app_client, tmp_settings, figure_pdf, monkeypatch
):
    """A shared/stored provider draws on the same daily quota as every other
    AI feature; once it's exhausted, figure listing must keep working on the
    free heuristic path instead of erroring."""
    ai.set_provider_config(tmp_settings, "anthropic", "sk-ant-test")
    reply = '[{"label": "Table 1", "x0": 0.1, "y0": 0.5, "x1": 0.9, "y1": 0.6}]'
    monkeypatch.setattr(llm, "stream_completion", _fake_stream(("done", reply)))
    doc_id = _upload(app_client, figure_pdf)
    headers = {"X-Client-Id": "quota-test-client-3333333333333333"}

    for _ in range(tmp_settings.ai_daily_limit):
        r = app_client.get(
            f"/documents/{doc_id}/pages/1/figures", headers=headers
        )
        assert r.status_code == 200
        assert "Table 1" in {f["label"] for f in r.json()["figures"]}

    r = app_client.get(f"/documents/{doc_id}/pages/1/figures", headers=headers)
    assert r.status_code == 200
    labels = {f["label"] for f in r.json()["figures"]}
    assert labels == {"Figure 1"}  # heuristic only -- quota used up


@pytest.mark.integration
def test_readers_own_api_key_bypasses_exhausted_quota(
    app_client, tmp_settings, figure_pdf, monkeypatch
):
    ai.set_provider_config(tmp_settings, "anthropic", "sk-ant-test")
    reply = '[{"label": "Table 1", "x0": 0.1, "y0": 0.5, "x1": 0.9, "y1": 0.6}]'
    monkeypatch.setattr(llm, "stream_completion", _fake_stream(("done", reply)))
    doc_id = _upload(app_client, figure_pdf)
    headers = {"X-Client-Id": "quota-test-client-4444444444444444"}

    for _ in range(tmp_settings.ai_daily_limit):
        app_client.get(f"/documents/{doc_id}/pages/1/figures", headers=headers)

    r = app_client.get(
        f"/documents/{doc_id}/pages/1/figures",
        headers={**headers, "X-User-Api-Key": "sk-ant-reader-own-key"},
    )
    assert r.status_code == 200
    assert "Table 1" in {f["label"] for f in r.json()["figures"]}
