"""Integration tests for the figure-listing endpoint.

Covers the real pipeline end-to-end (upload -> PDFium text extraction ->
column clustering -> detect_figures -> graphics-based bbox tightening),
which the synthetic-PageText unit tests in test_figures.py cannot exercise
since those build TextRun/TextColumn/BBox fixtures by hand.
"""

from __future__ import annotations

import pytest


def _upload(client, pdf_path):
    with pdf_path.open("rb") as f:
        return client.post(
            "/documents", files={"file": ("s.pdf", f, "application/pdf")}
        ).json()["id"]


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
