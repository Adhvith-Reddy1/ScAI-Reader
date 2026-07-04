"""Integration coverage for GET /documents/{id}/pages/{n}/figures against a
REAL rendered PDF (not synthetic PageText, unlike tests/unit/test_figures.py).

This exercises the full real pipeline together — PDFium text extraction,
column clustering, detect_figures, AND graphics-based bbox tightening —
which the unit tests can't, since those build TextRun/TextColumn/BBox
fixtures by hand. It caught two real bugs during development:

1. A two-column page whose column-2 body lines happened to measure a
   slightly different glyph-bbox height (PdfiumBackend's font_size proxy,
   see pdfium_backend.py) fell under the column-clustering run threshold and
   collapsed to one column, which let a figure's bbox bleed across both
   columns instead of staying confined to its own.
2. Before graphics-based tightening existed, a detected figure's box was
   always exactly the enclosing column's width — visibly wrong whenever the
   actual figure was narrower (wasted margin) *or*, as here, wider than the
   longest body/caption line (the box cut off part of the real figure).
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

    # Tight to the actual drawn chart (build_figure_doc draws it at
    # x=130..480, y=560..650 in PDF-native / bottom-left-origin points — see
    # build_fixtures.py), not just "the whole column width" (72..372.9, per
    # the column's text extent). A few points of tolerance for cross-platform
    # pypdfium2 stroke-width/rounding differences.
    assert b["x0"] == pytest.approx(129, abs=3)
    assert b["x1"] == pytest.approx(481, abs=3)
    assert b["y0"] == pytest.approx(141, abs=3)
    assert b["y1"] == pytest.approx(233, abs=3)
    # And specifically WIDER than the column-derived fallback would allow —
    # the regression this test exists for (a figure can legitimately be
    # wider than its own caption/body text).
    assert b["x1"] > 372.9 + 3


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
    # Tight to the actual drawn chart (x=72..270, y=560..640 PDF-native — see
    # build_figure_doc), confined to the left column: must NOT bleed across
    # the ~50pt gutter into the right column's text (which starts at
    # x0 ~= 321 in this fixture).
    assert b["x0"] == pytest.approx(71, abs=3)
    assert b["x1"] == pytest.approx(271, abs=3)
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
