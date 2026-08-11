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

A multi-panel figure ("Figure 3a-g") is further split into one region per
sub-panel when its panels carry corner letter labels — see
`_detect_sub_panels`. Each panel becomes its own `FigureRegion` (label
"Figure 3a", "Figure 3b", ...) so the reader can click one panel instead of
the whole grid; figures without isolated letter markers are unaffected and
stay a single region.

This module is the only thing in the backend that takes a page-rendering
"Figure" position — everything downstream addresses it by `figure_id`.
"""

from __future__ import annotations

import re
import statistics
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

# A table captioned without a number -- "Table:", "Summary Table:" -- common
# in an appendix where there's only ever one such table so the paper doesn't
# bother numbering it (real example: an FDA report's "Appendix C: Summary
# Table"). Deliberately a separate, narrower pattern rather than making the
# number optional in CAPTION_PATTERN above: that would make it match any
# ordinary sentence starting with the word "Table". Requiring a literal ":"
# right after "Table" keeps it just as safe while still catching this case.
UNNUMBERED_TABLE_PATTERN = re.compile(
    r"^\s*(?P<summary>Summary\s+)?Table\s*:", re.IGNORECASE
)

# A "gap" is the vertical whitespace separating the figure from text above.
# Lines in a paragraph are typically <2pt apart; a figure starts where the
# spacing balloons. 18pt is a conservative threshold that handles most
# layouts without merging adjacent prose paragraphs into the figure.
MIN_FIGURE_GAP_PT = 18.0

# A Figure/Extended Data Figure caption with zero graphics anywhere on its
# page has nothing to confirm the gap-derived box with — an ordinary single
# blank line before ANY bold heading clears MIN_FIGURE_GAP_PT, caption or
# not. A genuine borderless figure has real substantive content above it
# (comfortably taller than one line); requiring that height is what tells
# it apart from the common false positive: a caption whose own image lives
# elsewhere (a mid-sentence match with no image at all, or a real caption
# whose image is on another page — see `_orphan_caption`).
MIN_UNCONFIRMED_FIGURE_GAP_PT = 60.0

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
        if m:
            label = _normalize_label(m.group("prefix"), m.group("kind"), m.group("num"))
            out.append((run, label))
            continue
        um = UNNUMBERED_TABLE_PATTERN.match(run.text)
        if um:
            label = "Summary Table" if um.group("summary") else "Table"
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


def _other_caption_in_window(
    caption: TextRun, all_captions: list[tuple[TextRun, str]], ceiling: float
) -> bool:
    """Whether some OTHER caption's own line physically sits between
    `ceiling` and this caption's top, regardless of column.

    A caption's own detected run only reflects one LINE of it — routinely
    just the "Fig. N |" opener, which for a figure whose caption paragraph
    wraps across both columns below a full-width figure is only as wide as
    the left column. Sub-panel search widens to the full page width in that
    case (see `detect_figures`), which is only safe when nothing else is
    sharing that vertical band — this is what tells the two apart from a
    page that genuinely has a second, differently-labelled figure/table
    beside this one (a real caption run sitting inside the band is
    unambiguous proof of that; the panel-label letters extracted from a
    figure's own diagrams are not similarly reliable early enough to use
    here)."""
    caption_top = caption.bbox.y0
    for other_run, _ in all_captions:
        if other_run is caption:
            continue
        if ceiling <= other_run.bbox.y0 <= caption_top:
            return True
    return False


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


# --- sub-panel detection -----------------------------------------------
#
# Many figures — especially multi-panel results grids and the flowchart
# diagrams common in agent papers — are drawn as a set of independently
# meaningful sub-figures ("a", "b", "c"...) under one caption. Detecting
# each panel individually is what makes double-click-to-explain answer the
# panel the reader is actually looking at, instead of summarizing the whole
# grid. Only bare letter markers ("a", "(a)") are recognized for now, not a
# letter embedded in a longer sub-caption run ("(a) BERT-base gender.") —
# that needs a different extraction (pulling the marker out of a sentence)
# and is a follow-up, not a blocker: figures without isolated markers simply
# don't split, falling back to the existing single-box behavior.

_PANEL_LABEL_PATTERN = re.compile(r"^(?:\(([a-z])\)|([a-z])\.?)$")

# Panel labels within this many points of each other vertically belong to
# the same visual row (e.g. "b", "c", "d" side by side).
PANEL_ROW_TOLERANCE_PT = 30.0

# A label marks its panel's top-left corner, not the panel's full extent.
# The gap-search for a row/column boundary must start this far past the
# label's own edge — right at the edge, graphics-coverage always dips
# because the label itself is text, not graphics, which would otherwise
# make the search lock onto that spurious dip instead of the real gap
# further out where the panel's content actually ends.
PANEL_LABEL_SKIP_PT = 25.0

# A label can sit just outside the parent figure's tightened bbox (which
# wraps only graphics, not the label text itself) -- pad the search region
# by this much so labels aren't missed purely due to where the tightened
# box happened to land.
PANEL_LABEL_SEARCH_PAD_PT = 20.0

# A panel whose area is a tiny sliver of the TYPICAL panel in the same
# figure is a strong signal that a row/column boundary landed on a spurious
# internal gap (e.g. the small space between two paragraphs stacked inside
# ONE tall panel) rather than a real seam between two panels. Measured
# against the MEDIAN panel area, not the largest one: a real figure with
# many panels routinely mixes panel types of legitimately different visual
# weight (a big heatmap spanning many genes next to a small two-bar summary
# chart), and comparing only against the single largest panel would let one
# such outlier reject an otherwise-correct split. The median is far less
# sensitive to one or two panels being unusually big or small. Rejecting
# the whole split and falling back to the single parent box is safer than
# shipping a panel box that's confidently wrong.
MIN_PANEL_AREA_RATIO = 0.05

# How close a candidate corner-label must sit to some graphic's own top-left
# corner to count as a real panel marker, rather than a stray single-character
# text fragment that happens to match the same bare-letter pattern. PDFium
# routinely extracts a ROTATED axis title (e.g. a vertical "Probability of
# success (%)" y-axis label) as one text run PER GLYPH instead of one run for
# the whole word, and any run whose text happens to be a single letter like
# "a" or "b" then looks exactly like a genuine panel tag to _PANEL_LABEL_
# PATTERN even though it's really just one character of an unrelated word (a
# real, observed case: the "a" in "success rate" won a false "panel a" this
# way, and the "a" in a photo credit line "...Alamy Stock Photo" won another,
# on a page with an unrelated decorative image). A genuine label sits right
# above (sometimes slightly overlapping) and roughly level with its own
# panel's top-left edge; a stray glyph from body text does not. Horizontal
# tolerance is looser than vertical since a label is often aligned with a
# panel's axis-title margin rather than the drawn plot rectangle itself,
# landing noticeably left of the content's own edge.
PANEL_LABEL_CORNER_MAX_DX_PT = 40.0
PANEL_LABEL_CORNER_MAX_DY_PT = 20.0
# A label's own text can dip slightly below a panel's top edge without that
# meaning anything is wrong -- it's still "at the corner".
PANEL_LABEL_CORNER_MAX_OVERLAP_PT = 15.0


def _near_a_graphic_corner(run: TextRun, graphics: tuple[BBox, ...]) -> bool:
    """Whether `run` sits at (or just above) some graphic's top-left corner —
    see PANEL_LABEL_CORNER_MAX_DX_PT/DY_PT above for why this matters."""
    for g in graphics:
        dx = abs(run.bbox.x0 - g.x0)
        dy = g.y0 - run.bbox.y1
        if (
            dx <= PANEL_LABEL_CORNER_MAX_DX_PT
            and -PANEL_LABEL_CORNER_MAX_OVERLAP_PT <= dy <= PANEL_LABEL_CORNER_MAX_DY_PT
        ):
            return True
    return False


def _find_panel_labels(
    runs: tuple[TextRun, ...], region: BBox, graphics: tuple[BBox, ...] = ()
) -> dict[str, TextRun]:
    """Bare single-letter markers ("a", "(a)") within `region` that also sit
    at some graphic's own top-left corner (see `_near_a_graphic_corner`) —
    the corner tag papers draw on each sub-panel. Skipped when `graphics` is
    empty (nothing to validate corners against). At most one run per letter
    (first occurrence that passes the corner check): a genuine panel grid
    never repeats a letter."""
    found: dict[str, TextRun] = {}
    for r in runs:
        m = _PANEL_LABEL_PATTERN.match(r.text.strip())
        if not m:
            continue
        if not (
            region.x0 <= r.bbox.x0 <= region.x1
            and region.y0 <= r.bbox.y0 <= region.y1
        ):
            continue
        if graphics and not _near_a_graphic_corner(r, graphics):
            continue
        letter = m.group(1) or m.group(2)
        if letter not in found:
            found[letter] = r
    return found


def _group_labels_into_rows(
    labels: dict[str, TextRun],
) -> list[list[tuple[str, TextRun]]]:
    """Panel labels grouped into visual rows by y-proximity, each row
    sorted left-to-right."""
    items = sorted(labels.items(), key=lambda kv: kv[1].bbox.y0)
    rows: list[list[tuple[str, TextRun]]] = [[items[0]]]
    for k, run in items[1:]:
        if run.bbox.y0 - rows[-1][-1][1].bbox.y0 < PANEL_ROW_TOLERANCE_PT:
            rows[-1].append((k, run))
        else:
            rows.append([(k, run)])
    for row in rows:
        row.sort(key=lambda kv: kv[1].bbox.x0)
    return rows


def _valley(lo: float, hi: float, count_at, step: float = 2.0) -> float:
    """The point in [lo, hi] with the fewest graphics crossing it — the
    real gap between two panels/rows, found by scanning rather than
    guessed from label positions (panel sizes vary too much for a fixed
    formula, e.g. a midpoint between labels, to land reliably in the gap).

    Among points tied for the minimum count, returns the one CLOSEST TO
    `hi`, not the widest run of them: the space just before `hi` (the next
    row/column's own label) is sparse by definition — that panel's content
    hasn't started yet — while the space just after `lo` (past the
    previous label) is not similarly guaranteed, since a panel with several
    stacked sub-elements (e.g. a column of repeated small icons) has its
    OWN internal gaps in between them, which can be as wide as or wider
    than the true seam and would otherwise win a widest-run comparison,
    landing the boundary inside that panel's own content instead of past
    the end of it."""
    if hi <= lo:
        return lo
    samples: list[tuple[float, int]] = []
    v = lo
    while v <= hi:
        samples.append((v, count_at(v)))
        v += step
    best_count = min(c for _, c in samples)
    for v, c in reversed(samples):
        if c == best_count:
            return v
    raise AssertionError("unreachable: best_count is the min of samples' counts")


def _contiguous_from_a(labels: dict[str, TextRun]) -> dict[str, TextRun]:
    """Keep only the unbroken run of letters starting at "a" -- real panel
    decks are always labelled a, b, c, ... with no skipped letter. A denser
    page (a pathway diagram's node names, a chromosome-arm locus like "1q", a
    stray statistical variable like "p" or "r" sitting near the figure) can
    produce OTHER isolated single-letter runs that individually look just
    like a panel marker; without this, they get treated as panels far out
    in the alphabet ("Figure 4p", "Figure 4q") that no real figure has.
    Requiring the run to be unbroken from "a" is what actually distinguishes
    a genuine grid from that noise, more than matching "a" alone does."""
    kept: dict[str, TextRun] = {}
    letter = "a"
    while letter in labels:
        kept[letter] = labels[letter]
        letter = chr(ord(letter) + 1)
    return kept


def _detect_sub_panels(
    figure_bbox: BBox,
    graphics: tuple[BBox, ...],
    runs: tuple[TextRun, ...],
) -> dict[str, BBox]:
    """Partition a figure's region into per-panel boxes using its panel
    labels as anchors. Returns {} if the figure doesn't have at least two
    labels in an unbroken run starting at "a" (see `_contiguous_from_a`) or
    if fewer than two panels end up with any graphics.
    """
    # figure_bbox is tightened to the union of its own graphics (see
    # _tighten_to_graphics / _figure_bbox_from_clusters) -- a label sitting
    # at a panel's top-left corner routinely falls just outside that tight
    # box (the label is text, not graphics, so it doesn't contribute to the
    # union it's found relative to). Search a padded region so labels aren't
    # missed purely because of where the box-fitting happened to land.
    search_region = BBox(
        x0=figure_bbox.x0 - PANEL_LABEL_SEARCH_PAD_PT,
        y0=figure_bbox.y0 - PANEL_LABEL_SEARCH_PAD_PT,
        x1=figure_bbox.x1 + PANEL_LABEL_SEARCH_PAD_PT,
        y1=figure_bbox.y1 + PANEL_LABEL_SEARCH_PAD_PT,
    )
    labels = _contiguous_from_a(_find_panel_labels(runs, search_region, graphics))
    if len(labels) < 2:
        return {}

    relevant = tuple(
        g
        for g in graphics
        if g.x0 < figure_bbox.x1
        and g.x1 > figure_bbox.x0
        and g.y0 < figure_bbox.y1
        and g.y1 > figure_bbox.y0
    )
    if not relevant:
        return {}

    rows = _group_labels_into_rows(labels)
    row_label_y1 = [max(run.bbox.y1 for _, run in row) for row in rows]
    row_bounds = [figure_bbox.y0]
    for i in range(len(rows) - 1):
        lo = row_label_y1[i] + PANEL_LABEL_SKIP_PT
        hi = rows[i + 1][0][1].bbox.y0
        row_bounds.append(
            _valley(lo, hi, lambda y: sum(1 for g in relevant if g.y0 < y < g.y1))
        )
    row_bounds.append(figure_bbox.y1)

    panels: dict[str, BBox] = {}
    for ri, row in enumerate(rows):
        y0, y1 = row_bounds[ri], row_bounds[ri + 1]
        col_bounds = [figure_bbox.x0]
        for i in range(len(row) - 1):
            lo = row[i][1].bbox.x1 + PANEL_LABEL_SKIP_PT
            hi = row[i + 1][1].bbox.x0
            col_bounds.append(
                _valley(
                    lo,
                    hi,
                    lambda x: sum(
                        1
                        for g in relevant
                        if g.x0 < x < g.x1 and g.y1 > y0 and g.y0 < y1
                    ),
                )
            )
        col_bounds.append(figure_bbox.x1)

        for ci, (letter, _) in enumerate(row):
            cx0, cx1 = col_bounds[ci], col_bounds[ci + 1]
            members = [
                g
                for g in relevant
                if cx0 <= (g.x0 + g.x1) / 2 < cx1 and y0 <= (g.y0 + g.y1) / 2 < y1
            ]
            if not members:
                continue
            panels[letter] = BBox(
                x0=min(m.x0 for m in members),
                y0=min(m.y0 for m in members),
                x1=max(m.x1 for m in members),
                y1=max(m.y1 for m in members),
            )

    if len(panels) < 2:
        return {}
    areas = [b.width * b.height for b in panels.values()]
    if min(areas) < MIN_PANEL_AREA_RATIO * statistics.median(areas):
        return {}
    if _any_panels_overlap_too_much(list(panels.values())):
        return {}
    return panels


# A correct partition tiles the figure — sibling panels shouldn't cover each
# other. A dense, many-row figure (a results table with a thumbnail + text
# per row, labelled deep into the alphabet) can pack rows close enough that
# valley-finding can't cleanly separate them, producing panels that mostly
# overlap instead of tiling — confidently wrong in a way the area-ratio
# guard alone doesn't catch (a bad split like this can still have
# similarly-sized panels). Some overlap is normal even in a good split (a
# label sitting just outside the tightened box, content that legitimately
# brushes a neighbour) so the bar is "mostly covers a sibling", not "touches
# one at all".
MAX_PANEL_OVERLAP_FRACTION = 0.4


def _any_panels_overlap_too_much(boxes: list[BBox]) -> bool:
    for i in range(len(boxes)):
        for j in range(i + 1, len(boxes)):
            a, b = boxes[i], boxes[j]
            ix0, iy0 = max(a.x0, b.x0), max(a.y0, b.y0)
            ix1, iy1 = min(a.x1, b.x1), min(a.y1, b.y1)
            if ix1 <= ix0 or iy1 <= iy0:
                continue
            overlap = (ix1 - ix0) * (iy1 - iy0)
            smaller = min(a.width * a.height, b.width * b.height)
            if smaller > 0 and overlap / smaller > MAX_PANEL_OVERLAP_FRACTION:
                return True
    return False


def _is_visual_label(label: str) -> bool:
    """Whether `label` denotes something that must have actual drawn
    content (an image/chart/diagram) — as opposed to a Table, which can be
    pure text with zero graphics on the page (a borderless table)."""
    return label.startswith("Figure") or label.startswith("Extended Data Figure")


# --- figures whose caption and image sit on different pages ---------------
#
# Nature-family journals routinely give a data-dense figure its own
# dedicated page: the running text discusses it and the full caption is
# printed right there, but the actual image is pushed onto a separate page
# (often the very next one) purely for layout/space reasons. Detected
# per-page, this defeats both halves of the normal pipeline: the caption's
# own page has no graphics to cluster or tighten to (so the whitespace-gap
# fallback would otherwise treat a plain paragraph-to-heading gap as if it
# were the figure -- see `_is_visual_label`'s use below), and the image's
# own page has no caption to anchor detection off of at all.


@dataclass(frozen=True)
class AdjacentPage:
    """Just enough of a neighbouring page for cross-page continuation."""

    text: PageText
    graphics: tuple[BBox, ...]


# A caption run that's genuinely the start of a caption (not a mid-sentence
# reference like "...shown in Fig. 1m)...", which the caption regex itself
# doesn't fully exclude -- see the module's caption-detection limitations)
# is, in this journal family, always followed by a "| Title" -- a citation
# fragment never is. Scoped narrowly to disambiguating cross-page
# continuation, not the main caption regex, since not every paper's caption
# style uses this delimiter (many use ":" or none at all).
_CAPTION_TITLE_SEP_PATTERN = re.compile(r"^[^|]{0,40}\|")

# How close to the very top of a page a figure's own graphics must start to
# plausibly be a continuation image -- just past the running header/DOI
# line, with nothing (no paragraph, no other caption) ahead of it.
CROSS_PAGE_IMAGE_TOP_MAX_PT = 100.0

# A genuine orphaned caption interrupts real running prose. Some journals
# (Nature's main-text style, distinct from the caption-then-image layout
# this module otherwise targets) instead give a long Extended Data caption
# its OWN dedicated page, printed after an image that already appeared --
# and satisfied its own detection -- on the page before. That continuation
# page reproduces the same "Fig. N | Title" caption text, on a page with
# zero graphics, but as literally the FIRST thing on it -- nothing precedes
# it, not even a header. Requiring real content above rules that out
# without needing to look two pages back.
MIN_RUNS_ABOVE_ORPHAN_CAPTION = 5


def _orphan_caption(
    page_text: PageText, graphics: tuple[BBox, ...]
) -> tuple[TextRun, str] | None:
    """This page's trailing visual caption if it can't possibly have its
    image on this page (the whole page has zero drawable content), or None.

    Restricted to captions with a "| Title" separator (see
    `_CAPTION_TITLE_SEP_PATTERN`): a zero-graphics page can also produce
    caption-regex matches on mid-sentence citation fragments ("Fig. 1m)."),
    and those must never be mistaken for a genuine dangling caption. Also
    restricted to captions with real content above them -- see
    `MIN_RUNS_ABOVE_ORPHAN_CAPTION`."""
    if graphics:
        return None
    candidates = [
        (r, l)
        for r, l in _find_caption_runs(page_text.runs)
        if _is_visual_label(l)
        and _CAPTION_TITLE_SEP_PATTERN.match(r.text)
        and sum(1 for run in page_text.runs if run.bbox.y1 < r.bbox.y0)
        >= MIN_RUNS_ABOVE_ORPHAN_CAPTION
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda cl: cl[0].bbox.y0)


def _leading_graphics_bbox(
    page_text: PageText, graphics: tuple[BBox, ...], page_height_pt: float
) -> BBox | None:
    """The union of this page's graphics, if they start right at the top
    with nothing (no caption, no paragraph) ahead of them -- the visual
    signature of a page that IS a continuation image rather than a normal
    figure+caption page. None otherwise (including: this page has its own
    caption before the graphics start, which makes it a normal page, not a
    bare continuation target)."""
    if not graphics:
        return None
    top_y0 = min(g.y0 for g in graphics)
    if top_y0 > CROSS_PAGE_IMAGE_TOP_MAX_PT:
        return None
    captions = _find_caption_runs(page_text.runs)
    if any(r.bbox.y0 < top_y0 for r, _ in captions):
        return None
    cutoff = min((r.bbox.y0 for r, _ in captions), default=page_height_pt)
    leading = tuple(g for g in graphics if g.y0 < cutoff)
    if not leading:
        return None
    return BBox(
        x0=min(g.x0 for g in leading),
        y0=min(g.y0 for g in leading),
        x1=max(g.x1 for g in leading),
        y1=max(g.y1 for g in leading),
    )


def _emit_regions(
    figures: list[FigureRegion],
    page_index: int,
    label: str,
    fbox: BBox,
    caption_bbox: BBox,
    graphics: tuple[BBox, ...],
    runs: tuple[TextRun, ...],
    panels: dict[str, BBox] | None = None,
) -> None:
    """Append either one FigureRegion for `fbox`, or one per sub-panel if
    `panels` is given (or discoverable directly from `fbox`)."""
    if panels is None:
        panels = _detect_sub_panels(fbox, graphics, runs) if graphics else {}
    if panels:
        for letter in sorted(panels):
            panel_bbox = panels[letter]
            if (
                panel_bbox.width < MIN_FIGURE_DIMENSION_PT
                or panel_bbox.height < MIN_FIGURE_DIMENSION_PT
            ):
                continue
            panel_label = f"{label}{letter}"
            figures.append(
                FigureRegion(
                    figure_id=_figure_id(page_index, panel_label),
                    label=panel_label,
                    page_index=page_index,
                    bbox=panel_bbox,
                    caption_bbox=caption_bbox,
                )
            )
        return

    figures.append(
        FigureRegion(
            figure_id=_figure_id(page_index, label),
            label=label,
            page_index=page_index,
            bbox=fbox,
            caption_bbox=caption_bbox,
        )
    )


def detect_figures(
    page_text: PageText,
    page_width_pt: float,
    page_height_pt: float,
    graphics: tuple[BBox, ...] = (),
    prev_page: AdjacentPage | None = None,
) -> list[FigureRegion]:
    """Detect figure regions on a page from caption signals.

    `graphics` (optional) is the page's non-text object bounding boxes — see
    `PdfBackend.get_page_graphics`. The primary strategy clusters `graphics`
    by spatial proximity (see `_cluster_graphics`) and matches each caption
    to the cluster(s) immediately above it, bounded by the nearest other
    caption — this handles rich diagram-style figures (flowcharts, agent
    pipelines) whose embedded labels defeat a purely text-based heuristic.
    When no cluster is usable (e.g. a table with no rule lines), this falls
    back to the whitespace-gap heuristic (`_figure_bbox_above_caption` +
    `_tighten_to_graphics`), which infers the figure's extent from the
    absence of body text above the caption instead. That fallback is
    skipped for a Figure-kind caption on a page with literally zero
    drawable content anywhere, since a Figure is never pure text — see
    `_orphan_caption`.

    `prev_page` (optional) lets a figure whose caption and image were
    placed on different pages resolve correctly: if `prev_page` ends in
    exactly such a stranded caption (see `_orphan_caption`) and THIS page
    opens with bare graphics before any content of its own (see
    `_leading_graphics_bbox`), this page's leading graphics become that
    caption's figure — a layout Nature-family journals use for full-page
    data figures (see `AdjacentPage`). There's no symmetric `next_page`
    parameter: the other half of the pair resolves itself when *that*
    page is detected, by looking at what came before it, exactly the same
    way. Callers that omit `prev_page` simply don't get that cross-page
    resolution: figures fully contained on one page are unaffected either
    way.

    Returns an empty list when there are no captions and no continuation
    image (most pages) — cost is one regex scan over the page's text runs.
    """
    captions = _find_caption_runs(page_text.runs)
    figures: list[FigureRegion] = []
    seen_labels: set[str] = set()

    if prev_page is not None:
        orphan = _orphan_caption(prev_page.text, prev_page.graphics)
        if orphan is not None:
            orphan_caption_run, orphan_label = orphan
            bare = _leading_graphics_bbox(page_text, graphics, page_height_pt)
            if (
                bare is not None
                and bare.width >= MIN_FIGURE_DIMENSION_PT
                and bare.height >= MIN_FIGURE_DIMENSION_PT
            ):
                seen_labels.add(orphan_label)
                _emit_regions(
                    figures,
                    page_text.page_index,
                    orphan_label,
                    bare,
                    orphan_caption_run.bbox,
                    graphics,
                    page_text.runs,
                )

    for caption_run, label in captions:
        # Dedup: a caption sometimes spans two text runs ("Figure 2" + ":
        # Description") and we'd double-detect. Take the first occurrence
        # of each label per page.
        if label in seen_labels:
            continue
        seen_labels.add(label)

        fbox = None
        ceiling = 0.0
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
            if fbox is not None and graphics:
                fbox = _tighten_to_graphics(fbox, graphics)
            if (
                fbox is not None
                and not graphics
                and _is_visual_label(label)
                and fbox.height < MIN_UNCONFIRMED_FIGURE_GAP_PT
            ):
                # A Figure caption on a page with zero drawable content
                # anywhere can't be confirmed by graphics at all, so a THIN
                # gap (the ordinary single blank line before any bold
                # heading, not a real content region) isn't good enough
                # evidence -- it's either a mid-sentence false match or a
                # real caption whose image is on the following page
                # (resolved by that page's own `detect_figures` call, via
                # its `prev_page`). A genuine borderless figure/table with
                # real substance above it clears this easily.
                fbox = None

        if fbox is None:
            continue
        if fbox.width < MIN_FIGURE_DIMENSION_PT or fbox.height < MIN_FIGURE_DIMENSION_PT:
            continue

        panels = _detect_sub_panels(fbox, graphics, page_text.runs) if graphics else {}
        if graphics and not _other_caption_in_window(caption_run, captions, ceiling):
            # The caption's OWN detected run reflects only its first line
            # (typically "Fig. N |"), which for a figure whose caption
            # paragraph wraps across both columns beneath a full-width
            # figure is column-narrow even though the figure itself spans
            # the page -- `fbox` above inherits that narrowness, so some of
            # a real multi-panel grid's outer panels can fall outside the
            # label/graphics search entirely (an incomplete but non-empty
            # split from the narrow box would otherwise stop us here before
            # we ever look wider). Always also try the full page width,
            # guarded by the check above so it can't merge in a genuinely
            # different figure/table sharing the same vertical band, and
            # keep whichever attempt actually found more panels.
            wide_bbox = BBox(
                x0=0.0,
                y0=ceiling,
                x1=page_width_pt,
                y1=caption_run.bbox.y0,
            )
            wide_panels = _detect_sub_panels(wide_bbox, graphics, page_text.runs)
            if len(wide_panels) > len(panels):
                panels = wide_panels

        _emit_regions(
            figures,
            page_text.page_index,
            label,
            fbox,
            caption_run.bbox,
            graphics,
            page_text.runs,
            panels=panels,
        )
    return figures
