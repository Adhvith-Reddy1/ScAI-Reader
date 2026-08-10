"""Integration tests for the citation-listing endpoints.

`detect_citations` isn't implemented yet (see app.pdf.citations), so upload
alone never populates these tables -- these tests insert fixture rows
directly via app.storage.citations.replace_citations, the same storage path
the (future) upload-time wiring will use.
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
