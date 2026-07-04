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
    (?!\s+(?-i:[a-z]))                # not "...Table 1 shows scores..." — a
                                       # lowercase word continuing a sentence,
                                       # not a caption's title/description
                                       # (case-sensitive despite IGNORECASE:
                                       # a capitalized word after the number
                                       # is a normal caption title)
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

# A graphic bigger than this in either dimension is treated as a background
# or decorative element (e.g. a full-bleed rule or fill) that most/all page
# text will trivially fall "inside" of — not a discrete panel or label box a
# run could sit inside as actual figure content. Comfortably bigger than a
# realistic callout/legend/summary box, comfortably smaller than a page.
MAX_INTERNAL_GRAPHIC_PT = 300.0

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
    """True if `run` is plausibly part of a figure's own drawn content —
    a panel tag ("(a)", "(b)"), axis label, or text inside a labeled callout
    box (e.g. a flowchart's "Summary: ..." box) — rather than body prose.

    Real figures routinely embed such text well inside a typical
    paragraph-line gap, or directly inside a small box that's part of the
    figure (a diagram node, a legend). Without this check, that text is the
    closest thing above the caption, the measured gap comes out well under
    MIN_FIGURE_GAP_PT, and a real figure gets silently rejected as "not a
    figure" (or, for a large diagram, only the portion below the deepest
    embedded label survives).
    """
    for g in graphics:
        if run.bbox.x1 <= g.x0 or run.bbox.x0 >= g.x1:
            continue  # no horizontal overlap with this graphic
        if g.y1 <= run.bbox.y0 <= g.y1 + FIGURE_LABEL_MAX_GAP_PT:
            return True  # sits just beneath the graphic
        if (
            g.width <= MAX_INTERNAL_GRAPHIC_PT
            and g.height <= MAX_INTERNAL_GRAPHIC_PT
            and g.y0 <= run.bbox.y0
            and run.bbox.y1 <= g.y1
        ):
            return True  # sits inside a small, discrete box
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


# A multi-panel figure's outermost panel routinely sits just past the
# enclosing column's edge (a few points, typically a small panel gutter) —
# still clearly part of the figure. This tolerance bridges that gap. It's
# deliberately small: a page's OTHER column of running text sits hundreds of
# points away, so this can't accidentally pull in unrelated content there.
PANEL_GUTTER_PT = 20.0

# How far apart two graphics can be vertically and still be treated as part
# of the same figure when clustering (see _cluster_graphics) — e.g. two rows
# of a multi-node flowchart (agent-pipeline diagrams routinely have gaps up
# to ~45pt between rows). Comfortably bigger than an intra-figure row gap,
# comfortably smaller than the gap between two genuinely different stacked
# figures (each with its own caption in between, which is a hard fence
# regardless — see _caption_ceiling — so this doesn't have to carry that
# distinction alone).
ROW_GUTTER_PT = 50.0


def _cluster_graphics(graphics: tuple[BBox, ...]) -> list[BBox]:
    """Group graphics into connected components by spatial proximity, and
    return each component's union bbox.

    Rich diagram-style figures (flowcharts, agent pipelines, multi-node
    architecture diagrams — increasingly the norm in papers about LLM
    agents) are drawn as dozens of separate small objects: boxes, arrows,
    icons, node labels. No single text-based heuristic reliably tells "body
    prose" apart from "this diagram's own embedded label" in every case (see
    _is_figure_internal_text) — but the diagram's OWN graphics are, by
    definition, spatially contiguous with each other, gutters and all. Two
    graphics land in the same cluster if they overlap or nearly touch (small
    horizontal gutter, larger vertical row gap — see PANEL_GUTTER_PT and
    ROW_GUTTER_PT); a real column of unrelated running text, or a genuinely
    different figure, sits far enough away that it forms its own cluster.
    """
    n = len(graphics)
    if n == 0:
        return []
    parent = list(range(n))

    def find(i: int) -> int:
        root = i
        while parent[root] != root:
            root = parent[root]
        while parent[i] != root:
            parent[i], i = root, parent[i]
        return root

    def union(i: int, j: int) -> None:
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[ri] = rj

    for i in range(n):
        gi = graphics[i]
        for j in range(i + 1, n):
            gj = graphics[j]
            if (
                gi.x0 - PANEL_GUTTER_PT < gj.x1
                and gi.x1 + PANEL_GUTTER_PT > gj.x0
                and gi.y0 - ROW_GUTTER_PT < gj.y1
                and gi.y1 + ROW_GUTTER_PT > gj.y0
            ):
                union(i, j)

    groups: dict[int, list[BBox]] = {}
    for i, g in enumerate(graphics):
        groups.setdefault(find(i), []).append(g)

    return [
        BBox(
            x0=min(g.x0 for g in members),
            y0=min(g.y0 for g in members),
            x1=max(g.x1 for g in members),
            y1=max(g.y1 for g in members),
        )
        for members in groups.values()
    ]


def _caption_ceiling(
    caption: TextRun, all_captions: list[tuple[TextRun, str]]
) -> float:
    """The bottom edge of the nearest OTHER caption that horizontally
    relates to this one and sits above it, or 0.0 if none.

    A hard fence a figure's graphics-cluster search must never cross —
    unlike ROW_GUTTER_PT (a distance guess), a caption is direct proof that
    whatever is above it belongs to a *different*, already-labelled figure.
    Without this, two figures stacked closer together than ROW_GUTTER_PT
    (or one unusually sparse, large diagram) could merge into one region.
    """
    caption_top = caption.bbox.y0
    cx0, cx1 = caption.bbox.x0, caption.bbox.x1
    ceiling = 0.0
    for other_run, _ in all_captions:
        if other_run is caption or other_run.bbox.y1 > caption_top:
            continue
        if (
            other_run.bbox.x1 <= cx0 - PANEL_GUTTER_PT
            or other_run.bbox.x0 >= cx1 + PANEL_GUTTER_PT
        ):
            continue
        if other_run.bbox.y1 > ceiling:
            ceiling = other_run.bbox.y1
    return ceiling


def _figure_bbox_from_clusters(
    caption: TextRun, graphics: tuple[BBox, ...], ceiling: float
) -> BBox | None:
    """Union of graphics clusters (see _cluster_graphics) that plausibly
    belong to this caption's figure: horizontally related to the caption
    (within PANEL_GUTTER_PT) and vertically between `ceiling` and the
    caption's top. None if no cluster qualifies — callers fall back to the
    text-gap heuristic (needed for figures with little or no extractable
    graphics, e.g. a table drawn with no rule lines).

    Graphics are windowed to (ceiling, caption top) *before* clustering, not
    after: on a graphics-dense page, clustering the whole page can chain a
    figure's own diagram transitively into unrelated content far below it
    (through a long run of moderately-spaced ink) into one sprawling
    cluster that then fails to plausibly match any single caption. Pre-
    windowing means only graphics that could possibly belong to this figure
    are ever considered for clustering in the first place.
    """
    caption_top = caption.bbox.y0
    cx0, cx1 = caption.bbox.x0, caption.bbox.x1
    windowed = tuple(
        g for g in graphics if g.y1 <= caption_top + 2.0 and g.y0 >= ceiling - 2.0
    )
    if not windowed:
        return None
    clusters = _cluster_graphics(windowed)
    relevant = [
        c
        for c in clusters
        if c.x0 - PANEL_GUTTER_PT < cx1 and c.x1 + PANEL_GUTTER_PT > cx0
    ]
    if not relevant:
        return None
    return BBox(
        x0=min(c.x0 for c in relevant),
        y0=min(c.y0 for c in relevant),
        x1=max(c.x1 for c in relevant),
        y1=max(c.y1 for c in relevant),
    )


def _tighten_to_graphics(bbox: BBox, graphics: tuple[BBox, ...]) -> BBox:
    """Replace a gap-derived bbox's extent with the union of the actual
    image/vector objects that overlap it (or nearly do, horizontally — see
    PANEL_GUTTER_PT), so the box hugs the real figure content instead of
    spanning the whole text column. `graphics` locates *what's actually
    drawn*, which text-run positions alone can't — there's no text inside a
    figure to bound it by.

    Vertically, `bbox`'s extent (the whitespace gap above the caption) is the
    validated signal, so the union is clamped to it — a graphic that bleeds
    past the gap (e.g. a stray decorative rule near the caption) shouldn't
    pull the box into neighbouring text.

    Horizontally there's no equivalent clamp on the union's final extent:
    `bbox`'s x0/x1 is just the enclosing column's width — a rough fallback,
    not a true bound. A real figure routinely extends wider than its caption
    or the longest body line (both of which the column bbox is derived
    from), so a real, overlapping graphic is trusted over that fallback even
    when it's wider — this is also how a figure that spans the full page
    width while its caption sits narrow in one column still gets captured,
    as long as at least one graphic actually reaches into that column.

    Falls back to the original bbox untouched when nothing overlaps — e.g. a
    figure with no extractable vector/image content, or a backend that can't
    report graphics."""
    overlapping = [
        g
        for g in graphics
        if g.x0 - PANEL_GUTTER_PT < bbox.x1
        and g.x1 + PANEL_GUTTER_PT > bbox.x0
        and g.y0 < bbox.y1
        and g.y1 > bbox.y0
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
    `PdfBackend.get_page_graphics`. The primary strategy clusters `graphics`
    by spatial proximity (see `_cluster_graphics`) and matches each caption
    to the cluster(s) immediately above it, bounded by the nearest other
    caption — this handles rich diagram-style figures (flowcharts, agent
    pipelines) whose embedded labels defeat a purely text-based heuristic.
    When no cluster is usable (e.g. a table with no rule lines, or no
    graphics at all), this falls back to the whitespace-gap heuristic
    (`_figure_bbox_above_caption` + `_tighten_to_graphics`), which infers the
    figure's extent from the absence of body text above the caption instead.

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

        fbox = None
        if graphics:
            ceiling = _caption_ceiling(caption_run, captions)
            fbox = _figure_bbox_from_clusters(caption_run, graphics, ceiling)

        if fbox is None:
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
