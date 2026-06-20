from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from ..config import Settings
from ..pdf.backend import PdfError
from ..pdf.pdfium_backend import PdfiumBackend
from ..storage import files
from .deps import get_settings

router = APIRouter(prefix="/documents/{doc_id}/pages", tags=["text"])


@router.get("/{page_number}/text")
def get_page_text(
    doc_id: str,
    page_number: int,
    settings: Settings = Depends(get_settings),
) -> dict:
    """Per-page text runs grouped into reading-order columns.

    Frontend uses this to render the invisible-span text layer that makes
    image-based pages selectable. Coordinates are in PDF points with origin
    top-left; the client scales by ``display_w / page_width_pt``.
    """
    pdf_path = files.pdf_path(settings, doc_id)
    if not pdf_path.exists():
        raise HTTPException(status_code=404, detail="document not found")

    try:
        with PdfiumBackend.open(pdf_path) as backend:
            dims = backend.page_dimensions(page_number - 1)
            page = backend.get_page_text(page_number - 1)
    except PdfError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    return {
        "page_index": page.page_index,
        "page_width_pt": dims.width_pt,
        "page_height_pt": dims.height_pt,
        "columns": [
            {
                "bbox": _bbox(col.bbox),
                "runs": [
                    {
                        "text": r.text,
                        "bbox": _bbox(r.bbox),
                        "font_size": r.font_size,
                    }
                    for r in col.runs
                ],
            }
            for col in page.columns
        ],
    }


def _bbox(b) -> dict:
    return {"x0": b.x0, "y0": b.y0, "x1": b.x1, "y1": b.y1}
