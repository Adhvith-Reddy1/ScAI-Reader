"""Citation endpoints: a document's bibliography and in-text mentions.

Both are read-only lookups against `citations` / `citation_mentions` (see
app.storage.citations, app.storage.db.SCHEMA) -- derived data populated at
upload time by app.pdf.citations.detect_citations, following the same
"index at upload, query later" pattern as `pages_fts` (app.routes.search).

Population isn't wired up yet (detect_citations is a separate piece of
work); until it is, these routes just return whatever's in the DB, which is
nothing for any document uploaded so far. That's expected -- see the
upload-time wiring TODO in app.routes.documents once detect_citations lands.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from ..config import Settings
from ..storage import citations as citations_storage
from ..storage import db, files
from .deps import get_settings

router = APIRouter(prefix="/documents/{doc_id}", tags=["citations"])


def _doc_exists(settings: Settings, doc_id: str) -> bool:
    return files.pdf_path(settings, doc_id).exists()


@router.get("/citations")
def list_citations(doc_id: str, settings: Settings = Depends(get_settings)) -> dict:
    """All bibliography entries for a document (its reference list)."""
    if not _doc_exists(settings, doc_id):
        raise HTTPException(status_code=404, detail="document not found")

    with db.connect(settings.db_path) as conn:
        rows = citations_storage.list_citations(conn, doc_id)

    return {
        "doc_id": doc_id,
        "citations": [_citation_to_dict(row) for row in rows],
    }


@router.get("/pages/{page_number}/citation-mentions")
def list_page_citation_mentions(
    doc_id: str,
    page_number: int,
    settings: Settings = Depends(get_settings),
) -> dict:
    """In-text citation marker occurrences on a single page.

    Coordinates are page-space points (top-left origin), the same
    convention as `/pages/{n}/figures` and `/pages/{n}/text`.
    """
    if not _doc_exists(settings, doc_id):
        raise HTTPException(status_code=404, detail="document not found")
    if page_number < 1:
        raise HTTPException(status_code=400, detail="page must be >= 1")

    with db.connect(settings.db_path) as conn:
        rows = citations_storage.list_page_mentions(conn, doc_id, page_number - 1)

    return {
        "doc_id": doc_id,
        "page": page_number,
        "mentions": [_mention_to_dict(row) for row in rows],
    }


def _citation_to_dict(row: dict) -> dict:
    return {
        "key": row["key"],
        "raw_text": row["raw_text"],
        "page": row["page_index"] + 1,
        "authors": row["authors"],
        "title": row["title"],
        "year": row["year"],
        "venue": row["venue"],
        "doi": row["doi"],
    }


def _mention_to_dict(row: dict) -> dict:
    return {
        "key": row["key"],
        "page": row["page_index"] + 1,
        "bbox": row["bbox"],
    }
