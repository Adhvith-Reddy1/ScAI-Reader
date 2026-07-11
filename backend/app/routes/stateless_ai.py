"""Stateless AI endpoints (browser-storage migration — Spec 03).

These mirror the annotation-scoped AI endpoints in ``explanations.py`` and
``figures.py`` but **persist nothing**: there are no DB reads or writes. The
request carries the highlighted text plus a page reference. The browser is the
preferred source of page-text context: it already fetched and rendered this
page's text (for the selectable text layer), so it sends that string directly
in ``page_text``, which we use verbatim. We fall back to re-extracting from the
PDF this session uploaded (held only in the ephemeral, disk-less cache) only
when the client didn't supply it — that fallback is inherently fragile, since
the server's copy can vanish (idle scale-down, a redeploy, a restart) while a
reader's tab stays open, silently starving the model of context. Either way we
keep no copy afterward. The browser owns the durable highlights/explanations.

All prompt text and stream logic is imported from the existing route modules so
prompts live in exactly one place (Shared Contract B in docs/specs/README.md).
Pages are 1-indexed in the request body, matching the figures/text/search
endpoints; we convert to the 0-indexed page index the extractor expects.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import AsyncIterator

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .. import ai, quota
from ..config import Settings
from ..pdf.backend import PdfError
from ..pdf.pdfium_backend import PdfiumBackend
from ..storage import files
from . import explanations as exp
from . import figures as fig
from .deps import get_settings

router = APIRouter(prefix="/documents/{doc_id}", tags=["stateless-ai"])

ExplanationKind = exp.ExplanationKind


@dataclass
class AiGate:
    """Resolved per-request AI access: which provider config to use, and
    whether this call is allowed to proceed under the daily quota. A reader
    who supplies their own key (`X-User-Api-Key`) always gets `quota_ok=True`
    and isn't counted — they're spending their own budget, not the site's."""

    config: ai.ProviderConfig | None
    quota_ok: bool


def _ai_gate(
    request: Request,
    settings: Settings = Depends(get_settings),
    x_client_id: str | None = Header(default=None, alias="X-Client-Id"),
    x_user_api_key: str | None = Header(default=None, alias="X-User-Api-Key"),
) -> AiGate:
    shared = ai.get_provider_config(settings)
    user_key = (x_user_api_key or "").strip()
    if user_key:
        return AiGate(config=ai.with_override_key(shared, user_key), quota_ok=True)
    client_key = quota.resolve_client_key(request, x_client_id)
    ok = quota.try_consume(settings, client_key, settings.ai_daily_limit)
    return AiGate(config=shared, quota_ok=ok)


async def _gated_stream(
    gate: AiGate, real: AsyncIterator[tuple[str, str]]
) -> AsyncIterator[tuple[str, str]]:
    """Yields the quota-exceeded error frame instead of streaming when the
    gate denied the call; otherwise passes the real stream through untouched."""
    if not gate.quota_ok:
        yield ("error", ai.AI_QUOTA_EXCEEDED_MESSAGE)
        return
    async for event in real:
        yield event


def _page_text_for(
    settings: Settings,
    doc_id: str,
    page: int | None,
    override: str | None = None,
) -> str:
    """Page text for grounding. Prefers the browser-supplied ``override`` (the
    exact text it already rendered) so this never depends on the server's
    ephemeral PDF cache still being warm. Falls back to re-extracting from a
    1-indexed page when no override was sent. Returns "" if neither is
    available or extraction fails — the model still answers, just unguided."""
    if override:
        return override
    if page is None:
        return ""
    return exp._page_text(settings, doc_id, page - 1)


# Generous cap: a dense page of academic text runs a few thousand characters;
# this just guards against a pathological payload, not normal use.
_MAX_PAGE_TEXT_LEN = 20_000


class StatelessExplainRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    kind: ExplanationKind | None = None
    page: int | None = Field(default=None, ge=1)
    page_text: str | None = Field(default=None, max_length=_MAX_PAGE_TEXT_LEN)


class StatelessChatRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    kind: ExplanationKind
    content: str = Field(default="", max_length=8000)
    page: int | None = Field(default=None, ge=1)
    page_text: str | None = Field(default=None, max_length=_MAX_PAGE_TEXT_LEN)
    messages: list[exp.ChatMessage] = Field(min_length=1)


class StatelessRefineRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    kind: ExplanationKind
    content: str = Field(default="", max_length=8000)
    page: int | None = Field(default=None, ge=1)
    page_text: str | None = Field(default=None, max_length=_MAX_PAGE_TEXT_LEN)
    messages: list[exp.ChatMessage] = Field(min_length=1)


@router.post("/ai/explain")
async def ai_explain(
    doc_id: str,
    body: StatelessExplainRequest,
    settings: Settings = Depends(get_settings),
    gate: AiGate = Depends(_ai_gate),
) -> StreamingResponse:
    kind: ExplanationKind = body.kind or exp.classify(body.text)
    page_text = _page_text_for(settings, doc_id, body.page, body.page_text)

    async def event_stream() -> AsyncIterator[bytes]:
        yield exp._sse_event({"type": "meta", "kind": kind, "cached": False})
        async for event_type, payload in _gated_stream(
            gate, exp._stream_explanation(gate.config, page_text, body.text, kind)
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
    gate: AiGate = Depends(_ai_gate),
) -> StreamingResponse:
    page_text = _page_text_for(settings, doc_id, body.page, body.page_text)

    async def event_stream() -> AsyncIterator[bytes]:
        yield exp._sse_event(
            {"type": "meta", "kind": body.kind, "cached": False}
        )
        async for event_type, payload in _gated_stream(
            gate, exp._stream_chat(gate.config, page_text, body)
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
    gate: AiGate = Depends(_ai_gate),
) -> StreamingResponse:
    page_text = _page_text_for(settings, doc_id, body.page, body.page_text)

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
        async for event_type, payload in _gated_stream(
            gate,
            exp._stream_refine(
                gate.config, page_text, body.text, body.kind, body.content, body.messages
            ),
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
    gate: AiGate = Depends(_ai_gate),
) -> StreamingResponse:
    # The figure flow needs the page image, so unlike the text endpoints we
    # can't fall back to empty context — without the cached PDF there is nothing
    # to render.
    pdf_path = files.pdf_path(settings, doc_id)
    if not pdf_path.exists():
        raise HTTPException(status_code=404, detail="document not found")

    render_dpi = 150
    try:
        with PdfiumBackend.open(pdf_path) as backend:
            page_png = backend.render_page(body.page - 1, dpi=render_dpi)
            page = backend.get_page_text(body.page - 1)
            dims = backend.page_dimensions(body.page - 1)
    except PdfError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    cropped = False
    if body.bbox is not None:
        page_png = fig.crop_to_bbox(
            page_png, body.bbox, dims.width_pt, dims.height_pt, render_dpi
        )
        cropped = True

    page_text = " ".join(
        run.text.strip()
        for col in page.columns
        for run in col.runs
        if run.text.strip()
    )

    async def event_stream() -> AsyncIterator[bytes]:
        yield fig._sse_event({"type": "meta", "cached": False})
        async for event_type, payload in _gated_stream(
            gate,
            fig._stream_figure(
                gate.config, page_text, page_png, body.label, body.page, cropped=cropped
            ),
        ):
            if event_type == "delta":
                yield fig._sse_event({"type": "delta", "text": payload})
            elif event_type == "done":
                yield fig._sse_event({"type": "done", "text": payload})
            elif event_type == "error":
                yield fig._error_sse(payload)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/figures/{figure_id}/ai-chat")
async def ai_chat_figure(
    doc_id: str,
    figure_id: str,
    body: fig.FigureChatRequest,
    settings: Settings = Depends(get_settings),
    gate: AiGate = Depends(_ai_gate),
) -> StreamingResponse:
    """Stream a reply to a follow-up question about a figure the reader
    already saw an interpretation of. Mirrors `ai_explain_figure`'s image
    render/crop so the model still has the figure in view."""
    pdf_path = files.pdf_path(settings, doc_id)
    if not pdf_path.exists():
        raise HTTPException(status_code=404, detail="document not found")

    render_dpi = 150
    try:
        with PdfiumBackend.open(pdf_path) as backend:
            page_png = backend.render_page(body.page - 1, dpi=render_dpi)
            page = backend.get_page_text(body.page - 1)
            dims = backend.page_dimensions(body.page - 1)
    except PdfError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    if body.bbox is not None:
        page_png = fig.crop_to_bbox(
            page_png, body.bbox, dims.width_pt, dims.height_pt, render_dpi
        )

    page_text = " ".join(
        run.text.strip()
        for col in page.columns
        for run in col.runs
        if run.text.strip()
    )

    async def event_stream() -> AsyncIterator[bytes]:
        async for event_type, payload in _gated_stream(
            gate,
            fig._stream_figure_chat(
                gate.config,
                page_text,
                page_png,
                body.label,
                body.page,
                body.content,
                body.messages,
            ),
        ):
            if event_type == "delta":
                yield fig._sse_event({"type": "delta", "text": payload})
            elif event_type == "done":
                yield fig._sse_event({"type": "done", "text": payload})
            elif event_type == "error":
                yield fig._error_sse(payload)

    return StreamingResponse(event_stream(), media_type="text/event-stream")
