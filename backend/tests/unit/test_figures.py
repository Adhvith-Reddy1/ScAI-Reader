"""Unit tests for figure region detection.

Builds synthetic PageText fixtures so we don't need a real PDF — the
detector is pure-function over text runs + page dimensions.
"""

from __future__ import annotations

from app.pdf.figures import (
    CAPTION_PATTERN,
    AdjacentPage,
    _any_panels_overlap_too_much,
    _caption_ceiling,
    _cluster_graphics,
    _contiguous_from_a,
    _detect_sub_panels,
    _find_caption_runs,
    _find_panel_labels,
    _group_labels_into_rows,
    _is_figure_internal_text,
    _leading_graphics_bbox,
    _orphan_caption,
    _other_caption_in_window,
    _PANEL_LABEL_PATTERN,
    _tighten_to_graphics,
    _valley,
    detect_figures,
)
from app.pdf.types import BBox, PageText, TextColumn, TextRun

PAGE_W = 612.0   # ~standard letter, page-space points
PAGE_H = 792.0


def _run(text: str, x0: float, y0: float, x1: float, y1: float) -> TextRun:
    return TextRun(text=text, bbox=BBox(x0, y0, x1, y1), font_size=10.0)


def test_caption_pattern_matches_common_forms():
    for s in [
        "Figure 1: The overall flow.",
        "Figure 2",
        "Fig. 3a Annotated overview",
        "fig 4",
        "Table 1: Results",
        "Figure 12c — extended.",
    ]:
        assert CAPTION_PATTERN.match(s), s


def test_caption_pattern_rejects_non_captions():
    for s in [
        "We show in Figure 2 that...",   # not at line start in run
        "Equation 1",
        "Section 2",
        "FIGURE",                         # no number
        "Figures and tables",
        "Fig. 2), as discussed above",    # inline citation, not a caption
        "Table 1] confirms this",         # inline citation, closing bracket
    ]:
        assert CAPTION_PATTERN.match(s) is None, s


def test_caption_pattern_matches_extended_data_prefix():
    # Nature-family journals number supplementary figures/tables separately
    # from the main text ("Extended Data Fig. 1 |", "Extended Data Table 2").
    for s in [
        "Extended Data Fig. 1 | Some description.",
        "Extended Data Figure 2",
        "Extended Data Table 3 | Results.",
        "extended data fig 4",
    ]:
        assert CAPTION_PATTERN.match(s), s


def test_detects_extended_data_figure_with_distinct_label():
    # Normalized label keeps the "Extended Data" prefix so it can't collide
    # with a same-numbered main-text figure on the same page.
    runs = (
        _run("Body text well above.", 40, 50, 560, 62),
        _run("Extended Data Fig. 1 | Supplementary analysis.", 40, 200, 400, 212),
    )
    col = TextColumn(bbox=BBox(40, 0, 560, PAGE_H), runs=runs)
    page = PageText(page_index=0, runs=runs, columns=(col,))

    figs = detect_figures(page, PAGE_W, PAGE_H)
    assert len(figs) == 1
    assert figs[0].label == "Extended Data Figure 1"
    assert figs[0].figure_id == "p0_Extended_Data_Figure_1"


def test_caption_pattern_rejects_sentence_continuation():
    # A mid-sentence citation to a DIFFERENT, distant figure/table ("...as
    # shown in Extended Data Table 1 shows scores...") continues with a
    # lowercase verb, not a caption separator -- must not be mistaken for a
    # real caption line just because it starts with the right keyword.
    for s in [
        "Table 1 shows scores for the wild-type sequence",
        "Extended Data Table 1 shows scores for the wild-type sequence",
        "Figure 2 illustrates the overall trend",
    ]:
        assert CAPTION_PATTERN.match(s) is None, s
    # Real captions: a capitalized title or a separator right after the
    # number must still match.
    for s in ["Table 1: Results", "Figure 2 Illustrates the overall trend"]:
        assert CAPTION_PATTERN.match(s), s


def test_detects_simple_single_column_figure():
    # Left column on a 612pt page. Caption width 250 < 0.70 * 612 = 428 so it
    # routes through the column branch (not the wide-figure branch).
    runs = (
        _run("Some body text on the page.", 40, 50, 290, 62),
        _run("More body text below it.", 40, 70, 290, 82),
        _run("Figure 1: Overall workflow", 40, 200, 290, 212),
        _run("Continued text below the caption.", 40, 240, 290, 252),
    )
    col = TextColumn(bbox=BBox(40, 0, 290, PAGE_H), runs=runs)
    page = PageText(page_index=2, runs=runs, columns=(col,))

    figs = detect_figures(page, PAGE_W, PAGE_H)
    assert len(figs) == 1
    fig = figs[0]
    assert fig.label == "Figure 1"
    assert fig.page_index == 2
    assert fig.figure_id == "p2_Figure_1"
    # The bbox should sit BETWEEN the second body run and the caption,
    # constrained to the column width.
    assert fig.bbox.y0 == 82          # bottom of "More body text below it."
    assert fig.bbox.y1 == 200          # top of caption
    assert fig.bbox.x0 == 40
    assert fig.bbox.x1 == 290


def test_skips_caption_with_no_gap_above():
    # Caption sits within ~6pt of preceding text — not a real figure. Use a
    # narrow caption (column-routed) so the column's runs are consulted.
    runs = (
        _run("Some body text on the page.", 40, 188, 290, 200),
        _run("Figure 1: Inline-ish caption", 40, 206, 290, 218),
    )
    col = TextColumn(bbox=BBox(40, 0, 290, PAGE_H), runs=runs)
    page = PageText(page_index=0, runs=runs, columns=(col,))

    figs = detect_figures(page, PAGE_W, PAGE_H)
    assert figs == []


def test_handles_wide_spanning_caption():
    # Caption spans both columns => wide branch.
    runs = (
        _run("Top-of-page text.", 40, 30, 560, 42),
        _run(
            "Figure 1: A wide figure that spans both columns",
            40, 320, 572, 334,
        ),  # width = 532 > 0.70 * 612 = 428.4
    )
    col = TextColumn(bbox=BBox(40, 0, 560, PAGE_H), runs=runs)
    page = PageText(page_index=0, runs=runs, columns=(col,))

    figs = detect_figures(page, PAGE_W, PAGE_H)
    assert len(figs) == 1
    fig = figs[0]
    # Wide caption => full page width, not column width.
    assert fig.bbox.x0 == 0.0
    assert fig.bbox.x1 == PAGE_W


def test_dedupes_repeated_caption_runs_on_same_page():
    # Same caption appears twice because text extraction split it.
    runs = (
        _run("Body text above.", 40, 50, 560, 62),
        _run("Figure 1: First fragment", 40, 200, 200, 212),
        _run("Figure 1: Second fragment", 40, 220, 200, 232),
        _run("Body below.", 40, 260, 560, 272),
    )
    col = TextColumn(bbox=BBox(40, 0, 560, PAGE_H), runs=runs)
    page = PageText(page_index=0, runs=runs, columns=(col,))

    figs = detect_figures(page, PAGE_W, PAGE_H)
    # Only the first 'Figure 1' should produce a region.
    assert len(figs) == 1
    assert figs[0].label == "Figure 1"


def test_detects_table_captions():
    runs = (
        _run("Some body text.", 40, 50, 560, 62),
        _run("Table 3: Hyperparameters", 40, 200, 560, 212),
    )
    col = TextColumn(bbox=BBox(40, 0, 560, PAGE_H), runs=runs)
    page = PageText(page_index=0, runs=runs, columns=(col,))

    figs = detect_figures(page, PAGE_W, PAGE_H)
    assert len(figs) == 1
    assert figs[0].label == "Table 3"
    assert figs[0].figure_id == "p0_Table_3"


# --- graphics-based bbox tightening -----------------------------------------


def _figure_page():
    """A single-column page with a figure gap from y=82 to y=200, column
    spanning x=40 to x=290 — same shape as test_detects_simple_single_column_figure."""
    runs = (
        _run("Some body text on the page.", 40, 50, 290, 62),
        _run("More body text below it.", 40, 70, 290, 82),
        _run("Figure 1: Overall workflow", 40, 200, 290, 212),
    )
    col = TextColumn(bbox=BBox(40, 0, 290, PAGE_H), runs=runs)
    return PageText(page_index=0, runs=runs, columns=(col,))


def test_tighten_to_graphics_narrows_the_column_width_box():
    # The actual chart sits inset from both column edges and doesn't fill
    # the whole vertical gap either.
    graphics = (BBox(x0=100, y0=100, x1=200, y1=180),)
    figs = detect_figures(_figure_page(), PAGE_W, PAGE_H, graphics)
    assert len(figs) == 1
    assert figs[0].bbox == BBox(x0=100, y0=100, x1=200, y1=180)


def test_tighten_to_graphics_unions_multiple_objects():
    # A chart made of several separate drawn objects (e.g. individual bars) —
    # the box should hug their combined extent, not just one of them.
    graphics = (
        BBox(x0=100, y0=150, x1=130, y1=180),
        BBox(x0=150, y0=100, x1=180, y1=180),
        BBox(x0=200, y0=130, x1=230, y1=180),
    )
    figs = detect_figures(_figure_page(), PAGE_W, PAGE_H, graphics)
    assert figs[0].bbox == BBox(x0=100, y0=100, x1=230, y1=180)


def test_tighten_to_graphics_ignores_non_overlapping_objects():
    # A graphic elsewhere on the page (e.g. a logo in the header) must not
    # pull the box away from the actual figure's gap.
    graphics = (
        BBox(x0=100, y0=100, x1=200, y1=180),  # inside the gap
        BBox(x0=500, y0=500, x1=560, y1=560),  # unrelated, elsewhere
    )
    figs = detect_figures(_figure_page(), PAGE_W, PAGE_H, graphics)
    assert figs[0].bbox == BBox(x0=100, y0=100, x1=200, y1=180)


def test_tighten_to_graphics_clamps_vertically_but_not_horizontally():
    # A graphic that bleeds past the detected gap vertically (e.g. a
    # full-bleed background rectangle) gets clamped to the gap in y — the
    # whitespace-gap signal is the validated one, so it always wins. But its
    # x-extent (here, the full page width) is honored as-is: horizontally,
    # the gap box is only ever a rough fallback, not a real bound.
    graphics = (BBox(x0=0, y0=0, x1=PAGE_W, y1=PAGE_H),)
    figs = detect_figures(_figure_page(), PAGE_W, PAGE_H, graphics)
    assert figs[0].bbox == BBox(x0=0, y0=82, x1=PAGE_W, y1=200)


def test_tighten_to_graphics_can_exceed_the_column_width():
    # Regression test for a real bug: a figure is routinely wider than its
    # own caption or the longest body line — both of which the column bbox
    # (the x0=40..290 fallback here) is derived from. A real, overlapping
    # graphic must be allowed to widen the box past that fallback rather than
    # being clipped back down to it.
    graphics = (BBox(x0=60, y0=100, x1=350, y1=180),)  # x1=350 > column x1=290
    figs = detect_figures(_figure_page(), PAGE_W, PAGE_H, graphics)
    assert figs[0].bbox.x1 == 350


def test_no_graphics_falls_back_to_column_width_box():
    figs = detect_figures(_figure_page(), PAGE_W, PAGE_H, graphics=())
    assert figs[0].bbox == BBox(x0=40, y0=82, x1=290, y1=200)


def test_tighten_to_graphics_helper_directly():
    bbox = BBox(x0=0, y0=0, x1=100, y1=100)
    # No overlap at all -> unchanged.
    assert _tighten_to_graphics(bbox, (BBox(200, 200, 300, 300),)) == bbox
    # Overlap -> x is the raw union (even reaching outside the original box);
    # y is clamped to the original box.
    tightened = _tighten_to_graphics(
        bbox, (BBox(-10, 10, 40, 40), BBox(60, 60, 150, 200))
    )
    assert tightened == BBox(x0=-10, y0=10, x1=150, y1=100)


# --- real-paper failure modes -------------------------------------------
#
# These reproduce structures found in actual academic PDFs (a Nature paper
# and an NLP bias-analysis paper) where the pure text-gap heuristic silently
# rejected real figures. Each test is a minimal repro of one such case.


def test_is_figure_internal_text_helper_directly():
    graphic = BBox(x0=60, y0=100, x1=200, y1=180)
    # Sits just beneath the graphic, horizontally overlapping -> internal.
    label = TextRun(text="(a) Panel", bbox=BBox(60, 190, 120, 198), font_size=8.0)
    assert _is_figure_internal_text(label, (graphic,))
    # Same vertical gap, but no horizontal overlap -> not internal.
    beside = TextRun(text="(a) Panel", bbox=BBox(300, 190, 360, 198), font_size=8.0)
    assert not _is_figure_internal_text(beside, (graphic,))
    # Too far below to plausibly belong to the graphic -> not internal.
    far_below = TextRun(text="Unrelated", bbox=BBox(60, 400, 120, 408), font_size=8.0)
    assert not _is_figure_internal_text(far_below, (graphic,))


def test_panel_label_does_not_block_gap_when_graphics_present():
    # A multi-panel figure's own sub-label ("(a) ...") sits only 6pt above
    # its caption -- comfortably under MIN_FIGURE_GAP_PT on its own. Without
    # graphics-aware skipping this looks like "no real gap" and a real
    # figure (the chart the label sits under) gets silently rejected. This
    # is the exact shape found in a real paper's multi-panel bias-score
    # figure, where each panel is tagged "(a) ..." / "(b) ..." right above
    # the shared caption.
    runs = (
        _run("Body text well above the figure.", 40, 50, 290, 62),
        _run("(a) Panel label", 60, 190, 120, 198),
        _run("Figure 1: Two-panel comparison", 40, 204, 290, 216),
    )
    col = TextColumn(bbox=BBox(40, 0, 290, PAGE_H), runs=runs)
    page = PageText(page_index=0, runs=runs, columns=(col,))
    graphics = (BBox(x0=60, y0=100, x1=200, y1=180),)

    figs = detect_figures(page, PAGE_W, PAGE_H, graphics)
    assert len(figs) == 1
    assert figs[0].label == "Figure 1"
    assert figs[0].bbox == BBox(x0=60, y0=100, x1=200, y1=180)


def test_another_captions_own_text_still_blocks_the_gap():
    # Two stacked mini-figures, each with its own panel label sitting close
    # beneath its own chart (same shape as the single-figure case above).
    # The graphics-adjacency skip must not swallow FIGURE 1's real caption
    # while scanning for figure 2's boundary just because that caption also
    # sits close beneath figure 1's own chart -- otherwise figure 2's region
    # reaches straight past figure 1's caption and swallows figure 1's chart
    # too.
    runs = (
        _run("(a) Panel label", 60, 110, 120, 118),        # figure 1's label
        _run("Figure 1: First figure", 40, 124, 290, 136),  # caption 1
        _run("(a) Panel label", 60, 186, 120, 194),         # figure 2's label
        _run("Figure 2: Second figure", 40, 200, 290, 212),  # caption 2
    )
    col = TextColumn(bbox=BBox(40, 0, 290, PAGE_H), runs=runs)
    page = PageText(page_index=0, runs=runs, columns=(col,))
    graphics = (
        BBox(x0=60, y0=70, x1=200, y1=100),    # figure 1's chart
        BBox(x0=60, y0=146, x1=200, y1=176),   # figure 2's chart, stacked below
    )

    figs = detect_figures(page, PAGE_W, PAGE_H, graphics)
    labels = {f.label: f.bbox for f in figs}
    assert labels == {
        "Figure 1": BBox(x0=60, y0=70, x1=200, y1=100),
        "Figure 2": BBox(x0=60, y0=146, x1=200, y1=176),
    }


def test_text_beside_floated_figure_does_not_block_gap():
    # Body text continues on one side of a wide "column" while a figure is
    # floated on the other side with its own caption directly beneath it.
    # The nearby body text sits at a similar y but a different x, and must
    # not count as "the paragraph the figure interrupts" -- this is the
    # shape of a real paper's small figure floated beside running text.
    runs = (
        _run("Continuing body text on the left side.", 40, 190, 200, 202),
        _run("Figure 2: A floated figure", 350, 204, 560, 216),
    )
    col = TextColumn(bbox=BBox(40, 0, 560, PAGE_H), runs=runs)
    page = PageText(page_index=0, runs=runs, columns=(col,))
    graphics = (BBox(x0=350, y0=100, x1=560, y1=180),)

    figs = detect_figures(page, PAGE_W, PAGE_H, graphics)
    assert len(figs) == 1
    assert figs[0].bbox.x0 == 350


def test_rejects_degenerate_sliver_bbox():
    # A caption whose only overlapping "graphic" is a hairline (e.g. a
    # decorative rule caught by a mislabeled/split caption run) shouldn't
    # produce a hairline "figure" -- a box a user could never usefully see
    # or click.
    runs = (
        _run("Body text well above.", 40, 50, 290, 62),
        _run("Figure 1: Something", 40, 200, 290, 212),
    )
    col = TextColumn(bbox=BBox(40, 0, 290, PAGE_H), runs=runs)
    page = PageText(page_index=0, runs=runs, columns=(col,))
    graphics = (BBox(x0=100, y0=150, x1=200, y1=151),)  # 1pt tall

    figs = detect_figures(page, PAGE_W, PAGE_H, graphics)
    assert figs == []


# --- graphics clustering (diagram-style figures) ----------------------------
#
# Real papers about LLM agents routinely use flowchart/architecture diagrams
# instead of simple chart panels: many small boxes, arrows, and node labels
# scattered at positions no single text-adjacency rule reliably classifies as
# "body prose" vs. "part of the diagram". Clustering the page's own graphics
# by spatial proximity sidesteps that entirely -- the diagram's own ink is,
# by construction, contiguous.


def test_cluster_graphics_bridges_panel_and_row_gaps():
    # A 2x2 grid of "nodes" with a small horizontal gutter (10pt) and a
    # larger vertical row gap (30pt) -- both comfortably inside tolerance --
    # must end up as a single cluster spanning the whole grid.
    graphics = (
        BBox(0, 0, 40, 40),
        BBox(50, 0, 90, 40),
        BBox(0, 70, 40, 110),
        BBox(50, 70, 90, 110),
    )
    clusters = _cluster_graphics(graphics)
    assert clusters == [BBox(0, 0, 90, 110)]


def test_cluster_graphics_keeps_far_apart_content_separate():
    # One local cluster plus an unrelated mark far away (e.g. a page-corner
    # logo, or a genuinely different figure) must not merge.
    graphics = (
        BBox(0, 0, 40, 40),
        BBox(50, 0, 90, 40),
        BBox(500, 500, 540, 540),
    )
    clusters = _cluster_graphics(graphics)
    assert len(clusters) == 2
    assert BBox(0, 0, 90, 40) in clusters
    assert BBox(500, 500, 540, 540) in clusters


def test_caption_ceiling_uses_nearest_x_overlapping_caption_above():
    runs = (
        _run("Figure 1: First", 40, 100, 290, 112),
        _run("Figure 2: Second", 40, 200, 290, 212),
    )
    captions = _find_caption_runs(runs)
    fig2 = next(r for r, l in captions if l == "Figure 2")
    assert _caption_ceiling(fig2, captions) == 112.0

    fig1 = next(r for r, l in captions if l == "Figure 1")
    assert _caption_ceiling(fig1, captions) == 0.0


def test_caption_ceiling_ignores_non_overlapping_caption():
    # A caption in an unrelated part of the page (different x) must not
    # fence this one's search, even though it sits "above" in y.
    runs = (
        _run("Table 9: Unrelated, far column", 400, 50, 560, 62),
        _run("Figure 2: This one", 40, 200, 290, 212),
    )
    captions = _find_caption_runs(runs)
    fig2 = next(r for r, l in captions if l == "Figure 2")
    assert _caption_ceiling(fig2, captions) == 0.0


def test_detects_full_diagram_with_embedded_mid_diagram_label():
    # A flowchart-style figure: two rows of node boxes with a label sitting
    # in the gap between them, in the left margin gutter -- it doesn't
    # horizontally overlap either row's nodes at all, so it escapes BOTH of
    # _is_figure_internal_text's exclusions ("beneath a graphic", "inside a
    # small box") and the old whitespace-gap heuristic sees it as ordinary
    # body text marking where the figure ends, recovering only the row
    # below it. The cluster-based path isn't affected by it at all, since it
    # never looks at text to find the figure's extent in the first place.
    runs = (
        _run("Body text well above the figure.", 40, 30, 290, 42),
        _run("mid-diagram label", 0, 95, 50, 103),
        _run("Figure 1: Full pipeline diagram", 40, 220, 290, 232),
    )
    col = TextColumn(bbox=BBox(40, 0, 290, PAGE_H), runs=runs)
    page = PageText(page_index=0, runs=runs, columns=(col,))
    graphics = (
        BBox(60, 50, 150, 90),
        BBox(160, 50, 250, 90),
        BBox(60, 130, 150, 170),
        BBox(160, 130, 250, 170),
    )

    figs = detect_figures(page, PAGE_W, PAGE_H, graphics)
    assert len(figs) == 1
    assert figs[0].bbox == BBox(60, 50, 250, 170)


def test_stacked_diagrams_closer_than_row_gutter_still_separate():
    # Two stacked mini-diagrams 40pt apart -- inside ROW_GUTTER_PT (50pt), so
    # graphics-distance ALONE would merge them into one cluster. The caption
    # in between is what actually keeps them apart: it's direct proof that
    # whatever is below it belongs to a different, already-labelled figure.
    runs = (
        _run("Figure 1: First diagram", 40, 100, 290, 112),
        _run("Figure 2: Second diagram", 40, 180, 290, 192),
    )
    col = TextColumn(bbox=BBox(40, 0, 290, PAGE_H), runs=runs)
    page = PageText(page_index=0, runs=runs, columns=(col,))
    graphics = (
        BBox(60, 50, 150, 90),
        BBox(160, 50, 250, 90),
        BBox(60, 130, 150, 170),
        BBox(160, 130, 250, 170),
    )

    figs = detect_figures(page, PAGE_W, PAGE_H, graphics)
    labels = {f.label: f.bbox for f in figs}
    assert labels == {
        "Figure 1": BBox(60, 50, 250, 90),
        "Figure 2": BBox(60, 130, 250, 170),
    }


def test_cluster_path_falls_back_to_text_gap_when_no_graphics_nearby():
    # A caption with graphics present on the page, but none anywhere near
    # it (e.g. a plain data table with no rule lines, elsewhere a chart
    # exists) -- must still fall back to the whitespace-gap heuristic
    # instead of silently detecting nothing.
    runs = (
        _run("Some body text on the page.", 40, 50, 290, 62),
        _run("More body text below it.", 40, 70, 290, 82),
        _run("Figure 1: Overall workflow", 40, 200, 290, 212),
    )
    col = TextColumn(bbox=BBox(40, 0, 290, PAGE_H), runs=runs)
    page = PageText(page_index=0, runs=runs, columns=(col,))
    # Present on the page, but far away (e.g. a chart used by a different
    # caption elsewhere) -- outside this caption's cluster window entirely.
    graphics = (BBox(x0=400, y0=400, x1=450, y1=440),)

    figs = detect_figures(page, PAGE_W, PAGE_H, graphics)
    assert len(figs) == 1
    assert figs[0].label == "Figure 1"
    assert figs[0].bbox == BBox(x0=40, y0=82, x1=290, y1=200)


# --- sub-panel detection -----------------------------------------------


def test_panel_label_pattern():
    for s in ["a", "(a)", "a.", "b", "z"]:
        assert _PANEL_LABEL_PATTERN.match(s), s
    for s in ["ab", "A", "1", "figure", "", "(a", "a)"]:
        assert _PANEL_LABEL_PATTERN.match(s) is None, s


def test_find_panel_labels_dedupes_and_respects_region():
    runs = (
        _run("a", 10, 10, 15, 18),
        _run("b", 10, 100, 15, 108),
        _run("a", 10, 200, 15, 208),  # a second "a" -- first occurrence wins
        _run("c", 500, 10, 505, 18),  # outside the region
    )
    region = BBox(0, 0, 100, 150)
    found = _find_panel_labels(runs, region)
    assert set(found) == {"a", "b"}
    assert found["a"].bbox.y0 == 10  # first occurrence, not the second "a"


def test_group_labels_into_rows_by_y_proximity():
    labels = {
        "a": _run("a", 10, 10, 15, 18).__class__(
            text="a", bbox=BBox(10, 10, 15, 18), font_size=10.0
        ),
        "b": _run("b", 120, 12, 125, 20),
        "c": _run("c", 10, 200, 15, 208),
    }
    rows = _group_labels_into_rows(labels)
    assert [[k for k, _ in row] for row in rows] == [["a", "b"], ["c"]]


def test_valley_finds_sparsest_point():
    boxes = (BBox(0, 0, 10, 10), BBox(0, 20, 10, 30))
    v = _valley(0, 20, lambda y: sum(1 for b in boxes if b.y0 < y < b.y1))
    assert 10 <= v <= 20  # somewhere in the real gap between the two boxes


def test_valley_returns_lo_when_range_is_empty():
    assert _valley(5, 5, lambda v: 0) == 5
    assert _valley(10, 5, lambda v: 0) == 10


def test_detect_sub_panels_splits_two_by_two_grid():
    runs = (
        _run("a", 60, 50, 65, 58),
        _run("b", 220, 50, 225, 58),
        _run("c", 60, 200, 65, 208),
        _run("d", 220, 200, 225, 208),
    )
    graphics = (
        BBox(60, 65, 150, 150),
        BBox(220, 65, 310, 150),
        BBox(60, 215, 150, 290),
        BBox(220, 215, 310, 290),
    )
    figure_bbox = BBox(60, 65, 310, 290)
    panels = _detect_sub_panels(figure_bbox, graphics, runs)
    assert panels == {
        "a": BBox(60, 65, 150, 150),
        "b": BBox(220, 65, 310, 150),
        "c": BBox(60, 215, 150, 290),
        "d": BBox(220, 215, 310, 290),
    }


def test_detect_sub_panels_finds_labels_just_outside_tight_bbox():
    # A label sits at its panel's corner, slightly outside the parent
    # figure's OWN bbox when that bbox is tightened to just its graphics
    # (the label isn't graphics, so it doesn't contribute to that union).
    runs = (
        _run("a", 55, 50, 60, 58),  # 15pt above the tightened figure_bbox.y0
        _run("b", 220, 50, 225, 58),
    )
    graphics = (
        BBox(60, 65, 150, 150),
        BBox(220, 65, 310, 150),
    )
    figure_bbox = BBox(60, 65, 310, 150)  # tight to graphics only
    panels = _detect_sub_panels(figure_bbox, graphics, runs)
    assert set(panels) == {"a", "b"}


def test_detect_sub_panels_requires_panel_a():
    # "b", "c" without "a" is more likely a couple of unrelated single
    # letters (axis ticks, equation variables) than a real panel grid --
    # real papers always start lettering at "a".
    runs = (
        _run("b", 60, 50, 65, 58),
        _run("c", 220, 50, 225, 58),
    )
    graphics = (BBox(60, 65, 150, 150), BBox(220, 65, 310, 150))
    figure_bbox = BBox(60, 65, 310, 150)
    assert _detect_sub_panels(figure_bbox, graphics, runs) == {}


def test_detect_sub_panels_requires_at_least_two_labels():
    runs = (_run("a", 60, 50, 65, 58),)
    graphics = (BBox(60, 65, 150, 150),)
    figure_bbox = BBox(60, 65, 150, 150)
    assert _detect_sub_panels(figure_bbox, graphics, runs) == {}


def test_detect_sub_panels_rejects_degenerate_size_disparity():
    # A real, clean gap between "a" and "b" -- but "a" ends up with a tiny
    # sliver of content next to "b"'s much larger content. This pattern is
    # a strong signal of a bad split (e.g. a spurious valley found inside
    # one panel's own content), so the whole split is rejected rather than
    # shipping a confidently-wrong panel box.
    runs = (
        _run("a", 60, 50, 65, 58),
        _run("b", 60, 200, 65, 208),
    )
    graphics = (
        BBox(60, 65, 65, 70),  # panel a: a 5x5 sliver
        BBox(60, 215, 200, 290),  # panel b: much larger
    )
    figure_bbox = BBox(60, 65, 200, 290)
    assert _detect_sub_panels(figure_bbox, graphics, runs) == {}


def test_detect_figures_splits_labeled_grid_into_separate_regions():
    runs = (
        _run("a", 60, 50, 65, 58),
        _run("b", 220, 50, 225, 58),
        _run("c", 60, 200, 65, 208),
        _run("d", 220, 200, 225, 208),
        _run("Figure 1: Four panels", 40, 310, 290, 322),
    )
    col = TextColumn(bbox=BBox(40, 0, 400, PAGE_H), runs=runs)
    page = PageText(page_index=0, runs=runs, columns=(col,))
    graphics = (
        BBox(60, 65, 150, 150),
        BBox(220, 65, 310, 150),
        BBox(60, 215, 150, 290),
        BBox(220, 215, 310, 290),
    )

    figs = detect_figures(page, PAGE_W, PAGE_H, graphics)
    result = {f.label: (f.figure_id, f.bbox, f.caption_bbox) for f in figs}
    assert set(result) == {"Figure 1a", "Figure 1b", "Figure 1c", "Figure 1d"}
    fid, bbox, caption_bbox = result["Figure 1a"]
    assert fid == "p0_Figure_1a"
    assert bbox == BBox(60, 65, 150, 150)
    # All panels share the figure's one real caption.
    assert caption_bbox == BBox(40, 310, 290, 322)
    assert result["Figure 1c"][1] == BBox(60, 215, 150, 290)


def test_detect_figures_without_panel_labels_stays_a_single_region():
    runs = (
        _run("Body text well above.", 40, 50, 290, 62),
        _run("Figure 1: A single chart", 40, 200, 290, 212),
    )
    col = TextColumn(bbox=BBox(40, 0, 290, PAGE_H), runs=runs)
    page = PageText(page_index=0, runs=runs, columns=(col,))
    graphics = (BBox(60, 100, 200, 180),)

    figs = detect_figures(page, PAGE_W, PAGE_H, graphics)
    assert len(figs) == 1
    assert figs[0].label == "Figure 1"


# --- letter-contiguity, wide-search retry, and overlap guards -------------


def test_contiguous_from_a_keeps_only_the_unbroken_run():
    # A dense diagram (chemistry/genetics variable names, chromosome-arm
    # loci) can produce OTHER isolated single-letter runs far into the
    # alphabet that individually look just like a panel marker; only an
    # unbroken run starting at "a" is trustworthy.
    labels = {
        "a": _run("a", 0, 0, 5, 8),
        "b": _run("b", 10, 0, 15, 8),
        "c": _run("c", 20, 0, 25, 8),
        "p": _run("p", 100, 0, 105, 8),
        "q": _run("q", 110, 0, 115, 8),
    }
    assert set(_contiguous_from_a(labels)) == {"a", "b", "c"}


def test_contiguous_from_a_returns_empty_without_a():
    labels = {"b": _run("b", 0, 0, 5, 8), "c": _run("c", 10, 0, 15, 8)}
    assert _contiguous_from_a(labels) == {}


def test_other_caption_in_window_detects_a_shared_caption():
    this_caption = _run("Figure 1", 40, 300, 100, 310)
    other_caption = _run("Table 1", 300, 150, 360, 160)
    all_captions = [(this_caption, "Figure 1"), (other_caption, "Table 1")]
    assert _other_caption_in_window(this_caption, all_captions, 0.0) is True


def test_other_caption_in_window_false_when_nothing_shares_the_band():
    this_caption = _run("Figure 1", 40, 300, 100, 310)
    all_captions = [(this_caption, "Figure 1")]
    assert _other_caption_in_window(this_caption, all_captions, 0.0) is False


def test_any_panels_overlap_too_much_true_for_heavy_overlap():
    boxes = [BBox(0, 0, 100, 100), BBox(30, 30, 130, 130)]  # 49% of the smaller
    assert _any_panels_overlap_too_much(boxes) is True


def test_any_panels_overlap_too_much_false_for_tiled_boxes():
    boxes = [BBox(0, 0, 100, 100), BBox(100, 0, 200, 100)]  # share an edge only
    assert _any_panels_overlap_too_much(boxes) is False


def test_valley_prefers_the_gap_closest_to_hi_over_a_wider_internal_gap():
    # A panel with several stacked sub-elements (e.g. repeated icons) has
    # its own small internal gaps -- those must not win over the real seam
    # right before the next panel/row starts, even when the internal gap
    # happens to be part of a tie for the minimum crossing-count.
    boxes = (
        BBox(0, 0, 10, 20),  # first sub-element
        BBox(0, 25, 10, 45),  # second sub-element (internal gap: 20-25)
        BBox(0, 90, 10, 100),  # next panel's content starts here
    )
    v = _valley(20.0, 90.0, lambda y: sum(1 for b in boxes if b.y0 < y < b.y1))
    assert v > 45.0  # past the internal gap, not inside it


def test_detect_sub_panels_rejects_heavily_overlapping_split():
    # "a"'s assigned content spans well into "b"'s territory -- a correct
    # partition tiles the figure, so heavy overlap between siblings is a
    # strong signal the row/column boundaries landed wrong, even though
    # each panel individually has plenty of content (area-ratio guard alone
    # wouldn't catch this).
    runs = (
        _run("a", 60, 50, 65, 58),
        _run("b", 220, 50, 225, 58),
    )
    graphics = (
        BBox(60, 65, 260, 150),  # assigned to "a" but bleeds into "b"'s area
        BBox(220, 65, 310, 150),
    )
    figure_bbox = BBox(60, 65, 310, 150)
    assert _detect_sub_panels(figure_bbox, graphics, runs) == {}


def test_detect_figures_widens_search_when_caption_line_is_narrower_than_figure():
    # A caption's own detected run is only its first line ("Fig. N |"),
    # which for a figure whose caption paragraph wraps across both columns
    # below a full-width figure is column-narrow even though the figure
    # itself spans the page. The narrow column here only reaches label "a"
    # and "c"; "b" and "d" sit far to the right, well outside it.
    runs = (
        _run("a", 60, 50, 65, 58),
        _run("b", 460, 50, 465, 58),
        _run("c", 60, 200, 65, 208),
        _run("d", 460, 200, 465, 208),
        _run("Figure 1: Four panels", 40, 310, 140, 322),
    )
    col = TextColumn(bbox=BBox(40, 0, 300, PAGE_H), runs=(runs[-1],))
    page = PageText(page_index=0, runs=runs, columns=(col,))
    graphics = (
        BBox(60, 65, 150, 150),
        BBox(460, 65, 550, 150),
        BBox(60, 215, 150, 290),
        BBox(460, 215, 550, 290),
    )

    figs = detect_figures(page, 600.0, PAGE_H, graphics)
    result = {f.label: f.bbox for f in figs}
    assert set(result) == {"Figure 1a", "Figure 1b", "Figure 1c", "Figure 1d"}
    assert result["Figure 1b"] == BBox(460, 65, 550, 150)
    assert result["Figure 1d"] == BBox(460, 215, 550, 290)


# --- caption and image on different pages ---------------------------------
#
# Nature-family journals routinely give a data-dense figure its own
# dedicated page: the caption is printed in the running text, but the
# actual image is pushed onto a separate page (often the very next one).


def _body_runs(n: int, y_start: float = 50) -> tuple:
    """`n` short body-text runs, standing in for real running prose above a
    caption -- enough of them is what tells a genuine dangling caption apart
    from a caption that's simply the first thing on its own page (see
    `_orphan_caption`)."""
    return tuple(
        _run(f"Body sentence {i}.", 40, y_start + i * 12, 290, y_start + i * 12 + 10)
        for i in range(n)
    )


def test_orphan_caption_finds_a_genuine_dangling_caption():
    runs = _body_runs(10) + (
        _run("Fig. 1 | A wide figure discussed above.", 40, 700, 300, 712),
    )
    page = PageText(page_index=0, runs=runs, columns=())
    result = _orphan_caption(page, graphics=())
    assert result is not None
    _, label = result
    assert label == "Figure 1"


def test_orphan_caption_ignores_mid_sentence_citation():
    # No "| Title" separator -- this is what a mid-sentence reference like
    # "...shown in Fig. 1m)..." looks like once split into its own run.
    runs = _body_runs(10) + (
        _run("Fig. 1m). The density of a marker.", 40, 700, 300, 712),
    )
    page = PageText(page_index=0, runs=runs, columns=())
    assert _orphan_caption(page, graphics=()) is None


def test_orphan_caption_ignores_a_caption_with_nothing_above_it():
    # A caption that's the FIRST thing on its page is a dedicated
    # caption-only continuation page (the image already appeared, and was
    # already detected, on an EARLIER page) -- not a caption waiting for an
    # image on the next one.
    runs = (_run("Fig. 1 | Continued caption text.", 40, 50, 300, 62),)
    page = PageText(page_index=0, runs=runs, columns=())
    assert _orphan_caption(page, graphics=()) is None


def test_orphan_caption_ignores_tables():
    # A borderless table can legitimately have zero graphics -- only a
    # Figure/Extended Data Figure caption is treated as dangling.
    runs = _body_runs(10) + (
        _run("Table 1 | Summary statistics.", 40, 700, 300, 712),
    )
    page = PageText(page_index=0, runs=runs, columns=())
    assert _orphan_caption(page, graphics=()) is None


def test_orphan_caption_none_when_page_has_graphics():
    runs = _body_runs(10) + (
        _run("Fig. 1 | A wide figure discussed above.", 40, 700, 300, 712),
    )
    page = PageText(page_index=0, runs=runs, columns=())
    graphics = (BBox(60, 100, 200, 180),)
    assert _orphan_caption(page, graphics) is None


def test_leading_graphics_bbox_returns_the_union_when_nothing_precedes_it():
    runs = ()
    page = PageText(page_index=1, runs=runs, columns=())
    graphics = (BBox(50, 60, 200, 150), BBox(250, 60, 400, 150))
    bbox = _leading_graphics_bbox(page, graphics, PAGE_H)
    assert bbox == BBox(50, 60, 400, 150)


def test_leading_graphics_bbox_none_when_graphics_start_too_low():
    runs = ()
    page = PageText(page_index=1, runs=runs, columns=())
    graphics = (BBox(50, 300, 200, 400),)  # starts well past the header zone
    assert _leading_graphics_bbox(page, graphics, PAGE_H) is None


def test_leading_graphics_bbox_none_when_page_has_its_own_earlier_caption():
    runs = (_run("Fig. 2 | Its own figure.", 40, 40, 300, 52),)
    page = PageText(page_index=1, runs=runs, columns=())
    graphics = (BBox(50, 60, 200, 150),)  # starts after the page's own caption
    assert _leading_graphics_bbox(page, graphics, PAGE_H) is None


def test_detect_figures_resolves_caption_and_image_on_different_pages():
    caption_page_runs = _body_runs(10) + (
        _run("Fig. 1 | A wide figure discussed above.", 40, 700, 300, 712),
    )
    caption_page = PageText(page_index=0, runs=caption_page_runs, columns=())
    prev_page = AdjacentPage(text=caption_page, graphics=())

    image_page_runs = ()
    image_page = PageText(page_index=1, runs=image_page_runs, columns=())
    graphics = (BBox(50, 60, 200, 150), BBox(250, 60, 400, 150))

    figs = detect_figures(image_page, PAGE_W, PAGE_H, graphics, prev_page=prev_page)
    assert len(figs) == 1
    fig = figs[0]
    assert fig.label == "Figure 1"
    assert fig.page_index == 1  # lives on the image page, not the caption page
    assert fig.bbox == BBox(50, 60, 400, 150)


def test_detect_figures_does_not_duplicate_a_caption_only_continuation_page():
    # The caption-only page (nothing precedes its caption) must not be
    # mistaken for a dangling caption -- its image already lives on an
    # EARLIER page and was already detected there.
    caption_only_runs = (
        _run("Extended Data Fig. 1 | Continued caption text.", 40, 50, 300, 62),
    )
    caption_only_page = PageText(page_index=0, runs=caption_only_runs, columns=())
    prev_page = AdjacentPage(text=caption_only_page, graphics=())

    next_page_runs = (
        _run("Extended Data Fig. 2 | A different figure entirely.", 40, 40, 300, 52),
    )
    next_page = PageText(page_index=1, runs=next_page_runs, columns=())
    graphics = (BBox(50, 60, 200, 150),)  # belongs to Extended Data Figure 2

    figs = detect_figures(next_page, PAGE_W, PAGE_H, graphics, prev_page=prev_page)
    assert len(figs) == 1
    # The leading graphics belong to Figure 2's own caption on THIS page,
    # not the unrelated continuation caption from the page before.
    assert figs[0].label == "Extended Data Figure 2"


def test_unconfirmed_figure_caption_with_thin_gap_is_rejected():
    # Zero graphics anywhere + a THIN gap (one ordinary blank line before a
    # bold heading) isn't enough evidence for a Figure caption -- contrast
    # with test_detects_simple_single_column_figure's much larger gap,
    # which must still work with zero graphics (a genuinely borderless
    # figure/table).
    runs = (
        _run("Body text ends right here.", 40, 50, 290, 62),
        _run("Fig. 1 | Thin gap caption.", 40, 80, 290, 92),  # 18pt gap only
    )
    col = TextColumn(bbox=BBox(40, 0, 290, PAGE_H), runs=runs)
    page = PageText(page_index=0, runs=runs, columns=(col,))
    assert detect_figures(page, PAGE_W, PAGE_H) == []
