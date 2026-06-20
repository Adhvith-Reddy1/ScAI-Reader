from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response

from ..config import Settings
from ..pdf.backend import PdfError
from ..pdf.pdfium_backend import PdfiumBackend
from ..storage import files
from .deps import get_settings

router = APIRouter(prefix="/documents/{doc_id}/pages", tags=["pages"])


@router.get("/{page_number}.png")
def render_page_png(
    doc_id: str,
    page_number: int,
    dpi: int | None = None,
    settings: Settings = Depends(get_settings),
) -> Response:
    """Render page (1-indexed for client friendliness) to PNG."""
    pdf_path = files.pdf_path(settings, doc_id)
    if not pdf_path.exists():
        raise HTTPException(status_code=404, detail="document not found")

    effective_dpi = settings.default_dpi if dpi is None else dpi
    if effective_dpi <= 0 or effective_dpi > settings.max_dpi:
        raise HTTPException(
            status_code=400,
            detail=f"dpi must be in (0, {settings.max_dpi}]",
        )

    cache = files.render_path(settings, doc_id, page_number - 1, effective_dpi)
    if cache.exists():
        return Response(
            content=cache.read_bytes(),
            media_type="image/png",
            headers={"Cache-Control": "public, max-age=31536000, immutable"},
        )

    try:
        with PdfiumBackend.open(pdf_path) as backend:
            png = backend.render_page(page_number - 1, effective_dpi)
    except PdfError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    files.write_render_cache(settings, doc_id, page_number - 1, effective_dpi, png)

    return Response(
        content=png,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )
