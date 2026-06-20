from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from ..config import Settings
from ..pdf.backend import PdfError
from ..pdf.pdfium_backend import PdfiumBackend
from ..pdf.types import OutlineNode
from ..storage import db, files
from .deps import get_settings

router = APIRouter(prefix="/documents/{doc_id}/outline", tags=["outline"])


@router.get("")
def get_outline(
    doc_id: str,
    settings: Settings = Depends(get_settings),
) -> dict:
    """Document outline / bookmarks as a nested tree.

    Pages are 1-indexed in the response (the backend tree uses 0-indexed
    ``page_index``). Outline entries without a resolvable destination return
    ``page: null``.
    """
    with db.connect(settings.db_path) as conn:
        row = conn.execute(
            "SELECT 1 FROM documents WHERE id = ?", (doc_id,)
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="document not found")

    pdf_path = files.pdf_path(settings, doc_id)
    if not pdf_path.exists():
        raise HTTPException(status_code=404, detail="document file missing")

    try:
        with PdfiumBackend.open(pdf_path) as backend:
            nodes = backend.get_outline()
    except PdfError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    return {"doc_id": doc_id, "nodes": [_serialize(n) for n in nodes]}


def _serialize(node: OutlineNode) -> dict:
    return {
        "title": node.title,
        "page": node.page_index + 1 if node.page_index is not None else None,
        "children": [_serialize(c) for c in node.children],
    }
