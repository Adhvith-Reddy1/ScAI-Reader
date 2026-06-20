from __future__ import annotations

import base64
import json
import logging
import os
from datetime import datetime, timezone
from typing import AsyncIterator, Literal

import anthropic
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..config import Settings
from ..storage import db, files
from .deps import get_settings

log = logging.getLogger(__name__)

router = APIRouter(
    prefix="/documents/{doc_id}/annotations/{annotation_id}",
    tags=["explanations"],
)

ExplanationKind = Literal["definition", "explanation"]

# Sonnet for short definitions, Opus for nuanced explanations — as requested.
MODEL_DEFINITION = "claude-sonnet-4-6"
MODEL_EXPLANATION = "claude-opus-4-7"

SYSTEM_DEFINITION = (
    "You are a glossary tooltip inside an academic PDF reader. The user "
    "highlighted a term. Your job is to define the term — not to describe "
    "how the paper uses it. Lead with what the term itself means, in the "
    "general technical sense. Only after the definition is clear should "
    "you add a short clause connecting it to the paper's usage, and only "
    "if that connection is non-obvious. If the term has no general meaning "
    "and is paper-specific (e.g. a coined name like 'Virtual Lab'), say "
    "so and define it from the paper. Hard limit: 35 words, 1-2 sentences, "
    "no preamble. Assume a technically literate reader. A reader who "
    "doesn't know the term should walk away knowing it; a reader who does "
    "should learn nothing new from the first clause and that is fine."
)

SYSTEM_EXPLANATION = (
    "You are a hover-tooltip helper inside an academic PDF reader. The "
    "user highlighted a sentence they found unclear. Restate what the "
    "authors are saying in plainer language. Hard limit: 2 sentences, "
    "45 words total, no preamble, no recap of what they wrote. Lead "
    "with the point. The reader will return to the paper immediately — "
    "give them only what unblocks them."
)


def classify(text: str) -> ExplanationKind:
    """Heuristic: short, punctuation-free runs are looked-up terms;
    anything longer or sentence-shaped is treated as a passage to unpack."""
    stripped = text.strip()
    word_count = len(stripped.split())
    has_terminal = any(c in stripped for c in ".!?")
    if word_count <= 4 and not has_terminal:
        return "definition"
    return "explanation"


class ExplainRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    kind: ExplanationKind | None = None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_explanation(conn, annotation_id: str) -> dict | None:
    row = conn.execute(
        "SELECT annotation_id, kind, text, content, status, error, "
        "created_at, updated_at FROM explanations WHERE annotation_id = ?",
        (annotation_id,),
    ).fetchone()
    if row is None:
        return None
    return {
        "annotation_id": row["annotation_id"],
        "kind": row["kind"],
        "text": row["text"],
        "content": row["content"],
        "status": row["status"],
        "error": row["error"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _upsert_pending(
    conn, annotation_id: str, kind: str, text: str
) -> None:
    now = _now()
    conn.execute(
        "INSERT INTO explanations "
        "(annotation_id, kind, text, content, status, error, "
        " created_at, updated_at) "
        "VALUES (?, ?, ?, NULL, 'pending', NULL, ?, ?) "
        "ON CONFLICT(annotation_id) DO UPDATE SET "
        "  kind=excluded.kind, text=excluded.text, content=NULL, "
        "  status='pending', error=NULL, updated_at=excluded.updated_at",
        (annotation_id, kind, text, now, now),
    )


def _finalize(
    conn,
    annotation_id: str,
    content: str | None,
    error: str | None,
) -> None:
    status = "error" if error else "complete"
    conn.execute(
        "UPDATE explanations SET content = ?, status = ?, error = ?, "
        "updated_at = ? WHERE annotation_id = ?",
        (content, status, error, _now(), annotation_id),
    )


def _verify_ownership(conn, doc_id: str, annotation_id: str) -> None:
    row = conn.execute(
        "SELECT 1 FROM annotations WHERE id = ? AND doc_id = ?",
        (annotation_id, doc_id),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="annotation not found")


@router.get("/explanation")
def get_explanation(
    doc_id: str,
    annotation_id: str,
    settings: Settings = Depends(get_settings),
) -> dict:
    with db.connect(settings.db_path) as conn:
        _verify_ownership(conn, doc_id, annotation_id)
        existing = _load_explanation(conn, annotation_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="no explanation yet")
    return existing


def _sse_event(data: dict) -> bytes:
    return f"data: {json.dumps(data)}\n\n".encode("utf-8")


async def _stream_claude(
    pdf_bytes: bytes,
    text: str,
    kind: ExplanationKind,
) -> AsyncIterator[tuple[str, str]]:
    """Yields (event_type, payload) tuples.

    event_type is one of:
      "delta"  -> payload is the new text chunk
      "done"   -> payload is the full accumulated text
      "error"  -> payload is the error message
    """
    if not os.environ.get("ANTHROPIC_API_KEY"):
        yield ("error", "ANTHROPIC_API_KEY not set on backend")
        return

    client = anthropic.AsyncAnthropic()
    model = MODEL_DEFINITION if kind == "definition" else MODEL_EXPLANATION
    system = SYSTEM_DEFINITION if kind == "definition" else SYSTEM_EXPLANATION
    instruction = (
        f"Highlighted term: {text!r}\n\nDefine it concisely in the context "
        "of this paper."
        if kind == "definition"
        else f"Highlighted passage:\n\n{text}\n\nExplain in clearer terms "
        "what the authors are saying."
    )

    pdf_b64 = base64.standard_b64encode(pdf_bytes).decode("ascii")

    accumulated: list[str] = []
    try:
        async with client.messages.stream(
            model=model,
            max_tokens=80 if kind == "definition" else 140,
            system=system,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "document",
                            "source": {
                                "type": "base64",
                                "media_type": "application/pdf",
                                "data": pdf_b64,
                            },
                            # Cache the (large) PDF prefix. Subsequent calls
                            # for the same document hit cache_read pricing.
                            "cache_control": {"type": "ephemeral"},
                        },
                        {"type": "text", "text": instruction},
                    ],
                }
            ],
        ) as stream:
            async for chunk in stream.text_stream:
                accumulated.append(chunk)
                yield ("delta", chunk)
        yield ("done", "".join(accumulated))
    except anthropic.APIError as e:
        log.exception("Anthropic API error")
        yield ("error", f"{type(e).__name__}: {e}")
    except Exception as e:  # noqa: BLE001
        log.exception("Unexpected error in Claude stream")
        yield ("error", f"{type(e).__name__}: {e}")


@router.post("/explain")
async def explain(
    doc_id: str,
    annotation_id: str,
    body: ExplainRequest,
    settings: Settings = Depends(get_settings),
) -> StreamingResponse:
    pdf_path = files.pdf_path(settings, doc_id)
    if not pdf_path.exists():
        raise HTTPException(status_code=404, detail="document not found")

    kind: ExplanationKind = body.kind or classify(body.text)

    # Validate the annotation exists under this doc, then record the pending
    # row. We hold the connection briefly; the streaming loop opens its own
    # connection on finalize.
    with db.connect(settings.db_path) as conn:
        _verify_ownership(conn, doc_id, annotation_id)

        cached = _load_explanation(conn, annotation_id)
        if (
            cached is not None
            and cached["status"] == "complete"
            and cached["text"] == body.text
            and cached["kind"] == kind
        ):
            # Serve cached content as a single SSE flush — same wire format
            # as a live stream so the client only needs one code path.
            content = cached["content"] or ""

            async def cached_stream() -> AsyncIterator[bytes]:
                yield _sse_event({"type": "meta", "kind": kind, "cached": True})
                yield _sse_event({"type": "delta", "text": content})
                yield _sse_event({"type": "done", "text": content})

            return StreamingResponse(
                cached_stream(), media_type="text/event-stream"
            )

        _upsert_pending(conn, annotation_id, kind, body.text)

    pdf_bytes = pdf_path.read_bytes()

    async def event_stream() -> AsyncIterator[bytes]:
        yield _sse_event({"type": "meta", "kind": kind, "cached": False})
        final_text: str | None = None
        error_text: str | None = None
        async for event_type, payload in _stream_claude(
            pdf_bytes, body.text, kind
        ):
            if event_type == "delta":
                yield _sse_event({"type": "delta", "text": payload})
            elif event_type == "done":
                final_text = payload
                yield _sse_event({"type": "done", "text": payload})
            elif event_type == "error":
                error_text = payload
                yield _sse_event({"type": "error", "message": payload})

        with db.connect(settings.db_path) as conn:
            _finalize(conn, annotation_id, final_text, error_text)

    return StreamingResponse(event_stream(), media_type="text/event-stream")
