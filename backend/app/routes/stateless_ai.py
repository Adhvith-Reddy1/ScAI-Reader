"""Stateless AI endpoints (browser-storage migration — Spec 03).

These mirror the annotation-scoped AI endpoints in ``explanations.py`` and
``figures.py`` but **persist nothing**: there are no DB reads or writes. The
request carries the highlighted text plus a page reference; the server extracts
that page's text from the PDF this session already uploaded (held only in the
ephemeral cache) to ground the model, streams the same SSE wire format, and
keeps no copy. The browser owns the durable highlights/explanations.

All prompt text and stream logic is imported from the existing route modules so
prompts live in exactly one place (Shared Contract B in docs/specs/README.md).
Pages are 1-indexed in the request body, matching the figures/text/search
endpoints; we convert to the 0-indexed page index the extractor expects.
"""

from __future__ import annotations

from typing import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .. import ai
from ..config import Settings
from ..pdf.backend import PdfError
from ..pdf.pdfium_backend import PdfiumBackend
from ..storage import files
from . import explanations as exp
from . import figures as fig
from .deps import get_settings

router = APIRouter(prefix="/documents/{doc_id}", tags=["stateless-ai"])

ExplanationKind = exp.ExplanationKind


def _page_text_for(settings: Settings, doc_id: str, page: int | None) -> str:
    """Page text for grounding when a 1-indexed page is supplied and the PDF is
    in the cache. Returns "" otherwise — a missing page reference or an evicted
    PDF just means no page context; the model still answers."""
    if page is None:
        return ""
    return exp._page_text(settings, doc_id, page - 1)


class StatelessExplainRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    kind: ExplanationKind | None = None
    page: int | None = Field(default=None, ge=1)


class StatelessChatRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    kind: ExplanationKind
    content: str = Field(default="", max_length=8000)
    page: int | None = Field(default=None, ge=1)
    messages: list[exp.ChatMessage] = Field(min_length=1)


class StatelessRefineRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    kind: ExplanationKind
    content: str = Field(default="", max_length=8000)
    page: int | None = Field(default=None, ge=1)
    messages: list[exp.ChatMessage] = Field(min_length=1)


@router.post("/ai/explain")
async def ai_explain(
    doc_id: str,
    body: StatelessExplainRequest,
    settings: Settings = Depends(get_settings),
) -> StreamingResponse:
    kind: ExplanationKind = body.kind or exp.classify(body.text)
    page_text = _page_text_for(settings, doc_id, body.page)
    config = ai.get_provider_config(settings)

    async def event_stream() -> AsyncIterator[bytes]:
        yield exp._sse_event({"type": "meta", "kind": kind, "cached": False})
        async for event_type, payload in exp._stream_explanation(
            config, page_text, body.text, kind
        ):
            if event_type == "delta":
                yield exp._sse_event({"type": "delta", "text": payload})
            elif event_type == "done":
                yield exp._sse_event({"type": "done", "text": payload})
            elif event_type == "error":
                yield exp._error_sse(payload)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/ai/chat")
async def ai_chat(
    doc_id: str,
    body: StatelessChatRequest,
    settings: Settings = Depends(get_settings),
) -> StreamingResponse:
    page_text = _page_text_for(settings, doc_id, body.page)
    config = ai.get_provider_config(settings)

    async def event_stream() -> AsyncIterator[bytes]:
        yield exp._sse_event(
            {"type": "meta", "kind": body.kind, "cached": False}
        )
        async for event_type, payload in exp._stream_chat(
            config, page_text, body
        ):
            if event_type == "delta":
                yield exp._sse_event({"type": "delta", "text": payload})
            elif event_type == "done":
                yield exp._sse_event({"type": "done", "text": payload})
            elif event_type == "error":
                yield exp._error_sse(payload)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/ai/refine")
async def ai_refine(
    doc_id: str,
    body: StatelessRefineRequest,
    settings: Settings = Depends(get_settings),
) -> StreamingResponse:
    page_text = _page_text_for(settings, doc_id, body.page)
    config = ai.get_provider_config(settings)

    async def event_stream() -> AsyncIterator[bytes]:
        yield exp._sse_event(
            {
                "type": "meta",
                "kind": body.kind,
                "cached": False,
                "refined": True,
            }
        )
        # No persistence: just stream the rewrite; the client caches it.
        async for event_type, payload in exp._stream_refine(
            config, page_text, body.text, body.kind, body.content, body.messages
        ):
            if event_type == "delta":
                yield exp._sse_event({"type": "delta", "text": payload})
            elif event_type == "done":
                yield exp._sse_event({"type": "done", "text": payload})
            elif event_type == "error":
                yield exp._error_sse(payload)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/figures/{figure_id}/ai-explain")
async def ai_explain_figure(
    doc_id: str,
    figure_id: str,
    body: fig.FigureExplainRequest,
    settings: Settings = Depends(get_settings),
) -> StreamingResponse:
    # The figure flow needs the page image, so unlike the text endpoints we
    # can't fall back to empty context — without the cached PDF there is nothing
    # to render.
    pdf_path = files.pdf_path(settings, doc_id)
    if not pdf_path.exists():
        raise HTTPException(status_code=404, detail="document not found")

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
        yield fig._sse_event({"type": "meta", "cached": False})
        async for event_type, payload in fig._stream_figure(
            config, page_text, page_png, body.label, body.page
        ):
            if event_type == "delta":
                yield fig._sse_event({"type": "delta", "text": payload})
            elif event_type == "done":
                yield fig._sse_event({"type": "done", "text": payload})
            elif event_type == "error":
                yield fig._error_sse(payload)

    return StreamingResponse(event_stream(), media_type="text/event-stream")
