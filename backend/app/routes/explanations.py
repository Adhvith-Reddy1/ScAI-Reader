"""Shared AI prompt text and SSE/stream helpers for highlight explanations.

After the browser-storage migration (Spec 03/07) the server no longer persists
highlights or explanations, so this module owns no routes. It exists purely as
the single home for the explanation prompts and the streaming/SSE helpers that
the stateless AI endpoints (``stateless_ai.py``) reuse, keeping prompts in one
place (Shared Contract B in docs/specs/README.md).
"""

from __future__ import annotations

import json
import logging
from typing import AsyncIterator, Literal

from pydantic import BaseModel, Field

from .. import ai, llm
from ..config import Settings
from ..pdf.pdfium_backend import PdfiumBackend
from ..storage import files

log = logging.getLogger(__name__)

ExplanationKind = Literal["definition", "explanation"]

# Model choice is provider-specific and lives in app.ai (DEFAULT_MODELS); the
# routes only pick a quality tier ("fast" for definitions, "good" otherwise).

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


def _sse_event(data: dict) -> bytes:
    return f"data: {json.dumps(data)}\n\n".encode("utf-8")


def _error_sse(message: str) -> bytes:
    """Error frame, tagged with a code when AI simply isn't configured so the
    UI can offer one-click setup instead of showing a raw error."""
    frame: dict = {"type": "error", "message": message}
    code = ai.error_code(message)
    if code:
        frame["code"] = code
    return _sse_event(frame)


def _page_context(page_text: str) -> str:
    return (
        f"For context, here is the text of the page the reader is on:\n\n"
        f"<page>\n{page_text}\n</page>\n\n"
        if page_text
        else ""
    )


async def _stream_explanation(
    config,
    page_text: str,
    text: str,
    kind: ExplanationKind,
) -> AsyncIterator[tuple[str, str]]:
    system = SYSTEM_DEFINITION if kind == "definition" else SYSTEM_EXPLANATION
    instruction = _page_context(page_text) + (
        f"Highlighted term: {text!r}\n\nDefine it concisely in the context "
        "of this paper."
        if kind == "definition"
        else f"Highlighted passage:\n\n{text}\n\nExplain in clearer terms "
        "what the authors are saying."
    )
    async for event in llm.stream_completion(
        config,
        system=system,
        messages=[llm.user_text(instruction)],
        max_tokens=80 if kind == "definition" else 140,
        tier="fast" if kind == "definition" else "good",
    ):
        yield event


def _build_chat_messages(page_text: str, body: ChatRequest) -> list[dict]:
    """Turn the reader's thread into provider-neutral messages. The page text
    and tooltip context ride along on the first user turn so the model knows
    what's being discussed."""
    context = (
        _page_context(page_text)
        + f"The reader highlighted this text:\n\n{body.text!r}\n\n"
        f"They were shown this {body.kind}:\n\n{body.content}\n\n"
        "They have follow-up questions below."
    )
    out: list[dict] = []
    for i, m in enumerate(body.messages):
        if i == 0 and m.role == "user":
            out.append(
                {"role": "user", "content": f"{context}\n\n{m.content}"}
            )
        else:
            out.append({"role": m.role, "content": m.content})
    # Conversations must open on a user turn.
    if not out or out[0]["role"] != "user":
        out.insert(0, {"role": "user", "content": context})
    return out


def _stream_chat(config, page_text: str, body) -> AsyncIterator[tuple[str, str]]:
    """Stream a chat reply. `body` need only expose `text`, `kind`, `content`
    and `messages`, so the stateless endpoint can reuse this with its own
    request model."""
    messages = _build_chat_messages(page_text, body)
    return llm.stream_completion(
        config, system=SYSTEM_CHAT, messages=messages, max_tokens=400
    )


def _stream_refine(
    config,
    page_text: str,
    text: str,
    kind: ExplanationKind,
    content: str,
    messages: list,
) -> AsyncIterator[tuple[str, str]]:
    """Stream a tooltip rewrite. Shared by the stateless refine endpoint, which
    just doesn't persist the result."""
    system = (
        SYSTEM_REFINE_DEFINITION
        if kind == "definition"
        else SYSTEM_REFINE_EXPLANATION
    )
    transcript = "\n".join(f"{m.role.upper()}: {m.content}" for m in messages)
    instruction = (
        _page_context(page_text)
        + f"Original highlighted text:\n{text!r}\n\n"
        f"The {kind} the reader first saw:\n{content}\n\n"
        f"Clarifying conversation:\n{transcript}\n\n"
        f"Rewrite the {kind} so it folds in what helped the reader most. "
        "Output only the revised text."
    )
    return llm.stream_completion(
        config,
        system=system,
        messages=[llm.user_text(instruction)],
        max_tokens=80 if kind == "definition" else 140,
        tier="fast" if kind == "definition" else "good",
    )
