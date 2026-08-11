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
import io
import json
import logging
from typing import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException
from PIL import Image
from pydantic import BaseModel, Field

from .. import ai, llm
from ..config import Settings
from ..pdf.backend import PdfError
from ..pdf.figures import AdjacentPage, FigureRegion, detect_figures
from ..pdf.pdfium_backend import PdfiumBackend, sniff_image_mime
from ..storage import files
from .deps import get_settings
from .explanations import ChatMessage

log = logging.getLogger(__name__)

router = APIRouter(prefix="/documents/{doc_id}", tags=["figures"])

# Figure explanations need a vision-capable model; the provider's "good" tier
# default (see app.ai.DEFAULT_MODELS) is used unless the user overrides it.

SYSTEM_FIGURE = (
    "You are an in-page assistant inside an academic PDF reader. The user "
    "double-clicked a figure, and its caption is already visible to them on "
    "the page — never restate or paraphrase it; assume it's already read. "
    "Your job is interpretation, not description: don't just name what's "
    "visually obvious at a glance — which bar is tallest, which line trends "
    "up, which value is largest. The reader can already see that. Say why "
    "that pattern matters: what it implies, what it rules out, or what "
    "would be unclear or surprising without it. Always structure your "
    "answer as exactly these two short '- ' bullet lines, in this order, "
    "regardless of the figure's content or how many panels it has:\n"
    "- **Claim:** the conclusion or argument the authors are using this "
    "figure to support\n"
    "- **Evidence:** the specific pattern in the data — comparison, trend, "
    "gap, or outlier — that's the evidence for it, stated so it explains "
    "WHY that pattern supports the claim, not just which pattern exists\n"
    "One sentence per bullet. Hard limit: 90 words total, no preamble. The "
    "reader wants the 'so what', not a summary of what's already on the "
    "page."
)

# When the short interpretation wasn't enough, the reader opens a follow-up
# thread. This assistant answers conversationally, with the figure still
# attached so it can point at specific panels/axes/data points.
SYSTEM_FIGURE_CHAT = (
    "You are answering a follow-up question about a figure in an academic "
    "paper, inside a PDF reader. The reader already saw a short "
    "interpretation of the figure but it didn't fully resolve their "
    "question, so they're asking more. The figure image is attached — refer "
    "to specific panels, axes, or data points when it helps answer. Answer "
    "directly and concretely, grounded in what's actually shown. If the "
    "answer naturally breaks into multiple distinct parts (e.g. one point "
    "per panel, or a short list of reasons), use short '- ' bullet lines "
    "instead of one dense paragraph; a simple answer can just be a "
    "sentence or two of plain prose. Be concise — at most 3 sentences' "
    "worth of content per reply — and address exactly what they asked. No "
    "preamble."
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
            graphics = backend.get_page_graphics(page_number - 1)

            prev_page = None
            if page_number - 2 >= 0:
                prev_index = page_number - 2
                prev_page = AdjacentPage(
                    text=backend.get_page_text(prev_index),
                    graphics=backend.get_page_graphics(prev_index),
                )
    except PdfError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    # The previous page lets a figure whose caption and image were placed
    # on different pages resolve correctly -- a layout Nature-family
    # journals use for full-page data figures (see
    # app.pdf.figures.AdjacentPage).
    regions = detect_figures(
        page, dims.width_pt, dims.height_pt, graphics, prev_page=prev_page
    )

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


class BBoxModel(BaseModel):
    x0: float
    y0: float
    x1: float
    y1: float


class FigureExplainRequest(BaseModel):
    page: int = Field(ge=1)
    label: str = Field(min_length=1, max_length=64)
    # Optional: the panel/figure's own bbox in page-space points (top-left
    # origin), same convention as `_region_to_dict`. When present, the vision
    # payload is cropped to it — see `crop_to_bbox` — so a click on one panel
    # of a multi-panel figure explains that panel, not the whole grid.
    bbox: BBoxModel | None = None


# Padding around a requested bbox, in page-space points, so the crop keeps a
# little surrounding context (axis labels, the panel's own letter tag) rather
# than cutting exactly on the detected content edge.
_CROP_PAD_PT = 20.0


def crop_to_bbox(
    page_png_bytes: bytes,
    bbox: BBoxModel,
    page_width_pt: float,
    page_height_pt: float,
    dpi: int,
) -> bytes:
    """Crop a rendered page image down to `bbox` (plus a small padding
    margin), re-encoding in whatever format the page was rendered in.
    Falls back to returning `page_png_bytes` unchanged if the bbox doesn't
    resolve to a sane crop region (e.g. degenerate/out-of-range input) —
    an unfocused-but-correct image beats a request failure."""
    scale = dpi / 72.0
    x0 = max(0.0, min(bbox.x0, bbox.x1) - _CROP_PAD_PT)
    y0 = max(0.0, min(bbox.y0, bbox.y1) - _CROP_PAD_PT)
    x1 = min(page_width_pt, max(bbox.x0, bbox.x1) + _CROP_PAD_PT)
    y1 = min(page_height_pt, max(bbox.y0, bbox.y1) + _CROP_PAD_PT)
    if x1 <= x0 or y1 <= y0:
        return page_png_bytes

    media_type = sniff_image_mime(page_png_bytes)
    image = Image.open(io.BytesIO(page_png_bytes))
    px0, py0 = int(x0 * scale), int(y0 * scale)
    px1 = max(px0 + 1, min(image.width, round(x1 * scale)))
    py1 = max(py0 + 1, min(image.height, round(y1 * scale)))
    cropped = image.crop((px0, py0, px1, py1))

    buf = io.BytesIO()
    if media_type == "image/jpeg":
        cropped.convert("RGB").save(buf, format="JPEG", quality=85, optimize=False)
    else:
        cropped.save(buf, format="PNG", optimize=False, compress_level=6)
    return buf.getvalue()


def _stream_figure(
    config,
    page_text: str,
    page_png_bytes: bytes,
    label: str,
    page_number: int,
    cropped: bool = False,
) -> AsyncIterator[tuple[str, str]]:
    page_b64 = base64.standard_b64encode(page_png_bytes).decode("ascii")
    # render_page's encoding is content-dependent (JPEG for pages with a
    # raster image — the common case here, since this IS the figure — PNG
    # otherwise); the vision payload's declared media type must match.
    media_type = sniff_image_mime(page_png_bytes)
    context = (
        f"For context, here is the text of page {page_number}:\n\n"
        f"<page>\n{page_text}\n</page>\n\n"
        if page_text
        else ""
    )
    if cropped:
        image_note = (
            "The attached image is cropped to just this figure/panel — no "
            "need to locate it on the page."
        )
    else:
        image_note = (
            "The full page image is attached to disambiguate which figure I "
            "mean."
        )
    instruction = (
        context
        + f"Focus on {label} (page {page_number}). {image_note} Interpret "
        "it for a reader who's mid-paragraph and wants to keep reading the "
        "paper: what is it evidence for, not what it depicts."
    )
    messages = [
        {
            "role": "user",
            "content": [
                llm.image_part(media_type, page_b64),
                llm.text_part(instruction),
            ],
        }
    ]
    return llm.stream_completion(
        config, system=SYSTEM_FIGURE, messages=messages, max_tokens=260
    )


class FigureChatRequest(BaseModel):
    """A follow-up chat turn on a figure. `messages` is the full thread the
    reader has had so far, ending with their newest question; `content` is
    the interpretation they were first shown, for context."""

    page: int = Field(ge=1)
    label: str = Field(min_length=1, max_length=64)
    bbox: BBoxModel | None = None
    content: str = Field(default="", max_length=8000)
    messages: list[ChatMessage] = Field(min_length=1)


def _build_figure_chat_messages(
    page_text: str,
    label: str,
    page_number: int,
    content: str,
    image_part_value: dict,
    messages: list[ChatMessage],
) -> list[dict]:
    """Turn the reader's follow-up thread into provider-neutral messages.
    The figure image and page/interpretation context ride along on the
    first user turn, mirroring `explanations._build_chat_messages` — later
    turns don't need the image re-attached since it's already in context."""
    context_text = (
        (
            f"For context, here is the text of page {page_number}:\n\n"
            f"<page>\n{page_text}\n</page>\n\n"
            if page_text
            else ""
        )
        + f"The reader double-clicked {label}. They were shown this "
        f"interpretation:\n\n{content}\n\n"
        "They have follow-up questions below."
    )
    out: list[dict] = []
    for i, m in enumerate(messages):
        if i == 0 and m.role == "user":
            out.append(
                {
                    "role": "user",
                    "content": [
                        image_part_value,
                        llm.text_part(f"{context_text}\n\n{m.content}"),
                    ],
                }
            )
        else:
            out.append({"role": m.role, "content": m.content})
    # Conversations must open on a user turn.
    if not out or out[0]["role"] != "user":
        out.insert(
            0,
            {
                "role": "user",
                "content": [image_part_value, llm.text_part(context_text)],
            },
        )
    return out


def _stream_figure_chat(
    config,
    page_text: str,
    page_png_bytes: bytes,
    label: str,
    page_number: int,
    content: str,
    messages: list[ChatMessage],
) -> AsyncIterator[tuple[str, str]]:
    page_b64 = base64.standard_b64encode(page_png_bytes).decode("ascii")
    media_type = sniff_image_mime(page_png_bytes)
    img_part = llm.image_part(media_type, page_b64)
    built = _build_figure_chat_messages(
        page_text, label, page_number, content, img_part, messages
    )
    return llm.stream_completion(
        config, system=SYSTEM_FIGURE_CHAT, messages=built, max_tokens=400
    )
