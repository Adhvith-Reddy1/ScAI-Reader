"""Number-based in-text citation detection and reference-section extraction.

Two independent jobs live here, both pure functions over the text layer:

1. ``detect_citations`` — find in-text citation markers like ``[12]`` or
   ``[3, 5–7]`` on a page and return a clickable region per marker, tagged
   with the reference numbers it points to. We deliberately DON'T rely on PDF
   link annotations: many papers ship without them, so the only universal
   signal is the bracketed number itself.

2. ``extract_references_text`` — locate the "References"/"Bibliography" heading
   in a document's flattened text and return everything after it. That blob is
   handed to an LLM elsewhere to parse into ``{number, authors, title}`` rows;
   matching a marker to a reference is then a plain integer lookup, which works
   whether or not the PDF carried hyperlinks.

Coordinates are page-space points (origin top-left), the same convention the
text and figure layers use, so the frontend scales them with the transform it
already has.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .types import BBox, PageText, TextRun

# Every dash-like character we treat as a range separator: hyphen-minus, the
# Unicode hyphen/dash block (U+2010–U+2015), and the minus sign (U+2212). Kept
# as a string so both regexes below share one definition.
_DASHES = "‐‑‒–—―−-"

# A bracketed numeric citation: one or more numbers, separated by commas and/or
# dashes (for ranges). We require the bracket to contain ONLY numbers and
# separators so we don't match "[i]", "[Smith 2020]", or "[CLS]". Examples
# matched: [1]  [12]  [3, 5]  [3,5,8]  [4-6]  [4–6]  [1, 3–5]
CITATION_PATTERN = re.compile(
    r"\[\s*"
    r"(?P<body>\d+(?:\s*[,%s]\s*\d+)*)"
    r"\s*\]" % _DASHES
)

# Inside the brackets, split the body into individual numbers / ranges.
_RANGE_SEP = re.compile(r"[%s]" % _DASHES)
_NUM = re.compile(r"\d+")

# Reference-section headings, matched against a whole (stripped) run/line. We
# keep the set tight so a sentence mentioning "references" mid-paragraph isn't
# mistaken for the heading — a heading run is short and stands alone.
_REF_HEADING = re.compile(
    r"^\s*(?:\d+\.?\s+|[IVX]+\.?\s+)?"        # optional section number
    r"(references|bibliography|references\s+and\s+notes|"
    r"literature\s+cited|works\s+cited)"
    r"\s*$",
    re.IGNORECASE,
)

# Guardrail: a real citation marker is a short token. Reject brackets enclosing
# absurdly long digit strings (e.g. a matrix row) that aren't citations.
_MAX_MARKER_NUMBERS = 40
_MAX_REFERENCE_NUMBER = 999


@dataclass(frozen=True)
class CitationMarker:
    """One clickable in-text citation marker.

    ``numbers`` is the list of reference numbers the marker resolves to, in the
    order they appear ("[3, 5]" -> (3, 5); "[4-6]" -> (4, 5, 6)).
    """

    marker_id: str
    page_index: int        # 0-indexed
    bbox: BBox             # page-space points, top-left origin
    numbers: tuple[int, ...]
    raw: str               # the literal bracket text, e.g. "[3, 5]"


def _expand_numbers(body: str) -> tuple[int, ...]:
    """Turn the inside of a citation bracket into the reference numbers it
    denotes, expanding ranges. Returns () if anything looks unreasonable."""
    out: list[int] = []
    # Split on commas first; each piece is either a single number or a range.
    for piece in body.split(","):
        piece = piece.strip()
        if not piece:
            continue
        nums = _NUM.findall(piece)
        if not nums:
            continue
        if _RANGE_SEP.search(piece) and len(nums) == 2:
            lo, hi = int(nums[0]), int(nums[1])
            if lo <= hi and hi - lo < 100:
                out.extend(range(lo, hi + 1))
            else:
                # Not a sane range — treat the endpoints as discrete refs.
                out.extend(int(n) for n in nums)
        else:
            out.extend(int(n) for n in nums)

    # Sanity filters: drop anything out of a plausible citation range.
    cleaned = [n for n in out if 1 <= n <= _MAX_REFERENCE_NUMBER]
    if not cleaned or len(cleaned) > _MAX_MARKER_NUMBERS:
        return ()
    # De-dup while preserving order.
    seen: set[int] = set()
    deduped = [n for n in cleaned if not (n in seen or seen.add(n))]
    return tuple(deduped)


def _sub_bbox(run: TextRun, start: int, end: int) -> BBox:
    """Approximate the page-space box of run.text[start:end].

    We don't have per-glyph metrics here, so we interpolate horizontally across
    the run by character fraction. Citation markers are short, so even with
    proportional fonts the resulting hotspot lands on (or adjacent to) the
    bracket — accurate enough for a click target.
    """
    text = run.text
    n = max(1, len(text))
    width = run.bbox.width
    x0 = run.bbox.x0 + (start / n) * width
    x1 = run.bbox.x0 + (end / n) * width
    return BBox(x0=x0, y0=run.bbox.y0, x1=x1, y1=run.bbox.y1)


def detect_citations(page_text: PageText) -> list[CitationMarker]:
    """Find every bracketed numeric citation marker on a page.

    Cost is one regex scan per text run; most runs contain no brackets. Returns
    markers in reading order (columns, then runs within them)."""
    markers: list[CitationMarker] = []
    idx = 0
    # Walk runs in reading order: column by column. Fall back to raw runs if a
    # page came through without column clustering.
    runs: list[TextRun] = []
    if page_text.columns:
        for col in page_text.columns:
            runs.extend(col.runs)
    else:
        runs.extend(page_text.runs)

    for run in runs:
        for m in CITATION_PATTERN.finditer(run.text):
            numbers = _expand_numbers(m.group("body"))
            if not numbers:
                continue
            bbox = _sub_bbox(run, m.start(), m.end())
            markers.append(
                CitationMarker(
                    marker_id=f"p{page_text.page_index}_c{idx}",
                    page_index=page_text.page_index,
                    bbox=bbox,
                    numbers=numbers,
                    raw=m.group(0),
                )
            )
            idx += 1
    return markers


def has_reference_heading(runs: list[TextRun]) -> bool:
    return any(_REF_HEADING.match(r.text) for r in runs)


def extract_references_text(pages: list[PageText]) -> str:
    """Return the raw text of the document's reference list, or "" if absent.

    We flatten every page's runs into reading order, find the LAST run that is
    on its own a "References"/"Bibliography" heading (the list lives near the
    end, and the word can appear earlier in prose), and concatenate everything
    after it. The downstream LLM parser tolerates the messy line wrapping.
    """
    flat: list[TextRun] = []
    for page in pages:
        if page.columns:
            for col in page.columns:
                flat.extend(col.runs)
        else:
            flat.extend(page.runs)

    heading_idx: int | None = None
    for i, run in enumerate(flat):
        if _REF_HEADING.match(run.text):
            heading_idx = i  # keep the last match

    if heading_idx is None:
        return ""

    after = flat[heading_idx + 1 :]
    return "\n".join(r.text.strip() for r in after if r.text.strip())
