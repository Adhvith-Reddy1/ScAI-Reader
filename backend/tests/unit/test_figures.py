"""Unit tests for figure region detection.

Builds synthetic PageText fixtures so we don't need a real PDF — the
detector is pure-function over text runs + page dimensions.
"""

from __future__ import annotations

from app.pdf.figures import CAPTION_PATTERN, detect_figures
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
    ]:
        assert CAPTION_PATTERN.match(s) is None, s


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
