"""Figure region detection on rendered PDF pages.

We don't get figure boundaries from the PDF directly. The reliable signal we
DO have is the caption: papers virtually always label figures and tables with
a predictable prefix ("Figure 2:", "Fig. 2.", "Table 1"). Once we know where
the caption sits, the figure is the text-free region immediately above it
within the same column — this locates the figure's approximate vertical
extent and gives a starting horizontal bound (the column's width), since
there's no text inside a figure to bound it more precisely by.

Text alone can't say how wide or tall the actual figure content is, though —
only that some whitespace sits there. When available, `graphics` (the page's
real image/vector-object bounding boxes, from `PdfBackend.get_page_graphics`)
tightens the box to what's actually drawn instead of the whole column width.

This module is the only thing in the backend that takes a page-rendering
"Figure" position — everything downstream addresses it by `figure_id`.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .types import BBox, PageText, TextColumn, TextRun

# Match the start of a caption line. Stops at the first non-prefix token so
# regex doesn't tax the whole text — labels are always at the very start.
# The optional "Extended Data" prefix covers Nature-family journals' separate
# numbering for supplementary figures/tables (e.g. "Extended Data Fig. 1 |").
CAPTION_PATTERN = re.compile(
    r"""^\s*
    (?P<prefix>Extended\s+Data\s+)?   # Nature-style supplementary prefix
    (?P<kind>Figure|Fig\.?|Table)    # caption kind
    \s*
    (?P<num>\d+[A-Za-z]?)             # number, optional sub-letter (1, 2a)
    (?!\s*[)\]\}])                    # not "...(see Fig. 2), ..." — an
                                       # in-line citation, not a caption
    """,
    re.VERBOSE | re.IGNORECASE,
)

# A "gap" is the vertical whitespace separating the figure from text above.
# Lines in a paragraph are typically <2pt apart; a figure starts where the
# spacing balloons. 18pt is a conservative threshold that handles most
# layouts without merging adjacent prose paragraphs into the figure.
MIN_FIGURE_GAP_PT = 18.0

# How far below a graphics object's bottom edge a text run can sit and still
# count as part of the figure itself — a panel tag ("(a)", "(b)"), axis
# label, or legend entry — rather than the body prose that marks where the
# figure actually ends. Real scientific figures routinely embed such text
# well inside a typical paragraph-line gap, which would otherwise make
# _figure_bbox_above_caption see a suspiciously small gap and reject a real
# figure outright.
FIGURE_LABEL_MAX_GAP_PT = 40.0

# A real figure is never a hairline. Below this in either dimension, the
# detected region is almost certainly a false positive — e.g. a caption-like
# run that's actually a mid-sentence citation fragment or a caption split
# across runs by a style change, landing the "gap" on unrelated nearby ink
# instead of an actual figure.
MIN_FIGURE_DIMENSION_PT = 20.0

# Captions wider than ~70% of the page span across columns — treat them as
# a wide figure rather than constrained to one column.
WIDE_CAPTION_FRACTION = 0.70


@dataclass(frozen=True)
class FigureRegion:
    """A clickable region the user can double-click to ask the AI about.

    `figure_id` is a stable, URL-safe identifier composed from page + label;
    we use it as the primary key in the figure_explanations table.
    """

    figure_id: str
    label: str            # "Figure 2", "Table 1", "Fig. 3a"
    page_index: int       # 0-indexed
    bbox: BBox            # in page-space points, top-left origin
    caption_bbox: BBox    # where the caption text actually sits


def _normalize_label(prefix: str | None, kind: str, num: str) -> str:
    kind = kind.rstrip(".")
    if kind.lower() in ("fig", "figure"):
        kind = "Figure"
    elif kind.lower() == "table":
        kind = "Table"
    label = f"{kind} {num}"
    if prefix:
        label = f"Extended Data {label}"
    return label


def _figure_id(page_index: int, label: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9]+", "_", label).strip("_")
    return f"p{page_index}_{safe}"


def _find_caption_runs(
    runs: tuple[TextRun, ...],
) -> list[tuple[TextRun, str]]:
    """Return (run, label) pairs where `run` starts a caption line."""
    out: list[tuple[TextRun, str]] = []
    for run in runs:
        # Only check runs that *look* like the start of a line — the first
        # token after any leading whitespace must be a caption keyword.
        m = CAPTION_PATTERN.match(run.text)
        if not m:
            continue
        label = _normalize_label(m.group("prefix"), m.group("kind"), m.group("num"))
        out.append((run, label))
    return out


def _column_for_caption(
    caption: TextRun, columns: tuple[TextColumn, ...], page_width_pt: float
) -> TextColumn | None:
    """Pick the column the caption belongs to, or None if the caption is wide."""
    if caption.bbox.width >= page_width_pt * WIDE_CAPTION_FRACTION:
        return None
    cx = (caption.bbox.x0 + caption.bbox.x1) / 2
    for col in columns:
        if col.bbox.x0 <= cx <= col.bbox.x1:
            return col
    return None


def _is_figure_internal_text(run: TextRun, graphics: tuple[BBox, ...]) -> bool:
    """True if `run` sits just beneath a graphic it horizontally overlaps —
    plausibly a panel tag ("(a)", "(b)") or axis label that's part of the
    figure's own drawn content, rather than body prose.

    Real figures routinely embed such text well inside a typical
    paragraph-line gap below their own artwork. Without this check, that
    text is the closest thing above the caption, the measured gap comes out
    well under MIN_FIGURE_GAP_PT, and a real figure gets silently rejected as
    "not a figure".
    """
    for g in graphics:
        if run.bbox.x1 <= g.x0 or run.bbox.x0 >= g.x1:
            continue  # no horizontal overlap with this graphic
        if g.y1 <= run.bbox.y0 <= g.y1 + FIGURE_LABEL_MAX_GAP_PT:
            return True
    return False


def _figure_bbox_above_caption(
    caption: TextRun,
    column: TextColumn | None,
    page_width_pt: float,
    page_height_pt: float,
    graphics: tuple[BBox, ...] = (),
) -> BBox | None:
    """Find the rectangular text-free region above the caption.

    Walks upward through runs in the constraining region (column or full-width
    band), takes the *first* run whose bottom edge sits ABOVE the caption, and
    if the gap exceeds MIN_FIGURE_GAP_PT treats that as the figure's top edge.
    If no run is above (caption is at the top of the page), use page top.
    """
    if column is not None:
        x0, x1 = column.bbox.x0, column.bbox.x1
        candidate_runs = column.runs
    else:
        # Wide caption — search runs across the whole page width but exclude
        # the caption itself.
        x0, x1 = 0.0, page_width_pt
        candidate_runs = ()

    caption_top = caption.bbox.y0
    caption_x0, caption_x1 = caption.bbox.x0, caption.bbox.x1

    # Find the closest text bottom strictly above the caption.
    nearest_bottom_above = 0.0
    for r in candidate_runs:
        if r is caption:
            continue
        if r.bbox.y1 > caption_top:
            continue
        # Text beside a floated figure (common when body text wraps around
        # an inset image) sits at a different x than the figure/caption and
        # shouldn't count as "the paragraph the figure interrupts".
        if r.bbox.x1 <= caption_x0 or r.bbox.x0 >= caption_x1:
            continue
        # A run that's itself another figure/table's caption is always a
        # real content boundary, even though it too sits close beneath its
        # own graphic — never let the graphics-adjacency heuristic swallow
        # it (it would otherwise search straight past the previous figure
        # entirely and merge both into one region).
        if not CAPTION_PATTERN.match(r.text) and _is_figure_internal_text(r, graphics):
            continue
        if r.bbox.y1 > nearest_bottom_above:
            nearest_bottom_above = r.bbox.y1

    gap = caption_top - nearest_bottom_above
    if gap < MIN_FIGURE_GAP_PT:
        # No meaningful whitespace above — probably not a figure.
        return None

    # The figure occupies the gap (with a tiny pad so its top doesn't snap
    # flush against the previous text).
    y0 = nearest_bottom_above
    y1 = caption_top
    if y1 - y0 < MIN_FIGURE_GAP_PT:
        return None
    # Clamp to page bounds defensively.
    y0 = max(0.0, y0)
    y1 = min(page_height_pt, y1)
    return BBox(x0=x0, y0=y0, x1=x1, y1=y1)


def _tighten_to_graphics(bbox: BBox, graphics: tuple[BBox, ...]) -> BBox:
    """Replace a gap-derived bbox's extent with the union of the actual
    image/vector objects that overlap it, so the box hugs the real figure
    content instead of spanning the whole text column. `graphics` locates
    *what's actually drawn*, which text-run positions alone can't — there's
    no text inside a figure to bound it by.

    Vertically, `bbox`'s extent (the whitespace gap above the caption) is the
    validated signal, so the union is clamped to it — a graphic that bleeds
    past the gap (e.g. a stray decorative rule near the caption) shouldn't
    pull the box into neighbouring text.

    Horizontally there's no equivalent clamp: `bbox`'s x0/x1 is just the
    enclosing column's width — a rough fallback, not a true bound. A real
    figure routinely extends wider than its caption or the longest body line
    (both of which the column bbox is derived from), so a real, overlapping
    graphic is trusted over that fallback even when it's wider.

    Falls back to the original bbox untouched when nothing overlaps — e.g. a
    figure with no extractable vector/image content, or a backend that can't
    report graphics."""
    overlapping = [
        g
        for g in graphics
        if g.x0 < bbox.x1 and g.x1 > bbox.x0 and g.y0 < bbox.y1 and g.y1 > bbox.y0
    ]
    if not overlapping:
        return bbox
    x0 = min(g.x0 for g in overlapping)
    x1 = max(g.x1 for g in overlapping)
    y0 = max(bbox.y0, min(g.y0 for g in overlapping))
    y1 = min(bbox.y1, max(g.y1 for g in overlapping))
    if x1 <= x0 or y1 <= y0:
        return bbox  # degenerate intersection — keep the safe fallback
    return BBox(x0=x0, y0=y0, x1=x1, y1=y1)


def detect_figures(
    page_text: PageText,
    page_width_pt: float,
    page_height_pt: float,
    graphics: tuple[BBox, ...] = (),
) -> list[FigureRegion]:
    """Detect figure regions on a page from caption signals.

    `graphics` (optional) is the page's non-text object bounding boxes — see
    `PdfBackend.get_page_graphics` — used to tighten each detected region to
    the real figure content. Without it (or on a page with no such objects),
    the region falls back to the whole enclosing column's width.

    Returns an empty list when there are no captions (most pages) — cost is
    one regex scan over the page's text runs.
    """
    captions = _find_caption_runs(page_text.runs)
    figures: list[FigureRegion] = []
    seen_labels: set[str] = set()
    for caption_run, label in captions:
        # Dedup: a caption sometimes spans two text runs ("Figure 2" + ":
        # Description") and we'd double-detect. Take the first occurrence
        # of each label per page.
        if label in seen_labels:
            continue
        seen_labels.add(label)

        column = _column_for_caption(
            caption_run, page_text.columns, page_width_pt
        )
        fbox = _figure_bbox_above_caption(
            caption_run, column, page_width_pt, page_height_pt, graphics
        )
        if fbox is None:
            continue
        if graphics:
            fbox = _tighten_to_graphics(fbox, graphics)
        if fbox.width < MIN_FIGURE_DIMENSION_PT or fbox.height < MIN_FIGURE_DIMENSION_PT:
            continue
        figures.append(
            FigureRegion(
                figure_id=_figure_id(page_text.page_index, label),
                label=label,
                page_index=page_text.page_index,
                bbox=fbox,
                caption_bbox=caption_run.bbox,
            )
        )
    return figures
