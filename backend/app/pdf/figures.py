"""Figure region detection on rendered PDF pages.

We don't get figure boundaries from the PDF directly. The reliable signal we
DO have is the caption: papers virtually always label figures and tables with
a predictable prefix ("Figure 2:", "Fig. 2.", "Table 1"). Once we know where
the caption sits, the figure is the text-free region immediately above it
within the same column.

This module is the only thing in the backend that takes a page-rendering
"Figure" position — everything downstream addresses it by `figure_id`.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .types import BBox, PageText, TextColumn, TextRun

# Match the start of a caption line. Stops at the first non-prefix token so
# regex doesn't tax the whole text — labels are always at the very start.
CAPTION_PATTERN = re.compile(
    r"""^\s*
    (?P<kind>Figure|Fig\.?|Table)    # caption kind
    \s*
    (?P<num>\d+[A-Za-z]?)             # number, optional sub-letter (1, 2a)
    """,
    re.VERBOSE | re.IGNORECASE,
)

# A "gap" is the vertical whitespace separating the figure from text above.
# Lines in a paragraph are typically <2pt apart; a figure starts where the
# spacing balloons. 18pt is a conservative threshold that handles most
# layouts without merging adjacent prose paragraphs into the figure.
MIN_FIGURE_GAP_PT = 18.0

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


def _normalize_label(kind: str, num: str) -> str:
    kind = kind.rstrip(".")
    if kind.lower() == "fig":
        kind = "Figure"
    elif kind.lower() == "figure":
        kind = "Figure"
    elif kind.lower() == "table":
        kind = "Table"
    return f"{kind} {num}"


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
        label = _normalize_label(m.group("kind"), m.group("num"))
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


def _figure_bbox_above_caption(
    caption: TextRun,
    column: TextColumn | None,
    page_width_pt: float,
    page_height_pt: float,
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

    # Find the closest text bottom strictly above the caption.
    nearest_bottom_above = 0.0
    for r in candidate_runs:
        if r is caption:
            continue
        if r.bbox.y1 <= caption_top:
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


def detect_figures(
    page_text: PageText,
    page_width_pt: float,
    page_height_pt: float,
) -> list[FigureRegion]:
    """Detect figure regions on a page from caption signals.

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
            caption_run, column, page_width_pt, page_height_pt
        )
        if fbox is None:
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
