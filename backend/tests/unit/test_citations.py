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
from app.routes.citations import _coerce_entries, _extract_json_array

PAGE_W = 612.0
PAGE_H = 792.0


def test_extract_json_array_tolerates_messy_model_output():
    arr = '[{"number": 1, "authors": "Porter, A.", "title": "A paper"}]'
    assert _extract_json_array(arr)[0]["number"] == 1
    # Prose around the array.
    wrapped = f"Sure, here it is:\n{arr}\nHope that helps!"
    assert _extract_json_array(wrapped)[0]["title"] == "A paper"
    # Fenced code block.
    fenced = f"```json\n{arr}\n```"
    assert _extract_json_array(fenced)[0]["authors"] == "Porter, A."


def test_extract_json_array_raises_without_an_array():
    import pytest

    with pytest.raises(ValueError):
        _extract_json_array("I could not find any references.")


def test_extract_json_array_salvages_truncated_output():
    # Model hit the token cap mid-list: no closing bracket, last entry partial.
    truncated = (
        '[{"number": 1, "authors": "A", "title": "T1"}, '
        '{"number": 2, "authors": "B", "title": "T2"}, {"number": 3, "auth'
    )
    out = _coerce_entries(_extract_json_array(truncated))
    # The two complete entries are recovered; the partial one is dropped.
    assert [e["number"] for e in out] == [1, 2]


def test_coerce_entries_filters_and_dedupes():
    parsed = [
        {"number": 1, "authors": "A", "title": "T1"},
        {"number": "2", "authors": "B", "title": "T2"},   # stringy number ok
        {"number": 1, "authors": "dup", "title": "dup"},  # duplicate dropped
        {"number": "x", "authors": "C", "title": "T3"},   # non-numeric dropped
        {"title": "no number"},                            # missing number dropped
    ]
    out = _coerce_entries(parsed)
    assert [e["number"] for e in out] == [1, 2]


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


def _super(text: str, x0: float, y0: float, x1: float, y1: float) -> TextRun:
    """A small, raised run (font_size carried explicitly)."""
    return TextRun(text=text, bbox=BBox(x0, y0, x1, y1), font_size=6.8)


def test_detects_superscript_citation():
    # Body text at fs=10 on the line y0=80..y1=90; the superscript sits raised
    # (y0=77..y1=84) in a smaller font right after the word.
    body = _run("AI agents", 72, 80, 120, 90)
    sup = _super("24,25", 121, 77, 140, 84)
    runs = (body, sup)
    markers = detect_citations(_page(runs))
    assert [m.numbers for m in markers] == [(24, 25)]
    assert markers[0].raw == "24,25"
    # The whole superscript run is the hotspot (no interpolation).
    assert markers[0].bbox.x0 == 121 and markers[0].bbox.x1 == 140


def test_rejects_subscript_numbers():
    # A chemical subscript (CO2): small font but sits LOW, not raised.
    body = _run("CO", 72, 80, 90, 90)
    sub = _super("2", 91, 86, 96, 92)  # bottom (92) below body baseline (90)
    markers = detect_citations(_page((body, sub)))
    assert markers == []


def test_body_sized_numbers_are_not_superscripts():
    # A page/equation number at body font size must not be flagged.
    body = _run("Equation result follows", 72, 80, 300, 90)
    num = _run("42", 305, 80, 320, 90)  # same font_size as body
    markers = detect_citations(_page((body, num)))
    assert markers == []


def test_superscript_and_bracket_coexist():
    body = _run("Methods [9] and prior", 72, 80, 200, 90)
    sup = _super("3", 201, 77, 210, 84)
    markers = detect_citations(_page((body, sup)))
    assert [m.numbers for m in markers] == [(9,), (3,)]


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


def test_extract_references_handles_heading_glued_to_first_entry():
    # Dense reprints often drop the space: "References1. Smith..." on one run.
    # The strict heading regex misses this; extraction must still find it.
    page = _page(
        (
            _run("Body text with a citation 24,25 here.", 40, 100, 500, 112),
            _run("References1. Swanson, K. The Virtual Lab. 2025.", 40, 200, 560, 212),
            _run("2. Jumper, J. AlphaFold. 2021.", 40, 220, 560, 232),
        ),
    )
    text = extract_references_text([page])
    assert text.startswith("1. Swanson")
    assert "AlphaFold" in text
    assert "Body text" not in text


def test_extract_references_falls_back_to_whole_document_without_heading():
    # No heading at all (scrambled extraction) — hand the LLM the whole text
    # so it can locate the reference list itself rather than returning nothing.
    page = _page(
        (
            _run("Some body text and a citation 5.", 40, 50, 500, 62),
            _run("Smith J. A paper without a clear heading. Nature 2020.", 40, 70, 560, 82),
        ),
    )
    text = extract_references_text([page])
    assert "A paper without a clear heading" in text


def test_extract_references_empty_only_without_any_text():
    page = _page(())  # a page that yielded no runs
    assert extract_references_text([page]) == ""
