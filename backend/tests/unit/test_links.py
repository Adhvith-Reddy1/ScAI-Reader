"""Tests for link-annotation extraction.

These build real (reportlab) PDFs and read them back through PdfiumBackend —
link extraction is inherently pdfium-specific, so there's no pure-function
seam to test against. PDFs are tiny; the round-trip is fast.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

from app.pdf.pdfium_backend import PdfiumBackend

PAGE_H = letter[1]  # 792 pt


def _internal_link_pdf(path: Path) -> None:
    c = canvas.Canvas(str(path), pagesize=letter)
    c.setFont("Helvetica", 12)
    c.drawString(72, 720, "Body with a citation marker here.")
    # A citation-style link jumping to a destination on page 2.
    c.linkAbsolute("cite24", "ref24", Rect=(300, 715, 312, 728))
    c.showPage()
    c.bookmarkPage("ref24")
    c.drawString(72, 700, "24. Wu, Q. et al. AutoGen. 2024.")
    c.showPage()
    c.save()


def test_extracts_internal_link_with_dest_page(tmp_path):
    path = tmp_path / "internal.pdf"
    _internal_link_pdf(path)
    with PdfiumBackend.open(path) as be:
        links = be.get_links(0)
    assert len(links) == 1
    link = links[0]
    assert link.dest_page_index == 1  # 0-indexed page 2
    assert link.uri is None


def test_internal_link_bbox_is_top_left_and_in_bounds(tmp_path):
    path = tmp_path / "internal.pdf"
    _internal_link_pdf(path)
    with PdfiumBackend.open(path) as be:
        (link,) = be.get_links(0)
        dims = be.page_dimensions(0)
    b = link.bbox
    # Rect was (300, 715, 312, 728) in PDF bottom-left space; flipped to
    # top-left: y0 = 792 - 728 = 64, y1 = 792 - 715 = 77.
    assert b.x0 == pytest.approx(300, abs=0.5)
    assert b.x1 == pytest.approx(312, abs=0.5)
    assert b.y0 == pytest.approx(PAGE_H - 728, abs=0.5)
    assert b.y1 == pytest.approx(PAGE_H - 715, abs=0.5)
    # Well-formed and inside the page.
    assert 0 <= b.x0 <= b.x1 <= dims.width_pt + 1
    assert 0 <= b.y0 <= b.y1 <= dims.height_pt + 1


def test_extracts_external_uri_link(tmp_path):
    path = tmp_path / "external.pdf"
    c = canvas.Canvas(str(path), pagesize=letter)
    c.drawString(72, 700, "See the project page.")
    c.linkURL("https://example.com/paper", (72, 695, 200, 708))
    c.showPage()
    c.save()
    with PdfiumBackend.open(path) as be:
        links = be.get_links(0)
    assert len(links) == 1
    assert links[0].uri == "https://example.com/paper"
    assert links[0].dest_page_index is None


def test_page_without_links_returns_empty(tmp_path):
    path = tmp_path / "plain.pdf"
    c = canvas.Canvas(str(path), pagesize=letter)
    c.drawString(72, 700, "Just text, no links at all.")
    c.showPage()
    c.save()
    with PdfiumBackend.open(path) as be:
        assert be.get_links(0) == ()


def test_multiple_links_on_one_page(tmp_path):
    path = tmp_path / "multi.pdf"
    c = canvas.Canvas(str(path), pagesize=letter)
    c.drawString(72, 700, "Two markers.")
    c.linkURL("https://a.example", (72, 695, 90, 708))
    c.linkURL("https://b.example", (100, 695, 118, 708))
    c.showPage()
    c.save()
    with PdfiumBackend.open(path) as be:
        links = be.get_links(0)
    assert len(links) == 2
    assert {l.uri for l in links} == {"https://a.example", "https://b.example"}
