"""Integration coverage for GET /documents/{id}/pages/{n}/figures against a
REAL rendered PDF (not synthetic PageText, unlike tests/unit/test_figures.py).

This exercises the full real pipeline together — PDFium text extraction,
column clustering, and detect_figures — which the unit tests can't, since
those build TextRun/TextColumn fixtures by hand. It caught a real bug during
development: a two-column page whose column-2 body lines happened to measure
a slightly different glyph-bbox height (PdfiumBackend's font_size proxy, see
pdfium_backend.py) fell under the column-clustering run threshold and
collapsed to one column, which in turn let a figure's bbox bleed across both
columns instead of staying confined to its own.
"""

from __future__ import annotations

import pytest


def _upload(client, pdf_path) -> str:
    with pdf_path.open("rb") as f:
        return client.post(
            "/documents", files={"file": ("figs.pdf", f, "application/pdf")}
        ).json()["id"]


@pytest.mark.integration
def test_detects_single_column_figure(app_client, figure_pdf):
    doc_id = _upload(app_client, figure_pdf)
    r = app_client.get(f"/documents/{doc_id}/pages/1/figures")
    assert r.status_code == 200
    body = r.json()
    assert body["page"] == 1
    assert len(body["figures"]) == 1

    fig = body["figures"][0]
    assert fig["label"] == "Figure 1"
    assert fig["figure_id"] == "p0_Figure_1"
    b = fig["bbox"]
    # A real, non-degenerate box strictly inside the page, above the caption.
    assert 0 <= b["x0"] < b["x1"] <= body["page_width_pt"]
    assert 0 <= b["y0"] < b["y1"] <= body["page_height_pt"]
    assert (b["y1"] - b["y0"]) > 50  # the ~130pt gap we drew the chart into


@pytest.mark.integration
def test_detects_figure_confined_to_one_column(app_client, figure_pdf):
    doc_id = _upload(app_client, figure_pdf)
    r = app_client.get(f"/documents/{doc_id}/pages/2/figures")
    assert r.status_code == 200
    body = r.json()
    assert len(body["figures"]) == 1

    fig = body["figures"][0]
    assert fig["label"] == "Figure 2"
    b = fig["bbox"]
    # Confined to the left column — must NOT bleed across the ~90pt gutter
    # into the right column's text (which starts at x0 ~= 321 in this fixture).
    assert b["x1"] < 300, (
        f"figure bbox x1={b['x1']} bled into the right column; "
        "column detection likely collapsed to a single column"
    )


@pytest.mark.integration
def test_figures_have_no_cached_explanation_before_any_explain_call(
    app_client, figure_pdf
):
    doc_id = _upload(app_client, figure_pdf)
    body = app_client.get(f"/documents/{doc_id}/pages/1/figures").json()
    assert "explanation" not in body["figures"][0]


@pytest.mark.integration
def test_figures_404_for_unknown_doc(app_client):
    r = app_client.get("/documents/deadbeef/pages/1/figures")
    assert r.status_code == 404


@pytest.mark.integration
def test_no_figures_on_a_page_with_no_captions(app_client, simple_pdf):
    doc_id = _upload(app_client, simple_pdf)
    body = app_client.get(f"/documents/{doc_id}/pages/1/figures").json()
    assert body["figures"] == []
