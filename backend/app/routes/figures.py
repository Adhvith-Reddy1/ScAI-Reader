"""Figure detection endpoint plus shared figure-explanation prompt/stream.

A figure is identified by `figure_id`, a stable label per (doc_id, page,
caption-label) — see `app/pdf/figures.py`. Detection runs on demand per
page; it's a regex sweep over the existing text layer so it's cheap and
needs no persistence of its own.

After the browser-storage migration the server no longer persists figure
explanations; the streaming explain flow lives in ``stateless_ai.py`` and
reuses the prompt/stream helpers below. The browser caches the result.
"""

from __future__ import annotations

import base64
import json
import logging
from typing import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import ai, llm
from ..config import Settings
from ..pdf.backend import PdfError
from ..pdf.figures import FigureRegion, detect_figures
from ..pdf.pdfium_backend import PdfiumBackend
from ..storage import files
from .deps import get_settings

log = logging.getLogger(__name__)

router = APIRouter(prefix="/documents/{doc_id}", tags=["figures"])

# Figure explanations need a vision-capable model; the provider's "good" tier
# default (see app.ai.DEFAULT_MODELS) is used unless the user overrides it.

SYSTEM_FIGURE = (
    "You are an in-page assistant inside an academic PDF reader. The user "
    "double-clicked a figure. Explain the figure in plain language with one "
    "specific purpose: let the reader keep reading the paper instead of "
    "stopping to puzzle it out. Lead with what the figure shows in one "
    "sentence. Then one sentence on what to take away — the result, not "
    "the mechanism. If panels are labelled (a, b, c) only mention a panel "
    "when it changes the takeaway. Hard limit: 3 sentences, 70 words, no "
    "preamble, no recap of the caption, no bullets. The reader will return "
    "to the text within seconds."
)


def _sse_event(data: dict) -> bytes:
    return f"data: {json.dumps(data)}\n\n".encode("utf-8")


def _error_sse(message: str) -> bytes:
    """Error frame, tagged with a code when AI isn't configured so the UI can
    offer one-click setup instead of showing a raw error."""
    frame: dict = {"type": "error", "message": message}
    code = ai.error_code(message)
    if code:
        frame["code"] = code
    return _sse_event(frame)


def _doc_exists(settings: Settings, doc_id: str) -> bool:
    return files.pdf_path(settings, doc_id).exists()


@router.get("/pages/{page_number}/figures")
def list_page_figures(
    doc_id: str,
    page_number: int,
    settings: Settings = Depends(get_settings),
) -> dict:
    """Detect figure regions on a single page.

    Cheap and stateless — text-layer regex + bbox math. Returns coordinates
    in page-space points (top-left origin), the same convention as
    `/pages/{n}/text` so the frontend can scale them with the same
    transform it already uses for the text layer.
    """
    if not _doc_exists(settings, doc_id):
        raise HTTPException(status_code=404, detail="document not found")
    if page_number < 1:
        raise HTTPException(status_code=400, detail="page must be >= 1")

    try:
        with PdfiumBackend.open(files.pdf_path(settings, doc_id)) as backend:
            dims = backend.page_dimensions(page_number - 1)
            page = backend.get_page_text(page_number - 1)
    except PdfError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    regions = detect_figures(page, dims.width_pt, dims.height_pt)

    return {
        "doc_id": doc_id,
        "page": page_number,
        "page_width_pt": dims.width_pt,
        "page_height_pt": dims.height_pt,
        "figures": [_region_to_dict(r) for r in regions],
    }


def _region_to_dict(r: FigureRegion) -> dict:
    return {
        "figure_id": r.figure_id,
        "label": r.label,
        "page": r.page_index + 1,
        "bbox": {
            "x0": r.bbox.x0,
            "y0": r.bbox.y0,
            "x1": r.bbox.x1,
            "y1": r.bbox.y1,
        },
        "caption_bbox": {
            "x0": r.caption_bbox.x0,
            "y0": r.caption_bbox.y0,
            "x1": r.caption_bbox.x1,
            "y1": r.caption_bbox.y1,
        },
    }


class FigureExplainRequest(BaseModel):
    page: int = Field(ge=1)
    label: str = Field(min_length=1, max_length=64)


def _stream_figure(
    config,
    page_text: str,
    page_png_bytes: bytes,
    label: str,
    page_number: int,
) -> AsyncIterator[tuple[str, str]]:
    page_b64 = base64.standard_b64encode(page_png_bytes).decode("ascii")
    context = (
        f"For context, here is the text of page {page_number}:\n\n"
        f"<page>\n{page_text}\n</page>\n\n"
        if page_text
        else ""
    )
    instruction = (
        context
        + f"Focus on {label} (page {page_number}). The full page image is "
        "attached to disambiguate which figure I mean. Explain it for a "
        "reader who's mid-paragraph and wants to keep reading the paper."
    )
    messages = [
        {
            "role": "user",
            "content": [
                llm.image_part("image/png", page_b64),
                llm.text_part(instruction),
            ],
        }
    ]
    return llm.stream_completion(
        config, system=SYSTEM_FIGURE, messages=messages, max_tokens=200
    )
