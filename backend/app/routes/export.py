"""Download-with-highlights: bundle a document's highlights + AI explanations
into the PDF itself as an embedded attachment.

The browser is the source of truth for personal data (Spec 02) — the server
persists no annotations or explanations. So "download a PDF with my
highlights" can't be served from server state; the client supplies its own
IndexedDB rows in the request body, and this endpoint stitches them onto the
PDF it already has cached from upload (see `routes/documents.py`). The result
is a normal, valid PDF — any other viewer just sees an inert attachment — so
it's still safe to email or hand to someone without this app.

On the way back in, `upload_document` looks for this same attachment and
hands its contents back to the client, which re-seeds its local `annotations`
/ `explanations` stores under the newly-assigned document id (see
`frontend/src/main.ts`). That round trip is what makes opening a
shared/downloaded PDF in ScAI-Reader restore the same highlights and pop-up
explanations for whoever opens it next.
"""

from __future__ import annotations

import io
import json
from typing import Any
from urllib.parse import quote

import pypdf
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from ..config import Settings
from ..storage import files
from .deps import get_settings

router = APIRouter(prefix="/documents", tags=["export"])

BUNDLE_ATTACHMENT_NAME = "scai-reader-data.json"
BUNDLE_FORMAT = "scai-reader-bundle"
BUNDLE_VERSION = 1
# Sanity ceiling, not a real-world limit — guards against a malformed/abusive
# request forcing the server to build an enormous PDF.
MAX_BUNDLE_ITEMS = 5000


class ExportRequest(BaseModel):
    annotations: list[dict[str, Any]] = Field(default_factory=list)
    explanations: list[dict[str, Any]] = Field(default_factory=list)
    filename: str | None = None


def _safe_filename(name: str | None, doc_id: str) -> str:
    """Sanitize a client-supplied filename for a Content-Disposition header.

    Strips characters that could break out of the quoted header value
    (quotes, control characters incl. CR/LF) rather than rejecting the
    request outright — a download filename is cosmetic, not load-bearing.
    """
    cleaned = "".join(
        ch for ch in (name or "") if ch.isprintable() and ch not in ('"', "\\")
    ).strip()
    if not cleaned:
        cleaned = f"{doc_id}.pdf"
    if not cleaned.lower().endswith(".pdf"):
        cleaned += ".pdf"
    return cleaned


@router.post("/{doc_id}/export")
def export_document(
    doc_id: str,
    body: ExportRequest,
    settings: Settings = Depends(get_settings),
) -> Response:
    if len(body.annotations) + len(body.explanations) > MAX_BUNDLE_ITEMS:
        raise HTTPException(
            status_code=400, detail="too many annotations/explanations to export"
        )

    pdf_path = files.pdf_path(settings, doc_id)
    if not pdf_path.exists():
        raise HTTPException(
            status_code=404,
            detail="document not found on the server — reopen it in the "
            "reader (so it re-syncs) before downloading",
        )

    bundle = {
        "format": BUNDLE_FORMAT,
        "version": BUNDLE_VERSION,
        "annotations": body.annotations,
        "explanations": body.explanations,
    }
    bundle_bytes = json.dumps(bundle).encode("utf-8")

    try:
        # clone_from copies pages byte-for-byte (no re-render), so stored
        # highlight rects — page-space PDF points — still line up exactly.
        writer = pypdf.PdfWriter(clone_from=pdf_path)
        writer.add_attachment(BUNDLE_ATTACHMENT_NAME, bundle_bytes)
        out = io.BytesIO()
        writer.write(out)
    except Exception as e:  # pypdf raises varied error types on odd PDFs
        raise HTTPException(
            status_code=500, detail=f"failed to prepare download: {e}"
        ) from e

    filename = _safe_filename(body.filename, doc_id)
    quoted = quote(filename)
    return Response(
        content=out.getvalue(),
        media_type="application/pdf",
        headers={
            "Content-Disposition": (
                f'attachment; filename="{filename}"; filename*=UTF-8\'\'{quoted}'
            )
        },
    )
