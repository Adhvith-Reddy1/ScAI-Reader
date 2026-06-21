"""Unit tests for number-based citation detection and reference extraction.

Synthetic PageText fixtures keep these pure — no real PDF and no LLM. The LLM
parsing path (routes/citations.py) is covered by integration tests that stub
the network.
"""

from __future__ import annotations

from app.pdf.citations import (
    CITATION_PATTERN,
    detect_citations,
    extract_references_text,
)
from app.pdf.types import BBox, PageText, TextColumn, TextRun

PAGE_W = 612.0
PAGE_H = 792.0


def _run(text: str, x0: float, y0: float, x1: float, y1: float) -> TextRun:
    return TextRun(text=text, bbox=BBox(x0, y0, x1, y1), font_size=10.0)


def _page(runs: tuple[TextRun, ...], page_index: int = 0) -> PageText:
    col = TextColumn(bbox=BBox(40, 0, 560, PAGE_H), runs=runs)
    return PageText(page_index=page_index, runs=runs, columns=(col,))


def test_pattern_matches_numeric_brackets_only():
    for s in ["[1]", "[12]", "[3, 5]", "[3,5,8]", "[4-6]", "[4–6]", "[1, 3–5]"]:
        assert CITATION_PATTERN.search(s), s


def test_pattern_rejects_non_numeric_brackets():
    for s in ["[i]", "[Smith 2020]", "[CLS]", "[]", "[ ]", "[a-z]"]:
        assert CITATION_PATTERN.search(s) is None, s


def test_detects_single_citation_with_numbers():
    runs = (_run("As shown in prior work [12] this holds.", 40, 100, 400, 112),)
    markers = detect_citations(_page(runs))
    assert len(markers) == 1
    assert markers[0].numbers == (12,)
    assert markers[0].raw == "[12]"
    assert markers[0].marker_id == "p0_c0"


def test_expands_comma_and_range_lists():
    runs = (_run("Multiple refs [3, 5] and a range [7-9].", 40, 100, 400, 112),)
    markers = detect_citations(_page(runs))
    assert [m.numbers for m in markers] == [(3, 5), (7, 8, 9)]


def test_marker_bbox_is_within_run_and_ordered():
    # "[1]" sits early in the run, "[2]" late — x positions should reflect that.
    runs = (_run("Start [1] middle text trailing [2]", 100, 50, 300, 62),)
    markers = detect_citations(_page(runs))
    assert len(markers) == 2
    first, second = markers
    # Both hotspots stay inside the run's horizontal span.
    assert 100 <= first.bbox.x0 <= first.bbox.x1 <= 300
    assert 100 <= second.bbox.x0 <= second.bbox.x1 <= 300
    # And the later citation is to the right of the earlier one.
    assert first.bbox.x0 < second.bbox.x0
    # y is inherited from the run.
    assert first.bbox.y0 == 50 and first.bbox.y1 == 62


def test_walks_columns_in_reading_order():
    left = TextColumn(
        bbox=BBox(40, 0, 290, PAGE_H),
        runs=(_run("left col [1]", 40, 100, 200, 112),),
    )
    right = TextColumn(
        bbox=BBox(320, 0, 560, PAGE_H),
        runs=(_run("right col [2]", 320, 100, 480, 112),),
    )
    page = PageText(page_index=1, runs=(), columns=(left, right))
    markers = detect_citations(page)
    assert [m.numbers for m in markers] == [(1,), (2,)]
    assert [m.marker_id for m in markers] == ["p1_c0", "p1_c1"]


def test_ignores_absurd_number_runs():
    # A bracketed matrix-like run with too many numbers isn't a citation.
    big = "[" + ", ".join(str(n) for n in range(1, 60)) + "]"
    runs = (_run(big, 40, 100, 560, 112),)
    assert detect_citations(_page(runs)) == []


def test_extract_references_text_slices_after_heading():
    page0 = _page(
        (
            _run("Body discussing references to prior work.", 40, 100, 400, 112),
            _run("More body text.", 40, 120, 400, 132),
        ),
        page_index=0,
    )
    page1 = _page(
        (
            _run("References", 40, 50, 200, 62),
            _run("[1] A. Smith. A great paper. 2020.", 40, 80, 560, 92),
            _run("[2] B. Jones. Another paper. 2021.", 40, 100, 560, 112),
        ),
        page_index=1,
    )
    text = extract_references_text([page0, page1])
    assert "A great paper" in text
    assert "Another paper" in text
    # The heading itself and the body prose before it are excluded.
    assert "Body discussing" not in text
    assert not text.startswith("References")


def test_extract_references_uses_last_heading():
    # The word "references" appears in prose, but the real heading is later.
    page = _page(
        (
            _run("We list our references below for completeness.", 40, 50, 500, 62),
            _run("References", 40, 200, 200, 212),
            _run("[1] Real entry. 2019.", 40, 230, 560, 242),
        ),
    )
    text = extract_references_text([page])
    assert "Real entry" in text
    assert "completeness" not in text


def test_extract_references_returns_empty_without_heading():
    page = _page((_run("No bibliography heading anywhere here.", 40, 50, 500, 62),))
    assert extract_references_text([page]) == ""
