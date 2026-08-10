from __future__ import annotations

from app.pdf.citations import Citation, CitationMention
from app.pdf.types import BBox
from app.storage import citations, db


def _settings_db(tmp_path):
    path = tmp_path / "db.sqlite"
    db.init_db(path)
    return path


def _insert_document(conn, doc_id: str) -> None:
    conn.execute(
        """
        INSERT INTO documents (id, filename, page_count, title, author, size_bytes, uploaded_at)
        VALUES (?, 'f.pdf', 3, NULL, NULL, 100, '2026-01-01T00:00:00Z')
        """,
        (doc_id,),
    )


def _fixture_data():
    cites = [
        Citation(
            key="1",
            raw_text="Smith, J. (2020). A paper. Some Venue.",
            page_index=2,
            authors="Smith, J.",
            title="A paper",
            year="2020",
            venue="Some Venue",
            doi="10.1/xyz",
        ),
        Citation(
            key="2",
            raw_text="Doe, A. (2019). Another paper.",
            page_index=2,
        ),
    ]
    mentions = [
        CitationMention(key="1", page_index=0, bbox=BBox(10, 20, 30, 40)),
        CitationMention(key="1", page_index=0, bbox=BBox(50, 60, 70, 80)),
        CitationMention(key="2", page_index=1, bbox=BBox(1, 2, 3, 4)),
    ]
    return cites, mentions


def test_replace_and_list_citations_round_trip(tmp_path):
    path = _settings_db(tmp_path)
    cites, mentions = _fixture_data()

    with db.connect(path) as conn:
        _insert_document(conn, "doc1")
        citations.replace_citations(conn, "doc1", cites, mentions)

    with db.connect(path) as conn:
        rows = citations.list_citations(conn, "doc1")

    assert len(rows) == 2
    first = next(r for r in rows if r["key"] == "1")
    assert first["raw_text"] == "Smith, J. (2020). A paper. Some Venue."
    assert first["page_index"] == 2
    assert first["authors"] == "Smith, J."
    assert first["title"] == "A paper"
    assert first["year"] == "2020"
    assert first["venue"] == "Some Venue"
    assert first["doi"] == "10.1/xyz"

    second = next(r for r in rows if r["key"] == "2")
    assert second["authors"] is None
    assert second["title"] is None


def test_list_page_mentions_filters_by_page_and_round_trips_bbox(tmp_path):
    path = _settings_db(tmp_path)
    cites, mentions = _fixture_data()

    with db.connect(path) as conn:
        _insert_document(conn, "doc1")
        citations.replace_citations(conn, "doc1", cites, mentions)

    with db.connect(path) as conn:
        page0 = citations.list_page_mentions(conn, "doc1", 0)
        page1 = citations.list_page_mentions(conn, "doc1", 1)
        page2 = citations.list_page_mentions(conn, "doc1", 2)

    assert len(page0) == 2
    assert {m["key"] for m in page0} == {"1"}
    assert page0[0]["bbox"] == {"x0": 10, "y0": 20, "x1": 30, "y1": 40}
    assert page0[1]["bbox"] == {"x0": 50, "y0": 60, "x1": 70, "y1": 80}

    assert len(page1) == 1
    assert page1[0]["key"] == "2"
    assert page1[0]["bbox"] == {"x0": 1, "y0": 2, "x1": 3, "y1": 4}

    assert page2 == []


def test_replace_citations_deletes_previous_rows_for_doc(tmp_path):
    path = _settings_db(tmp_path)
    cites, mentions = _fixture_data()

    with db.connect(path) as conn:
        _insert_document(conn, "doc1")
        citations.replace_citations(conn, "doc1", cites, mentions)
        # Re-run with a smaller fixture set -- simulates a re-upload where
        # detection now finds fewer entries.
        citations.replace_citations(conn, "doc1", cites[:1], mentions[:1])

    with db.connect(path) as conn:
        rows = citations.list_citations(conn, "doc1")
        page_mentions = citations.list_page_mentions(conn, "doc1", 0)

    assert len(rows) == 1
    assert rows[0]["key"] == "1"
    assert len(page_mentions) == 1


def test_cascade_delete_on_document_removes_citations_and_mentions(tmp_path):
    path = _settings_db(tmp_path)
    cites, mentions = _fixture_data()

    with db.connect(path) as conn:
        _insert_document(conn, "doc1")
        citations.replace_citations(conn, "doc1", cites, mentions)

    with db.connect(path) as conn:
        conn.execute("DELETE FROM documents WHERE id = ?", ("doc1",))

    with db.connect(path) as conn:
        assert citations.list_citations(conn, "doc1") == []
        assert citations.list_page_mentions(conn, "doc1", 0) == []


def test_citations_scoped_per_document(tmp_path):
    path = _settings_db(tmp_path)
    cites, mentions = _fixture_data()

    with db.connect(path) as conn:
        _insert_document(conn, "doc1")
        _insert_document(conn, "doc2")
        citations.replace_citations(conn, "doc1", cites, mentions)

    with db.connect(path) as conn:
        assert len(citations.list_citations(conn, "doc1")) == 2
        assert citations.list_citations(conn, "doc2") == []
        assert citations.list_page_mentions(conn, "doc2", 0) == []
