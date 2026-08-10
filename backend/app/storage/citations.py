"""Storage helpers for the `citations` / `citation_mentions` tables.

Both tables are derived from the PDF's own text (see app.pdf.citations),
populated once at upload time and rebuilt on re-upload -- the same
delete-then-insert pattern `pages_fts` uses (see app.routes.documents).
"""

from __future__ import annotations

import sqlite3
from typing import Iterable, Sequence

from ..pdf.citations import Citation, CitationMention


def replace_citations(
    conn: sqlite3.Connection,
    doc_id: str,
    citations: Sequence[Citation],
    mentions: Sequence[CitationMention],
) -> None:
    """Replace all citation data for `doc_id`. Delete-then-insert, mirroring
    how `pages_fts` is kept in sync on re-upload -- doc_id is SHA-keyed so
    content is identical across re-uploads of the same file."""
    conn.execute("DELETE FROM citations WHERE doc_id = ?", (doc_id,))
    conn.execute("DELETE FROM citation_mentions WHERE doc_id = ?", (doc_id,))
    conn.executemany(
        """
        INSERT INTO citations
            (doc_id, key, raw_text, page_index, authors, title, year, venue, doi)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                doc_id,
                c.key,
                c.raw_text,
                c.page_index,
                c.authors,
                c.title,
                c.year,
                c.venue,
                c.doi,
            )
            for c in citations
        ],
    )
    conn.executemany(
        """
        INSERT INTO citation_mentions (doc_id, key, page_index, x0, y0, x1, y1)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                doc_id,
                m.key,
                m.page_index,
                m.bbox.x0,
                m.bbox.y0,
                m.bbox.x1,
                m.bbox.y1,
            )
            for m in mentions
        ],
    )


def list_citations(conn: sqlite3.Connection, doc_id: str) -> list[dict]:
    """All bibliography entries for a document, in reference-list order
    (source insertion order, i.e. rowid order)."""
    rows: Iterable[sqlite3.Row] = conn.execute(
        """
        SELECT key, raw_text, page_index, authors, title, year, venue, doi
        FROM citations
        WHERE doc_id = ?
        ORDER BY rowid
        """,
        (doc_id,),
    ).fetchall()
    return [
        {
            "key": row["key"],
            "raw_text": row["raw_text"],
            "page_index": row["page_index"],
            "authors": row["authors"],
            "title": row["title"],
            "year": row["year"],
            "venue": row["venue"],
            "doi": row["doi"],
        }
        for row in rows
    ]


def list_page_mentions(
    conn: sqlite3.Connection, doc_id: str, page_index: int
) -> list[dict]:
    """In-text citation mentions on a single page."""
    rows: Iterable[sqlite3.Row] = conn.execute(
        """
        SELECT key, page_index, x0, y0, x1, y1
        FROM citation_mentions
        WHERE doc_id = ? AND page_index = ?
        ORDER BY rowid
        """,
        (doc_id, page_index),
    ).fetchall()
    return [
        {
            "key": row["key"],
            "page_index": row["page_index"],
            "bbox": {
                "x0": row["x0"],
                "y0": row["y0"],
                "x1": row["x1"],
                "y1": row["y1"],
            },
        }
        for row in rows
    ]
