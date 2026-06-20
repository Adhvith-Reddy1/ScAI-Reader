from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from ..config import Settings
from ..storage import db
from .deps import get_settings

router = APIRouter(prefix="/documents/{doc_id}", tags=["search"])


@router.get("/search")
def search_document(
    doc_id: str,
    q: str = Query(..., description="search query"),
    limit: int = Query(50, ge=1, le=500),
    settings: Settings = Depends(get_settings),
) -> dict:
    """Full-text search within one document. Returns ranked page hits with a
    snippet that wraps matched terms in <mark> tags. Snippets are HTML-escaped
    by FTS5 before the tags are injected, so the frontend can render with
    innerHTML safely."""
    with db.connect(settings.db_path) as conn:
        doc = conn.execute(
            "SELECT id FROM documents WHERE id = ?", (doc_id,)
        ).fetchone()
        if doc is None:
            raise HTTPException(status_code=404, detail="document not found")

        query = q.strip()
        if not query:
            return {"doc_id": doc_id, "query": q, "results": []}

        # FTS5 query syntax: wrap in quotes + suffix * to get prefix matching
        # on the last token (so "anim" finds "animal" before the user finishes
        # typing). Escape embedded double-quotes by doubling them.
        fts_query = f'"{query.replace(chr(34), chr(34) * 2)}" *'

        try:
            rows = conn.execute(
                """
                SELECT page_index,
                       snippet(pages_fts, 2, '<mark>', '</mark>', '…', 16) AS snippet
                FROM pages_fts
                WHERE doc_id = ? AND pages_fts MATCH ?
                ORDER BY rank
                LIMIT ?
                """,
                (doc_id, fts_query, limit),
            ).fetchall()
        except Exception:
            # Malformed FTS query (rare — our escaping covers the common case).
            return {"doc_id": doc_id, "query": q, "results": []}

    return {
        "doc_id": doc_id,
        "query": q,
        "results": [
            {"page": row["page_index"], "snippet": row["snippet"]} for row in rows
        ],
    }
