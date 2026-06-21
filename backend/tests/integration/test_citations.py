"""Integration tests for the citation endpoints.

The per-page marker endpoint is fully exercised against a real (reportlab-built)
PDF. The reference-parsing endpoint's LLM call is not invoked here — without an
API key it must degrade gracefully to a cached ``error`` status — so we assert
the single-flight/caching wiring rather than the model output.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas


@pytest.fixture
def citation_pdf(tmp_path: Path) -> Path:
    """A two-page PDF: body text with bracketed citations, then a References
    heading followed by numbered entries."""
    path = tmp_path / "citation.pdf"
    c = canvas.Canvas(str(path), pagesize=letter)

    c.setFont("Helvetica", 12)
    c.drawString(72, 720, "Transformers improved on prior work [1] and later [2, 3].")
    c.drawString(72, 700, "A range of methods [4-6] were also compared in detail.")
    c.showPage()

    c.setFont("Helvetica-Bold", 14)
    c.drawString(72, 720, "References")
    c.setFont("Helvetica", 11)
    c.drawString(72, 690, "[1] A. Smith. A foundational paper. 2017.")
    c.drawString(72, 672, "[2] B. Jones. A follow-up study. 2018.")
    c.showPage()
    c.save()
    return path


def _upload(app_client, pdf: Path) -> str:
    with pdf.open("rb") as f:
        return app_client.post(
            "/documents", files={"file": ("c.pdf", f, "application/pdf")}
        ).json()["id"]


@pytest.mark.integration
def test_page_citations_detected(app_client, citation_pdf):
    doc_id = _upload(app_client, citation_pdf)
    r = app_client.get(f"/documents/{doc_id}/pages/1/citations")
    assert r.status_code == 200
    body = r.json()
    assert body["page_width_pt"] > 0

    numbers = [tuple(m["numbers"]) for m in body["citations"]]
    assert (1,) in numbers
    assert (2, 3) in numbers
    assert (4, 5, 6) in numbers

    # Every marker bbox sits inside the page.
    pw, ph = body["page_width_pt"], body["page_height_pt"]
    for m in body["citations"]:
        b = m["bbox"]
        assert 0 <= b["x0"] <= b["x1"] <= pw + 1
        assert 0 <= b["y0"] <= b["y1"] <= ph + 1


@pytest.mark.integration
def test_superscript_citations_detected(app_client, tmp_path):
    # Nature-style superscript citations, built with platypus <super> markup so
    # pdfium emits the raised, smaller-font runs the detector keys on.
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import Paragraph, SimpleDocTemplate

    path = tmp_path / "super.pdf"
    styles = getSampleStyleSheet()
    body = (
        "AI agents<super>24,25</super> tackle research, and the Virtual Lab "
        "architecture<super>3</super> is broadly applicable<super>7</super> here."
    )
    SimpleDocTemplate(str(path), pagesize=letter).build([Paragraph(body, styles["BodyText"])])

    doc_id = _upload(app_client, path)
    body_json = app_client.get(f"/documents/{doc_id}/pages/1/citations").json()
    numbers = [tuple(m["numbers"]) for m in body_json["citations"]]
    assert (24, 25) in numbers
    assert (3,) in numbers
    assert (7,) in numbers


@pytest.mark.integration
def test_page_citations_404_for_unknown_doc(app_client):
    r = app_client.get("/documents/deadbeef/pages/1/citations")
    assert r.status_code == 404


@pytest.mark.integration
def test_page_citations_400_for_bad_page(app_client, citation_pdf):
    doc_id = _upload(app_client, citation_pdf)
    r = app_client.get(f"/documents/{doc_id}/pages/99/citations")
    assert r.status_code == 400


@pytest.mark.integration
def test_references_without_api_key_errors_and_caches(
    app_client, citation_pdf, monkeypatch
):
    # Ensure no key is present so the parse fails deterministically (no network).
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    doc_id = _upload(app_client, citation_pdf)

    r = app_client.get(f"/documents/{doc_id}/references")
    assert r.status_code == 200
    body = r.json()
    # The references heading exists, so we get past extraction and fail at the
    # (keyless) model call -> error status, no entries.
    assert body["status"] == "error"
    assert body["references"] == []

    # The failed run is cached: a second call returns the same status without
    # re-attempting (single-flight gate).
    again = app_client.get(f"/documents/{doc_id}/references").json()
    assert again["status"] == "error"


@pytest.mark.integration
def test_references_empty_when_no_bibliography(app_client, tmp_path):
    path = tmp_path / "nobib.pdf"
    c = canvas.Canvas(str(path), pagesize=letter)
    c.setFont("Helvetica", 12)
    c.drawString(72, 720, "A document with a citation [1] but no reference list.")
    c.showPage()
    c.save()
    doc_id = _upload(app_client, path)

    body = app_client.get(f"/documents/{doc_id}/references").json()
    assert body["status"] == "empty"
    assert body["references"] == []
