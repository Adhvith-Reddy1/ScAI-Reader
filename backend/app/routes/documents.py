from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, UploadFile

from ..config import Settings
from ..pdf.backend import PdfError
from ..pdf.pdfium_backend import PdfiumBackend
from ..pdf.types import PageText
from ..storage import db, files
from .deps import get_settings


def _flatten_page_text(page: PageText) -> str:
    """One whitespace-separated string per page, in reading order. The FTS5
    tokenizer splits on whitespace and punctuation so the exact joiner doesn't
    affect matchable tokens, but a space keeps snippets readable."""
    parts: list[str] = []
    for col in page.columns:
        for run in col.runs:
            t = run.text.strip()
            if t:
                parts.append(t)
    return " ".join(parts)

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
            dims = [backend.page_dimensions(i) for i in range(meta.page_count)]
            # Concatenated per-page text for the FTS index. Done inside the
            # PDFium context so we open the document once. Slow on large docs;
            # that's accepted — the search wouldn't work otherwise.
            page_texts = [
                _flatten_page_text(backend.get_page_text(i))
                for i in range(meta.page_count)
            ]
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
        # Dimensions are stable for a given (SHA-keyed) doc — INSERT OR IGNORE
        # leaves any previously cached rows alone on re-upload.
        conn.executemany(
            "INSERT OR IGNORE INTO page_dimensions "
            "(doc_id, page_index, width_pt, height_pt) VALUES (?, ?, ?, ?)",
            [(doc_id, i, d.width_pt, d.height_pt) for i, d in enumerate(dims)],
        )
        # FTS5 doesn't support ON CONFLICT; doc_id is SHA-keyed so content is
        # identical on re-upload. Delete-then-insert keeps the index in sync
        # without growing duplicate rows.
        conn.execute("DELETE FROM pages_fts WHERE doc_id = ?", (doc_id,))
        conn.executemany(
            "INSERT INTO pages_fts (doc_id, page_index, text) VALUES (?, ?, ?)",
            [(doc_id, i + 1, text) for i, text in enumerate(page_texts)],
        )

    return {
        "id": doc_id,
        "filename": file.filename,
        "page_count": meta.page_count,
        "title": meta.title,
        "author": meta.author,
    }


@router.get("/{doc_id}/dimensions")
def get_dimensions(doc_id: str, settings: Settings = Depends(get_settings)) -> dict:
    """Per-page sizes in PDF points. Used by the frontend to reserve scroll
    space for unrendered pages — the virtualizer needs an honest total height
    before any page raster has loaded."""
    with db.connect(settings.db_path) as conn:
        doc = conn.execute(
            "SELECT page_count FROM documents WHERE id = ?", (doc_id,)
        ).fetchone()
        if doc is None:
            raise HTTPException(status_code=404, detail="document not found")

        rows = conn.execute(
            "SELECT page_index, width_pt, height_pt FROM page_dimensions "
            "WHERE doc_id = ? ORDER BY page_index",
            (doc_id,),
        ).fetchall()

    # Lazy populate: docs uploaded before this endpoint existed have no rows.
    if len(rows) != doc["page_count"]:
        pdf_path = files.pdf_path(settings, doc_id)
        if not pdf_path.exists():
            raise HTTPException(status_code=404, detail="document file missing")
        try:
            with PdfiumBackend.open(pdf_path) as backend:
                computed = [
                    backend.page_dimensions(i) for i in range(doc["page_count"])
                ]
        except PdfError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        with db.connect(settings.db_path) as conn:
            conn.executemany(
                "INSERT OR REPLACE INTO page_dimensions "
                "(doc_id, page_index, width_pt, height_pt) VALUES (?, ?, ?, ?)",
                [(doc_id, i, d.width_pt, d.height_pt) for i, d in enumerate(computed)],
            )
        pages = [
            {"page": i + 1, "width_pt": d.width_pt, "height_pt": d.height_pt}
            for i, d in enumerate(computed)
        ]
    else:
        pages = [
            {
                "page": r["page_index"] + 1,
                "width_pt": r["width_pt"],
                "height_pt": r["height_pt"],
            }
            for r in rows
        ]

    return {"doc_id": doc_id, "pages": pages}
