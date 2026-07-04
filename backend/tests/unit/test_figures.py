"""Unit tests for figure region detection.

Builds synthetic PageText fixtures so we don't need a real PDF — the
detector is pure-function over text runs + page dimensions.
"""

from __future__ import annotations

from app.pdf.figures import (
    CAPTION_PATTERN,
    _is_figure_internal_text,
    _tighten_to_graphics,
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
