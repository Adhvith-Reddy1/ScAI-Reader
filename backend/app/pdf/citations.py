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

# A superscript citation marker is a whole run that is nothing but citation
# numbers — "24,25", "3", "10-12" — set in a smaller, raised font (Nature /
# Science / most biology journals). Matched against the entire (stripped) run.
_SUPERSCRIPT_BODY = re.compile(
    r"^\s*(\d+(?:\s*[,%s]\s*\d+)*)\s*$" % _DASHES
)

# A run is a superscript-citation candidate only if its font is at most this
# fraction of the page's dominant (body) font size. Citation superscripts run
# ~0.6–0.75x body; the cutoff leaves headroom without catching body digits.
_SUPERSCRIPT_FONT_RATIO = 0.80

# Reference-section headings, matched against a whole (stripped) run/line. We
# keep the set tight so a sentence mentioning "references" mid-paragraph isn't
# mistaken for the heading — a heading run is short and stands alone.
# Reference-section heading words. We match these against a run that either IS
# the heading on its own line, or — in dense reprints where text extraction
# glues the heading to the first entry ("References1. Smith, J...") — STARTS the
# reference list. The inline variant only counts as a heading when what follows
# the word is empty or begins with a digit (the first reference number), so a
# sentence like "References to prior work" isn't mistaken for the heading.
_REF_HEADING_WORDS = (
    r"(?:references(?:\s+and\s+notes)?|bibliography|"
    r"literature\s+cited|works\s+cited)"
)
_REF_HEADING = re.compile(
    r"^\s*(?:\d+\.?\s+|[IVX]+\.?\s+)?" + _REF_HEADING_WORDS + r"\s*$",
    re.IGNORECASE,
)
# No \b after the word: extraction often drops the space, gluing the heading
# straight onto the first entry ("References1. Smith..."). The digit gate below
# keeps prose like "References to prior work" from matching.
_REF_HEADING_INLINE = re.compile(
    r"^\s*(?:\d+\.?\s+|[IVX]+\.?\s+)?" + _REF_HEADING_WORDS + r"(?P<rest>.*)$",
    re.IGNORECASE | re.DOTALL,
)

# Upper bound on the text we hand the reference parser. The whole-document
# fallback (no heading found) can be large; 150k chars (~37k tokens) covers a
# long paper's worth of references in a single cached call.
_MAX_REFERENCES_CHARS = 150_000

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


def _dominant_font_size(runs: list[TextRun]) -> float:
    """The page's body font size: the size covering the most characters.

    Body prose dominates the character count, so the most-weighted size is the
    body text — the baseline we compare candidate superscripts against."""
    weights: dict[float, int] = {}
    for r in runs:
        n = len(r.text.strip())
        if n == 0:
            continue
        key = round(r.font_size, 1)
        weights[key] = weights.get(key, 0) + n
    if not weights:
        return 0.0
    return max(weights.items(), key=lambda kv: kv[1])[0]


def _is_raised_superscript(
    candidate: TextRun, runs: list[TextRun], body_fs: float
) -> bool:
    """True if `candidate` sits raised above the baseline of the body text on
    its line — i.e. it's a superscript, not a subscript (e.g. CO₂) or a stray
    small number. We find the nearest body-sized run sharing the line and check
    the candidate's bottom edge clears that run's baseline.

    If no body run shares the line, fall back to the font signal alone for very
    small runs (a strongly superscript-sized token with no neighbour to test).
    """
    c = candidate.bbox
    c_mid = (c.y0 + c.y1) / 2
    nearest: TextRun | None = None
    nearest_dx = float("inf")
    for r in runs:
        if r is candidate:
            continue
        if r.font_size < body_fs * 0.88:  # must be (roughly) body-sized
            continue
        # Same visual line: candidate's vertical midpoint falls within the body
        # run's vertical span (small pad for rounding).
        if not (r.bbox.y0 - 2 <= c_mid <= r.bbox.y1 + 2):
            continue
        dx = min(abs(c.x0 - r.bbox.x1), abs(r.bbox.x0 - c.x1))
        if dx < nearest_dx:
            nearest_dx = dx
            nearest = r

    if nearest is None:
        # No body neighbour to compare against — trust a strong font signal.
        return candidate.font_size <= body_fs * 0.70

    # Raised if the candidate's bottom clears the body baseline by a margin.
    return c.y1 <= nearest.bbox.y1 - 0.2 * body_fs


def detect_citations(page_text: PageText) -> list[CitationMarker]:
    """Find every numeric citation marker on a page — both bracketed (``[12]``)
    and superscript (Nature-style raised ``12``).

    Cost is a couple of regex checks per run plus, for the few pure-number runs,
    a small neighbour scan. Returns markers in reading order (columns, then runs
    within them)."""
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

    body_fs = _dominant_font_size(runs)

    for run in runs:
        # Pass 1: bracketed markers — there may be several within one run.
        matched_bracket = False
        for m in CITATION_PATTERN.finditer(run.text):
            numbers = _expand_numbers(m.group("body"))
            if not numbers:
                continue
            matched_bracket = True
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
        if matched_bracket:
            continue

        # Pass 2: superscript marker — the whole run is a raised number token in
        # a smaller-than-body font. The run's bbox IS the marker (no interp).
        sm = _SUPERSCRIPT_BODY.match(run.text)
        if (
            sm is not None
            and body_fs > 0
            and run.font_size <= body_fs * _SUPERSCRIPT_FONT_RATIO
        ):
            numbers = _expand_numbers(sm.group(1))
            if numbers and _is_raised_superscript(run, runs, body_fs):
                markers.append(
                    CitationMarker(
                        marker_id=f"p{page_text.page_index}_c{idx}",
                        page_index=page_text.page_index,
                        bbox=run.bbox,
                        numbers=numbers,
                        raw=run.text.strip(),
                    )
                )
                idx += 1
    return markers


def has_reference_heading(runs: list[TextRun]) -> bool:
    return any(_REF_HEADING.match(r.text) for r in runs)


def _flatten(pages: list[PageText]) -> list[TextRun]:
    flat: list[TextRun] = []
    for page in pages:
        if page.columns:
            for col in page.columns:
                flat.extend(col.runs)
        else:
            flat.extend(page.runs)
    return flat


def _find_reference_heading(flat: list[TextRun]) -> tuple[int, str] | None:
    """Locate the reference list's starting run.

    Returns (index, inline_remainder) for the LAST run that opens the reference
    list, or None. ``inline_remainder`` is any text that followed the heading
    word inside the same run (the first reference, when extraction glued them);
    empty when the heading sat on its own line.
    """
    best: tuple[int, str] | None = None
    for i, run in enumerate(flat):
        m = _REF_HEADING_INLINE.match(run.text)
        if not m:
            continue
        rest = m.group("rest").strip()
        # A real heading is followed by nothing, or by the first reference's
        # number — not by prose ("References to prior work...").
        if rest == "" or rest[:1].isdigit():
            best = (i, rest)
    return best


def extract_references_text(pages: list[PageText]) -> str:
    """Return text the LLM can parse the reference list from, or "" if the
    document has no extractable text at all.

    Strategy, most-precise first:
      1. Find the LAST reference heading (its own line, OR glued to the first
         entry as in dense reprints) and return everything from there on.
      2. If no heading is found, fall back to the WHOLE document text and let
         the LLM locate the reference list itself — far more robust than a
         heading regex against scrambled multi-column extraction.
    """
    flat = _flatten(pages)
    if not flat:
        return ""

    found = _find_reference_heading(flat)
    if found is not None:
        idx, inline_rest = found
        parts: list[str] = []
        if inline_rest:
            parts.append(inline_rest)
        parts.extend(r.text.strip() for r in flat[idx + 1 :] if r.text.strip())
        text = "\n".join(parts)
        if text.strip():
            return text[:_MAX_REFERENCES_CHARS]

    # No usable heading — hand over the whole document (capped) so the parser
    # can find the references wherever they sit.
    whole = "\n".join(r.text.strip() for r in flat if r.text.strip())
    return whole[-_MAX_REFERENCES_CHARS:]
