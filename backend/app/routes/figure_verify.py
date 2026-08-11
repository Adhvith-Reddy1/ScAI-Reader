"""Vision-LLM verification pass over the heuristic figure detector.

`app.pdf.figures.detect_figures` finds figure regions from caption text and
page geometry alone — no pixels involved, so it can miss a figure whose
caption doesn't match the regex, or draw a box that's off. This module adds
an optional second pass: send the rendered page plus the heuristic's guesses
to whichever vision-capable model the reader already has configured (same
provider/key as figure explanations — see `app.ai`), and let it confirm,
correct, or supplement them.

This never runs unless a provider is configured, and any failure (no key,
provider error, a reply that isn't parseable JSON) falls back to the
heuristic's own result unchanged — it's a quality layer on top of the free
path, never a hard dependency of figure detection.
"""

from __future__ import annotations

import base64
import json
import logging
import re
from dataclasses import dataclass

from .. import ai, llm
from ..pdf.figures import MIN_FIGURE_DIMENSION_PT, FigureRegion, _figure_id
from ..pdf.pdfium_backend import sniff_image_mime
from ..pdf.types import BBox

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class VerificationOutcome:
    """What `verify_figures` actually did, for callers that want to surface
    it (the `/figures` route echoes this back so it's visible without
    digging through server logs — see routes/figures.py). `reason` is None
    exactly when `applied` is True."""

    regions: list[FigureRegion]
    applied: bool
    reason: str | None

# Rendering the whole page for verification, same DPI the figure-explain
# flow already renders at (see routes/stateless_ai.py) — no need for more
# detail than a vision model already gets for interpretation.
VERIFY_RENDER_DPI = 150

SYSTEM_FIGURE_VERIFY = (
    "You are checking a heuristic figure-detector's guesses against the "
    "actual rendered page of an academic paper. You are shown the full page "
    "image and a list of figure/table regions the heuristic already found, "
    "each with its label and bounding box as a fraction of the page's "
    "width/height ((0,0) is the top-left corner, (1,1) is the bottom-right "
    "corner). For each labeled region: if its box tightly and correctly "
    "encloses that figure or table's actual visual content — not the "
    "caption text, not surrounding body paragraphs — keep its coordinates "
    "unchanged; if the box is wrong (too wide, too narrow, shifted, or "
    "covers the wrong thing), correct it. Also add any figure or table the "
    "heuristic missed entirely, using the same 'Figure 2' / 'Table 1' style "
    "label visible in its caption. Do not invent sub-panels the heuristic "
    "didn't already split out unless a panel is clearly and separately "
    "labeled (a), (b), (c)... in the image. Reply with ONLY a JSON array, "
    'no prose, no markdown fences. Each element: {"label": string, "x0": '
    'number, "y0": number, "x1": number, "y1": number}, all four '
    "coordinates as fractions between 0 and 1."
)

_JSON_ARRAY_RE = re.compile(r"\[.*\]", re.DOTALL)


def _describe_heuristic(
    regions: list[FigureRegion], page_width_pt: float, page_height_pt: float
) -> str:
    if not regions:
        return (
            "The heuristic found no figures or tables on this page. If "
            "there genuinely are none, reply with an empty JSON array: []"
        )
    lines = [
        f"- {r.label}: x0={r.bbox.x0 / page_width_pt:.3f}, "
        f"y0={r.bbox.y0 / page_height_pt:.3f}, "
        f"x1={r.bbox.x1 / page_width_pt:.3f}, "
        f"y1={r.bbox.y1 / page_height_pt:.3f}"
        for r in regions
    ]
    return "The heuristic found:\n" + "\n".join(lines)


def _parse_verified_items(text: str) -> list[dict] | None:
    match = _JSON_ARRAY_RE.search(text)
    if not match:
        return None
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    if not isinstance(data, list):
        return None

    out: list[dict] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        label = item.get("label")
        if not isinstance(label, str) or not label.strip():
            continue
        try:
            coords = [float(item[k]) for k in ("x0", "y0", "x1", "y1")]
        except (KeyError, TypeError, ValueError):
            continue
        out.append({"label": label.strip(), "coords": coords})
    return out


def _region_from_verified(
    item: dict,
    page_index: int,
    page_width_pt: float,
    page_height_pt: float,
    fallback_caption_bbox: BBox | None,
) -> FigureRegion | None:
    x0f, y0f, x1f, y1f = item["coords"]
    x0 = max(0.0, min(1.0, min(x0f, x1f))) * page_width_pt
    y0 = max(0.0, min(1.0, min(y0f, y1f))) * page_height_pt
    x1 = max(0.0, min(1.0, max(x0f, x1f))) * page_width_pt
    y1 = max(0.0, min(1.0, max(y0f, y1f))) * page_height_pt
    bbox = BBox(x0=x0, y0=y0, x1=x1, y1=y1)
    if bbox.width < MIN_FIGURE_DIMENSION_PT or bbox.height < MIN_FIGURE_DIMENSION_PT:
        return None
    label = item["label"]
    return FigureRegion(
        figure_id=_figure_id(page_index, label),
        label=label,
        page_index=page_index,
        bbox=bbox,
        caption_bbox=fallback_caption_bbox or bbox,
    )


def _merge_verified(
    heuristic: list[FigureRegion],
    verified_items: list[dict],
    page_index: int,
    page_width_pt: float,
    page_height_pt: float,
) -> list[FigureRegion]:
    """Verified boxes win for labels the model addressed (confirm/correct);
    a heuristic label the model's reply didn't mention at all is kept as-is
    rather than dropped, so a partial or truncated reply can't silently lose
    a real hit — only ever adds coverage or fixes a box, never erases one."""
    by_label = {r.label: r for r in heuristic}
    merged: list[FigureRegion] = []
    used_labels: set[str] = set()
    for item in verified_items:
        existing = by_label.get(item["label"])
        region = _region_from_verified(
            item,
            page_index,
            page_width_pt,
            page_height_pt,
            fallback_caption_bbox=existing.caption_bbox if existing else None,
        )
        if region is None:
            continue
        merged.append(region)
        used_labels.add(item["label"])
    for r in heuristic:
        if r.label not in used_labels:
            merged.append(r)
    return merged


async def verify_figures(
    config: ai.ProviderConfig | None,
    heuristic: list[FigureRegion],
    page_png_bytes: bytes,
    page_index: int,
    page_width_pt: float,
    page_height_pt: float,
) -> VerificationOutcome:
    """Best-effort vision pass over `heuristic`'s regions. `regions` falls
    back to `heuristic` unchanged (with `applied=False` and a `reason`) if no
    provider is configured or the call/parse fails."""
    if config is None or not config.api_key:
        return VerificationOutcome(regions=heuristic, applied=False, reason="not_configured")

    media_type = sniff_image_mime(page_png_bytes)
    page_b64 = base64.standard_b64encode(page_png_bytes).decode("ascii")
    instruction = _describe_heuristic(heuristic, page_width_pt, page_height_pt)
    messages = [
        {
            "role": "user",
            "content": [
                llm.image_part(media_type, page_b64),
                llm.text_part(instruction),
            ],
        }
    ]

    text: str | None = None
    error: str | None = None
    async for event_type, payload in llm.stream_completion(
        config, system=SYSTEM_FIGURE_VERIFY, messages=messages, max_tokens=1200
    ):
        if event_type == "done":
            text = payload
        elif event_type == "error":
            error = payload
            log.warning("Figure verification call failed, using heuristic only: %s", payload)

    if not text:
        return VerificationOutcome(
            regions=heuristic, applied=False, reason=f"provider_error: {error}" if error else "empty_reply"
        )
    items = _parse_verified_items(text)
    if items is None:
        log.warning("Figure verification reply wasn't parseable JSON, using heuristic only")
        return VerificationOutcome(regions=heuristic, applied=False, reason="unparseable_reply")

    merged = _merge_verified(heuristic, items, page_index, page_width_pt, page_height_pt)
    log.info(
        "Figure verification applied: %d region(s) after merge (heuristic had %d)",
        len(merged),
        len(heuristic),
    )
    return VerificationOutcome(regions=merged, applied=True, reason=None)
