from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, UploadFile

from ..config import Settings
from ..pdf.backend import PdfError
from ..pdf.pdfium_backend import PdfiumBackend
from ..storage import db, files
from .deps import get_settings

router = APIRouter(prefix="/documents", tags=["documents"])


@router.post("")
async def upload_document(
    file: UploadFile,
    settings: Settings = Depends(get_settings),
) -> dict:
    data = await file.read()
    if len(data) == 0:
        raise HTTPException(status_code=400, detail="empty upload")
    if len(data) > settings.upload_max_bytes:
        raise HTTPException(status_code=413, detail="file too large")

    doc_id = files.save_pdf(settings, data)

    try:
        with PdfiumBackend.open(files.pdf_path(settings, doc_id)) as backend:
            meta = backend.metadata()
    except PdfError as e:
        files.pdf_path(settings, doc_id).unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=f"invalid PDF: {e}") from e

    now = datetime.now(timezone.utc).isoformat()
    # Proper UPSERT — must NOT use INSERT OR REPLACE because that's DELETE+INSERT
    # under the hood, which would cascade into the annotations table and wipe
    # every saved highlight every time the user re-uploaded the same PDF.
    with db.connect(settings.db_path) as conn:
        conn.execute(
            """
            INSERT INTO documents
                (id, filename, page_count, title, author, size_bytes, uploaded_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                filename    = excluded.filename,
                page_count  = excluded.page_count,
                title       = excluded.title,
                author      = excluded.author,
                size_bytes  = excluded.size_bytes
            """,
            (
                doc_id,
                file.filename or "upload.pdf",
                meta.page_count,
                meta.title,
                meta.author,
                len(data),
                now,
            ),
        )

    return {
        "id": doc_id,
        "filename": file.filename,
        "page_count": meta.page_count,
        "title": meta.title,
        "author": meta.author,
    }


@router.get("")
def list_documents(settings: Settings = Depends(get_settings)) -> list[dict]:
    with db.connect(settings.db_path) as conn:
        rows = conn.execute(
            "SELECT id, filename, page_count, title, author, size_bytes, uploaded_at "
            "FROM documents ORDER BY uploaded_at DESC"
        ).fetchall()
    return [dict(r) for r in rows]


@router.get("/{doc_id}")
def get_document(doc_id: str, settings: Settings = Depends(get_settings)) -> dict:
    with db.connect(settings.db_path) as conn:
        row = conn.execute(
            "SELECT id, filename, page_count, title, author, size_bytes, uploaded_at "
            "FROM documents WHERE id = ?",
            (doc_id,),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="document not found")
    return dict(row)
