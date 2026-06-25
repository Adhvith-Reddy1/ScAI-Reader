"""Figure detection and AI-explanation endpoints.

A figure is identified by `figure_id`, a stable label per (doc_id, page,
caption-label) — see `app/pdf/figures.py`. Detection runs on demand per
page; it's a regex sweep over the existing text layer so it's cheap and
needs no persistence of its own.

Explanations follow the same pattern as the highlight explanations: a
streaming SSE endpoint that talks to Claude with the PDF + page image
attached and persists the final text to SQLite. Subsequent hits short-
circuit to the cached row and reply with a single SSE flush.
"""

from __future__ import annotations

import base64
import json
import logging
from datetime import datetime, timezone
from typing import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .. import ai, llm
from ..config import Settings
from ..pdf.backend import PdfError
from ..pdf.figures import FigureRegion, detect_figures
from ..pdf.pdfium_backend import PdfiumBackend
from ..storage import db, files
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


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sse_event(data: dict) -> bytes:
    return f"data: {json.dumps(data)}\n\n".encode("utf-8")


def _error_sse(message: str) -> bytes:
    """Error frame, tagged with a code when AI isn't configured so the UI can
    offer one-click setup instead of showing a raw error."""
    frame: dict = {"type": "error", "message": message}
    if message == ai.AI_NOT_CONFIGURED_MESSAGE:
        frame["code"] = ai.AI_NOT_CONFIGURED_CODE
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

    # Inline any cached explanation so the frontend can seed its store
    # exactly like it does for highlight annotations.
    cached_map: dict[str, dict] = {}
    if regions:
        ids = [r.figure_id for r in regions]
        placeholders = ",".join("?" * len(ids))
        with db.connect(settings.db_path) as conn:
            rows = conn.execute(
                f"SELECT figure_id, content, status FROM figure_explanations "
                f"WHERE doc_id = ? AND figure_id IN ({placeholders})",
                (doc_id, *ids),
            ).fetchall()
        for row in rows:
            if row["status"] == "complete" and row["content"]:
                cached_map[row["figure_id"]] = {"content": row["content"]}

    return {
        "doc_id": doc_id,
        "page": page_number,
        "page_width_pt": dims.width_pt,
        "page_height_pt": dims.height_pt,
        "figures": [_region_to_dict(r, cached_map) for r in regions],
    }


def _region_to_dict(r: FigureRegion, cached: dict[str, dict]) -> dict:
    out: dict = {
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
    if r.figure_id in cached:
        out["explanation"] = cached[r.figure_id]
    return out


def _load_figure_explanation(conn, doc_id: str, figure_id: str) -> dict | None:
    row = conn.execute(
        "SELECT figure_id, doc_id, page_index, label, content, status, "
        "error, created_at, updated_at FROM figure_explanations "
        "WHERE doc_id = ? AND figure_id = ?",
        (doc_id, figure_id),
    ).fetchone()
    if row is None:
        return None
    return {
        "figure_id": row["figure_id"],
        "doc_id": row["doc_id"],
        "page": row["page_index"] + 1,
        "label": row["label"],
        "content": row["content"],
        "status": row["status"],
        "error": row["error"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _upsert_figure_pending(
    conn,
    doc_id: str,
    figure_id: str,
    page_index: int,
    label: str,
) -> None:
    now = _now()
    conn.execute(
        "INSERT INTO figure_explanations "
        "(figure_id, doc_id, page_index, label, content, status, error, "
        " created_at, updated_at) "
        "VALUES (?, ?, ?, ?, NULL, 'pending', NULL, ?, ?) "
        "ON CONFLICT(doc_id, figure_id) DO UPDATE SET "
        "  page_index=excluded.page_index, label=excluded.label, "
        "  content=NULL, status='pending', error=NULL, "
        "  updated_at=excluded.updated_at",
        (figure_id, doc_id, page_index, label, now, now),
    )


def _finalize_figure(
    conn,
    doc_id: str,
    figure_id: str,
    content: str | None,
    error: str | None,
) -> None:
    status = "error" if error else "complete"
    conn.execute(
        "UPDATE figure_explanations SET content = ?, status = ?, error = ?, "
        "updated_at = ? WHERE doc_id = ? AND figure_id = ?",
        (content, status, error, _now(), doc_id, figure_id),
    )


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


@router.get("/figures/{figure_id}/explanation")
def get_figure_explanation(
    doc_id: str,
    figure_id: str,
    settings: Settings = Depends(get_settings),
) -> dict:
    if not _doc_exists(settings, doc_id):
        raise HTTPException(status_code=404, detail="document not found")
    with db.connect(settings.db_path) as conn:
        existing = _load_figure_explanation(conn, doc_id, figure_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="no explanation yet")
    return existing


@router.post("/figures/{figure_id}/explain")
async def explain_figure(
    doc_id: str,
    figure_id: str,
    body: FigureExplainRequest,
    settings: Settings = Depends(get_settings),
) -> StreamingResponse:
    pdf_path = files.pdf_path(settings, doc_id)
    if not pdf_path.exists():
        raise HTTPException(status_code=404, detail="document not found")

    # Cache check before any rendering.
    with db.connect(settings.db_path) as conn:
        cached = _load_figure_explanation(conn, doc_id, figure_id)
        if (
            cached is not None
            and cached["status"] == "complete"
            and cached["label"] == body.label
            and cached["content"]
        ):
            content = cached["content"]

            async def cached_stream() -> AsyncIterator[bytes]:
                yield _sse_event({"type": "meta", "cached": True})
                yield _sse_event({"type": "delta", "text": content})
                yield _sse_event({"type": "done", "text": content})

            return StreamingResponse(
                cached_stream(), media_type="text/event-stream"
            )

        _upsert_figure_pending(
            conn, doc_id, figure_id, body.page - 1, body.label
        )

    # Render the page at 150 DPI (ample for any figure) and grab its text — the
    # image disambiguates the figure, the text grounds the explanation.
    try:
        with PdfiumBackend.open(pdf_path) as backend:
            page_png = backend.render_page(body.page - 1, dpi=150)
            page = backend.get_page_text(body.page - 1)
    except PdfError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    page_text = " ".join(
        run.text.strip()
        for col in page.columns
        for run in col.runs
        if run.text.strip()
    )
    config = ai.get_provider_config(settings)

    async def event_stream() -> AsyncIterator[bytes]:
        yield _sse_event({"type": "meta", "cached": False})
        final_text: str | None = None
        error_text: str | None = None
        async for event_type, payload in _stream_figure(
            config, page_text, page_png, body.label, body.page
        ):
            if event_type == "delta":
                yield _sse_event({"type": "delta", "text": payload})
            elif event_type == "done":
                final_text = payload
                yield _sse_event({"type": "done", "text": payload})
            elif event_type == "error":
                error_text = payload
                yield _error_sse(payload)

        with db.connect(settings.db_path) as conn:
            _finalize_figure(conn, doc_id, figure_id, final_text, error_text)

    return StreamingResponse(event_stream(), media_type="text/event-stream")
