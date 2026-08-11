"""Integration tests for the citation-listing endpoints.

Most of these tests seed the tables directly via
app.storage.citations.replace_citations rather than relying on real
detection, to isolate route behavior from detect_citations' own parsing
logic (which has its own dedicated tests in test_citations.py).
test_upload_populates_citations_via_background_task below is the one
end-to-end check that upload -> background detection -> these routes is
actually wired together.
"""

from __future__ import annotations

import pytest

from app.pdf.citations import Citation, CitationMention
from app.pdf.types import BBox
from app.storage import citations as citations_storage
from app.storage import db


def _upload(app_client, pdf_path, name="s.pdf"):
    with pdf_path.open("rb") as f:
        return app_client.post(
            "/documents", files={"file": (name, f, "application/pdf")}
        ).json()["id"]


def _seed_citations(tmp_settings, doc_id):
    cites = [
        Citation(
            key="1",
            raw_text="Smith, J. (2020). A paper. Some Venue.",
            page_index=1,
            authors="Smith, J.",
            title="A paper",
            year="2020",
            venue="Some Venue",
            doi="10.1/xyz",
        ),
        Citation(key="2", raw_text="Doe, A. (2019). Another paper.", page_index=1),
    ]
    mentions = [
        CitationMention(key="1", page_index=0, bbox=BBox(10, 20, 30, 40)),
        CitationMention(key="2", page_index=0, bbox=BBox(50, 60, 70, 80)),
        CitationMention(key="1", page_index=1, bbox=BBox(1, 2, 3, 4)),
    ]
    with db.connect(tmp_settings.db_path) as conn:
        citations_storage.replace_citations(conn, doc_id, cites, mentions)


@pytest.mark.integration
def test_citations_404_for_unknown_doc(app_client):
    r = app_client.get("/documents/deadbeef/citations")
    assert r.status_code == 404


@pytest.mark.integration
def test_citation_mentions_404_for_unknown_doc(app_client):
    r = app_client.get("/documents/deadbeef/pages/1/citation-mentions")
    assert r.status_code == 404


@pytest.mark.integration
def test_citations_empty_list_before_detection_has_run(app_client, simple_pdf):
    doc_id = _upload(app_client, simple_pdf)
    r = app_client.get(f"/documents/{doc_id}/citations")
    assert r.status_code == 200
    body = r.json()
    assert body["doc_id"] == doc_id
    assert body["citations"] == []


@pytest.mark.integration
def test_citation_mentions_empty_list_before_detection_has_run(app_client, simple_pdf):
    doc_id = _upload(app_client, simple_pdf)
    r = app_client.get(f"/documents/{doc_id}/pages/1/citation-mentions")
    assert r.status_code == 200
    body = r.json()
    assert body["page"] == 1
    assert body["mentions"] == []


@pytest.mark.integration
def test_citation_mentions_400_for_invalid_page_number(app_client, simple_pdf):
    doc_id = _upload(app_client, simple_pdf)
    r = app_client.get(f"/documents/{doc_id}/pages/0/citation-mentions")
    assert r.status_code == 400


@pytest.mark.integration
def test_citations_lists_seeded_bibliography(app_client, tmp_settings, simple_pdf):
    doc_id = _upload(app_client, simple_pdf)
    _seed_citations(tmp_settings, doc_id)

    r = app_client.get(f"/documents/{doc_id}/citations")
    assert r.status_code == 200
    body = r.json()
    assert body["doc_id"] == doc_id
    assert len(body["citations"]) == 2

    first = next(c for c in body["citations"] if c["key"] == "1")
    assert first["raw_text"] == "Smith, J. (2020). A paper. Some Venue."
    assert first["page"] == 2  # page_index 1 -> 1-based page 2
    assert first["authors"] == "Smith, J."
    assert first["title"] == "A paper"
    assert first["year"] == "2020"
    assert first["venue"] == "Some Venue"
    assert first["doi"] == "10.1/xyz"

    second = next(c for c in body["citations"] if c["key"] == "2")
    assert second["authors"] is None


@pytest.mark.integration
def test_citation_mentions_lists_seeded_mentions_for_page(
    app_client, tmp_settings, simple_pdf
):
    doc_id = _upload(app_client, simple_pdf)
    _seed_citations(tmp_settings, doc_id)

    r = app_client.get(f"/documents/{doc_id}/pages/1/citation-mentions")
    assert r.status_code == 200
    body = r.json()
    assert body["page"] == 1
    assert len(body["mentions"]) == 2
    keys = {m["key"] for m in body["mentions"]}
    assert keys == {"1", "2"}
    m1 = next(m for m in body["mentions"] if m["key"] == "1")
    assert m1["bbox"] == {"x0": 10, "y0": 20, "x1": 30, "y1": 40}

    r2 = app_client.get(f"/documents/{doc_id}/pages/2/citation-mentions")
    assert r2.status_code == 200
    body2 = r2.json()
    assert len(body2["mentions"]) == 1
    assert body2["mentions"][0]["key"] == "1"

    r3 = app_client.get(f"/documents/{doc_id}/pages/3/citation-mentions")
    assert r3.status_code == 200
    assert r3.json()["mentions"] == []


@pytest.mark.integration
def test_upload_populates_citations_via_background_task(app_client, citation_pdf):
    """No manual seeding: uploading a document with a real bibliography
    should populate both tables through the same background task that
    indexes pages_fts, with no further requests needed."""
    doc_id = _upload(app_client, citation_pdf)

    r = app_client.get(f"/documents/{doc_id}/citations")
    assert r.status_code == 200
    entries = r.json()["citations"]
    assert {c["key"] for c in entries} == {"1", "2"}
    first = next(c for c in entries if c["key"] == "1")
    assert "Smith" in first["raw_text"]
    assert first["page"] == 2  # References section is on page 2

    r2 = app_client.get(f"/documents/{doc_id}/pages/1/citation-mentions")
    assert r2.status_code == 200
    mentions = r2.json()["mentions"]
    assert {m["key"] for m in mentions} == {"1", "2"}
    for m in mentions:
        assert m["bbox"]["x1"] > m["bbox"]["x0"]
        assert m["bbox"]["y1"] > m["bbox"]["y0"]


@pytest.mark.integration
@pytest.mark.slow
def test_upload_real_fda_report_finds_every_reference(app_client, fda_case_studies_pdf):
    """End-to-end against a real, unmodified 44-page PDF (not a synthetic
    fixture): "22 Case Studies Where Phase 2 and Phase 3 Trials Had
    Divergent Results" (FDA, Jan 2017 -- a US government work, public
    domain). Its reference list runs 1-129 in bracketed numeric style
    ("[1]", "[5, 6]", ...), and its table of contents has its own
    "References....36" entry ahead of the real section -- this is the exact
    real-world document that exposed the TOC-heading and split-marker bugs
    fixed in app.pdf.citations (see the regression tests in
    test_citations.py). Every one of the 129 references must be found, and
    every one must have at least one in-text mention -- this document has no
    uncited entries."""
    doc_id = _upload(app_client, fda_case_studies_pdf, name="fda_22_case_studies.pdf")

    r = app_client.get(f"/documents/{doc_id}/citations")
    assert r.status_code == 200
    entries = r.json()["citations"]
    keys = {c["key"] for c in entries}
    assert keys == {str(n) for n in range(1, 130)}

    mentioned_keys: set[str] = set()
    for page in range(1, 45):
        rp = app_client.get(f"/documents/{doc_id}/pages/{page}/citation-mentions")
        assert rp.status_code == 200
        mentioned_keys |= {m["key"] for m in rp.json()["mentions"]}
    assert mentioned_keys == keys


@pytest.mark.integration
@pytest.mark.slow
def test_upload_real_nature_article_finds_every_reference(
    app_client, nature_cytokine_atlas_pdf
):
    """End-to-end against a real, CC-BY-licensed Nature article (see
    conftest.py's nature_cytokine_atlas_pdf fixture for the citation and
    license statement). Its 39-entry reference list has NO "References"
    heading at all -- the numbering starts right after a fixed "Online
    content..." paragraph, confirmed to be standard Nature-family house
    style -- so unlike the FDA/citation_doc fixtures, this specifically
    exercises detect_citations's heading-less fallback
    (_find_headingless_numeric_run) end to end through the real upload
    pipeline, not just the unit-level regression tests in
    test_citations.py.

    One entry (28) has no in-text mention: its superscript marker sits on
    a page whose dominant font is itself unusually small (a dense figure
    of cytokine/gene labels skews the page-local "body font size" estimate
    _page_body_font_size relies on), a known, narrow limitation -- not
    something this test should mask by only checking a subset of keys."""
    doc_id = _upload(app_client, nature_cytokine_atlas_pdf, name="nature_cytokine_atlas.pdf")

    r = app_client.get(f"/documents/{doc_id}/citations")
    assert r.status_code == 200
    entries = r.json()["citations"]
    keys = {c["key"] for c in entries}
    assert keys == {str(n) for n in range(1, 40)}
    first = next(c for c in entries if c["key"] == "1")
    assert "Arai" in first["raw_text"]

    mentioned_keys: set[str] = set()
    for page in range(1, 10):
        rp = app_client.get(f"/documents/{doc_id}/pages/{page}/citation-mentions")
        assert rp.status_code == 200
        mentioned_keys |= {m["key"] for m in rp.json()["mentions"]}
    assert keys - mentioned_keys == {"28"}
