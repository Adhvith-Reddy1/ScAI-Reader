from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response

from ..config import Settings
from ..pdf.backend import PdfError
from ..pdf.pdfium_backend import PdfiumBackend, sniff_image_mime
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
    """Render page (1-indexed for client friendliness). PNG for pages without
    a raster image, JPEG for pages with one (see PdfiumBackend.render_page) —
    the URL keeps the `.png` suffix for stability, but the browser decodes by
    the Content-Type header below, not the URL, so this is transparent."""
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
        image_bytes = cache.read_bytes()
        return Response(
            content=image_bytes,
            media_type=sniff_image_mime(image_bytes),
            headers={"Cache-Control": "public, max-age=31536000, immutable"},
        )

    try:
        with PdfiumBackend.open(pdf_path) as backend:
            image_bytes = backend.render_page(page_number - 1, effective_dpi)
    except PdfError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    files.write_render_cache(
        settings, doc_id, page_number - 1, effective_dpi, image_bytes
    )

    return Response(
        content=image_bytes,
        media_type=sniff_image_mime(image_bytes),
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )
