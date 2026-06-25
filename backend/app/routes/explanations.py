from __future__ import annotations

import base64
import json
import logging
from datetime import datetime, timezone
from typing import AsyncIterator, Literal

import anthropic
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .. import ai
from ..config import Settings
from ..pdf.pdfium_backend import PdfiumBackend
from ..storage import db, files
from .deps import get_settings

log = logging.getLogger(__name__)

router = APIRouter(
    prefix="/documents/{doc_id}/annotations/{annotation_id}",
    tags=["explanations"],
)

ExplanationKind = Literal["definition", "explanation"]

# Fast tiers for short tooltips: Haiku for definitions, Sonnet for the slightly
# more involved explanation/chat/refine work. (Was Sonnet/Opus.)
MODEL_DEFINITION = "claude-haiku-4-5"
MODEL_EXPLANATION = "claude-sonnet-4-6"

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

# When the short tooltip wasn't enough, the reader opens a chat thread to
# clarify. This assistant answers their follow-ups conversationally.
SYSTEM_CHAT = (
    "You are a tutor embedded in an academic PDF reader. A reader "
    "highlighted a term or passage and was shown a short tooltip, but it "
    "didn't fully resolve their doubt, so they're asking follow-up "
    "questions. Answer directly and concretely, grounding everything in "
    "the attached paper. Be concise — at most 3 sentences per reply — and "
    "address exactly what they asked. No preamble."
)

# After chatting, the reader hits "Update" and we ask the model to fold the
# parts of the conversation that helped them back into a tightened tooltip.
SYSTEM_REFINE_DEFINITION = (
    "You are rewriting a glossary definition shown in a PDF reader tooltip. "
    "You'll be given the highlighted term, the definition the reader first "
    "saw, and the clarifying conversation that followed. Infer which parts "
    "of the conversation were most useful to the reader and fold them into "
    "a single improved definition. Hard limit: 35 words, 1-2 sentences, no "
    "preamble. Output ONLY the revised definition text."
)

SYSTEM_REFINE_EXPLANATION = (
    "You are rewriting an explanation shown in a PDF reader tooltip. You'll "
    "be given the highlighted passage, the explanation the reader first saw, "
    "and the clarifying conversation that followed. Infer which parts of the "
    "conversation were most useful to the reader and fold them into a single "
    "improved explanation. Hard limit: 2 sentences, 45 words, no preamble. "
    "Output ONLY the revised explanation text."
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


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=8000)


class ChatRequest(BaseModel):
    """A follow-up chat turn. `messages` is the full thread the reader has
    had so far (after the initial tooltip), ending with their newest
    question; `text` and `content` carry the highlighted text and the
    tooltip the reader is currently looking at, for context."""

    text: str = Field(min_length=1, max_length=4000)
    kind: ExplanationKind
    content: str = Field(default="", max_length=8000)
    messages: list[ChatMessage] = Field(min_length=1)


class RefineRequest(BaseModel):
    """Fold the useful parts of the conversation back into the tooltip."""

    text: str = Field(min_length=1, max_length=4000)
    kind: ExplanationKind
    content: str = Field(default="", max_length=8000)
    messages: list[ChatMessage] = Field(min_length=1)


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


def _save_refined(
    conn, annotation_id: str, kind: str, text: str, content: str
) -> None:
    """Persist a rewritten tooltip as the canonical explanation so it shows
    up on the next hover and is inlined by GET /annotations."""
    now = _now()
    conn.execute(
        "INSERT INTO explanations "
        "(annotation_id, kind, text, content, status, error, "
        " created_at, updated_at) "
        "VALUES (?, ?, ?, ?, 'complete', NULL, ?, ?) "
        "ON CONFLICT(annotation_id) DO UPDATE SET "
        "  kind=excluded.kind, text=excluded.text, content=excluded.content, "
        "  status='complete', error=NULL, updated_at=excluded.updated_at",
        (annotation_id, kind, text, content, now, now),
    )


def _verify_ownership(conn, doc_id: str, annotation_id: str) -> int:
    """Confirm the annotation belongs to the document and return its 0-indexed
    page. Callers that only need the existence check can ignore the result."""
    row = conn.execute(
        "SELECT page_index FROM annotations WHERE id = ? AND doc_id = ?",
        (annotation_id, doc_id),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="annotation not found")
    return int(row["page_index"])


def _page_text(settings: Settings, doc_id: str, page_index: int) -> str:
    """Plain text of one page, in reading order. We send just this page as
    context for definitions/explanations instead of the whole PDF — it slashes
    prefill latency (a page is a few hundred tokens vs. the document's tens of
    thousands) while still grounding the model in what the reader is looking at.
    Returns "" if extraction fails; the model can still answer generally."""
    pdf_path = files.pdf_path(settings, doc_id)
    try:
        with PdfiumBackend.open(pdf_path) as backend:
            page = backend.get_page_text(page_index)
    except Exception:  # noqa: BLE001
        log.exception("page text extraction failed")
        return ""
    parts = [
        run.text.strip()
        for col in page.columns
        for run in col.runs
        if run.text.strip()
    ]
    return " ".join(parts)


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


def _error_sse(message: str) -> bytes:
    """Error frame, tagged with a code when AI simply isn't configured so the
    UI can offer one-click setup instead of showing a raw error."""
    frame: dict = {"type": "error", "message": message}
    if message == ai.AI_NOT_CONFIGURED_MESSAGE:
        frame["code"] = ai.AI_NOT_CONFIGURED_CODE
    return _sse_event(frame)


def _pdf_document_block(pdf_b64: str) -> dict:
    """An Anthropic `document` content block carrying the whole PDF. The
    cache_control marker lets follow-up calls for the same document hit
    cache_read pricing instead of re-uploading the prefix each time."""
    return {
        "type": "document",
        "source": {
            "type": "base64",
            "media_type": "application/pdf",
            "data": pdf_b64,
        },
        "cache_control": {"type": "ephemeral"},
    }


async def _stream_anthropic(
    model: str,
    system: str,
    messages: list[dict],
    max_tokens: int,
    api_key: str | None,
) -> AsyncIterator[tuple[str, str]]:
    """Yields (event_type, payload) tuples.

    event_type is one of:
      "delta"  -> payload is the new text chunk
      "done"   -> payload is the full accumulated text
      "error"  -> payload is the error message
    """
    if not api_key:
        yield ("error", ai.AI_NOT_CONFIGURED_MESSAGE)
        return

    client = anthropic.AsyncAnthropic(api_key=api_key)
    accumulated: list[str] = []
    try:
        async with client.messages.stream(
            model=model,
            max_tokens=max_tokens,
            system=system,
            messages=messages,
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


async def _stream_claude(
    page_text: str,
    text: str,
    kind: ExplanationKind,
    api_key: str | None,
) -> AsyncIterator[tuple[str, str]]:
    model = MODEL_DEFINITION if kind == "definition" else MODEL_EXPLANATION
    system = SYSTEM_DEFINITION if kind == "definition" else SYSTEM_EXPLANATION
    context = (
        f"For context, here is the text of the page the reader is on:\n\n"
        f"<page>\n{page_text}\n</page>\n\n"
        if page_text
        else ""
    )
    instruction = (
        context
        + (
            f"Highlighted term: {text!r}\n\nDefine it concisely in the context "
            "of this paper."
            if kind == "definition"
            else f"Highlighted passage:\n\n{text}\n\nExplain in clearer terms "
            "what the authors are saying."
        )
    )
    # Plain text only — no PDF document block — so there's no large prefill.
    messages = [{"role": "user", "content": instruction}]
    async for event in _stream_anthropic(
        model, system, messages, 80 if kind == "definition" else 140, api_key
    ):
        yield event


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

    # Validate the annotation exists under this doc, capture its page, then
    # record the pending row. We hold the connection briefly; the streaming
    # loop opens its own connection on finalize.
    with db.connect(settings.db_path) as conn:
        page_index = _verify_ownership(conn, doc_id, annotation_id)

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

    # Only the highlighted page's text is sent as context (not the whole PDF),
    # which is what keeps the first explanation fast.
    page_text = _page_text(settings, doc_id, page_index)
    api_key = ai.get_api_key(settings)

    async def event_stream() -> AsyncIterator[bytes]:
        yield _sse_event({"type": "meta", "kind": kind, "cached": False})
        final_text: str | None = None
        error_text: str | None = None
        async for event_type, payload in _stream_claude(
            page_text, body.text, kind, api_key
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
            _finalize(conn, annotation_id, final_text, error_text)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


def _build_chat_messages(pdf_b64: str, body: ChatRequest) -> list[dict]:
    """Turn the reader's thread into Anthropic messages. The PDF and the
    tooltip context ride along on the first user turn so the whole document
    is available (and cached) for the conversation."""
    context = (
        f"The reader highlighted this text from the attached paper:\n\n"
        f"{body.text!r}\n\nThey were shown this {body.kind}:\n\n"
        f"{body.content}\n\nThey have follow-up questions below."
    )
    out: list[dict] = []
    for i, m in enumerate(body.messages):
        if i == 0 and m.role == "user":
            out.append(
                {
                    "role": "user",
                    "content": [
                        _pdf_document_block(pdf_b64),
                        {"type": "text", "text": f"{context}\n\n{m.content}"},
                    ],
                }
            )
        else:
            out.append({"role": m.role, "content": m.content})
    # Anthropic requires the conversation to open on a user turn.
    if not out or out[0]["role"] != "user":
        out.insert(
            0,
            {
                "role": "user",
                "content": [
                    _pdf_document_block(pdf_b64),
                    {"type": "text", "text": context},
                ],
            },
        )
    return out


@router.post("/chat")
async def chat(
    doc_id: str,
    annotation_id: str,
    body: ChatRequest,
    settings: Settings = Depends(get_settings),
) -> StreamingResponse:
    pdf_path = files.pdf_path(settings, doc_id)
    if not pdf_path.exists():
        raise HTTPException(status_code=404, detail="document not found")

    with db.connect(settings.db_path) as conn:
        _verify_ownership(conn, doc_id, annotation_id)

    pdf_b64 = base64.standard_b64encode(pdf_path.read_bytes()).decode("ascii")
    messages = _build_chat_messages(pdf_b64, body)
    api_key = ai.get_api_key(settings)

    async def event_stream() -> AsyncIterator[bytes]:
        yield _sse_event({"type": "meta", "kind": body.kind, "cached": False})
        async for event_type, payload in _stream_anthropic(
            MODEL_EXPLANATION, SYSTEM_CHAT, messages, 400, api_key
        ):
            if event_type == "delta":
                yield _sse_event({"type": "delta", "text": payload})
            elif event_type == "done":
                yield _sse_event({"type": "done", "text": payload})
            elif event_type == "error":
                yield _error_sse(payload)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/refine")
async def refine(
    doc_id: str,
    annotation_id: str,
    body: RefineRequest,
    settings: Settings = Depends(get_settings),
) -> StreamingResponse:
    pdf_path = files.pdf_path(settings, doc_id)
    if not pdf_path.exists():
        raise HTTPException(status_code=404, detail="document not found")

    with db.connect(settings.db_path) as conn:
        _verify_ownership(conn, doc_id, annotation_id)

    kind = body.kind
    model = MODEL_DEFINITION if kind == "definition" else MODEL_EXPLANATION
    system = (
        SYSTEM_REFINE_DEFINITION
        if kind == "definition"
        else SYSTEM_REFINE_EXPLANATION
    )
    transcript = "\n".join(
        f"{m.role.upper()}: {m.content}" for m in body.messages
    )
    instruction = (
        f"Original highlighted text:\n{body.text!r}\n\n"
        f"The {kind} the reader first saw:\n{body.content}\n\n"
        f"Clarifying conversation:\n{transcript}\n\n"
        f"Rewrite the {kind} so it folds in what helped the reader most. "
        "Output only the revised text."
    )
    pdf_b64 = base64.standard_b64encode(pdf_path.read_bytes()).decode("ascii")
    messages = [
        {
            "role": "user",
            "content": [
                _pdf_document_block(pdf_b64),
                {"type": "text", "text": instruction},
            ],
        }
    ]
    api_key = ai.get_api_key(settings)

    async def event_stream() -> AsyncIterator[bytes]:
        yield _sse_event(
            {"type": "meta", "kind": kind, "cached": False, "refined": True}
        )
        final_text: str | None = None
        error_text: str | None = None
        async for event_type, payload in _stream_anthropic(
            model,
            system,
            messages,
            80 if kind == "definition" else 140,
            api_key,
        ):
            if event_type == "delta":
                yield _sse_event({"type": "delta", "text": payload})
            elif event_type == "done":
                final_text = payload
                yield _sse_event({"type": "done", "text": payload})
            elif event_type == "error":
                error_text = payload
                yield _error_sse(payload)

        # Only overwrite the stored tooltip on a clean rewrite — a failed
        # refine must not wipe the explanation the reader already had.
        if final_text is not None and error_text is None:
            with db.connect(settings.db_path) as conn:
                _save_refined(
                    conn, annotation_id, kind, body.text, final_text.strip()
                )

    return StreamingResponse(event_stream(), media_type="text/event-stream")
