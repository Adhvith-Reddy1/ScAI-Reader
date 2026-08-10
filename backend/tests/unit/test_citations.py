"""Unit tests for citation detection.

Builds synthetic PageText fixtures so we don't need a real PDF — the
detector is pure-function over per-page text runs, same style as
test_figures.py.
"""

from __future__ import annotations

from app.pdf.citations import (
    Citation,
    CitationMention,
    MAX_RANGE_EXPANSION,
    _AUTHOR_YEAR_ENTRY_START,
    _NUMERIC_ENTRY_START,
    _NUMERIC_MENTION_PATTERN,
    _SECTION_HEADING_PATTERN,
    _bbox_for_span,
    _build_author_year_citations,
    _build_numeric_citations,
    _extract_numeric_authors_title,
    _extract_year_author,
    _extract_year_numeric,
    _find_bibliography_start,
    _first_surname,
    _numeric_keys_in_match,
    _run_offsets,
    _split_author_year_entries,
    _split_numeric_entries,
    detect_citations,
)
from app.pdf.types import BBox, PageText, TextRun

PAGE_W = 612.0
PAGE_H = 792.0


def _run(text: str, x0: float, y0: float, x1: float, y1: float) -> TextRun:
    return TextRun(text=text, bbox=BBox(x0, y0, x1, y1), font_size=10.0)


def _page(page_index: int, runs: tuple[TextRun, ...]) -> PageText:
    return PageText(page_index=page_index, runs=runs, columns=())


# --- heading detection -----------------------------------------------------


def test_section_heading_pattern_matches_common_forms():
    for s in ["References", "REFERENCES", "Bibliography", "Works Cited",
              "References:", "7. References", "7) References"]:
        assert _SECTION_HEADING_PATTERN.match(s), s


def test_section_heading_pattern_rejects_inline_mentions():
    for s in ["References [12] and [13] support this claim",
              "See the References section below",
              "Reference"]:
        assert _SECTION_HEADING_PATTERN.match(s) is None, s


def test_find_bibliography_start_returns_none_without_heading():
    pages = [_page(0, (_run("Just some body text.", 40, 50, 300, 62),))]
    assert _find_bibliography_start(pages) is None


def test_no_bibliography_section_returns_empty_without_crashing():
    pages = [
        _page(0, (_run("Introduction text with no refs.", 40, 50, 300, 62),)),
        _page(1, (_run("More text, still no bibliography.", 40, 50, 300, 62),)),
    ]
    citations, mentions = detect_citations(pages)
    assert citations == []
    assert mentions == []


# --- numeric style end-to-end -----------------------------------------------


def test_numeric_style_end_to_end():
    body_page = _page(
        0,
        (
            _run("This finding is supported by prior work [1].", 40, 50, 400, 62),
            _run("Related results appear in [2] as well.", 40, 70, 400, 82),
        ),
    )
    biblio_runs = (
        _run("References", 40, 400, 150, 412),
        _run('[1] J. Smith, "A Study of Things," in Proc. Big Conf., 2019.', 40, 420, 550, 432),
        _run('[2] K. Doe and A. Lee, "Another Study," J. Examples, 2021.', 40, 440, 550, 452),
    )
    biblio_page = _page(1, biblio_runs)

    citations, mentions = detect_citations([body_page, biblio_page])

    assert len(citations) == 2
    by_key = {c.key: c for c in citations}
    assert by_key["1"].authors == "J. Smith"
    assert by_key["1"].title == "A Study of Things"
    assert by_key["1"].year == "2019"
    assert by_key["1"].page_index == 1
    assert by_key["1"].venue is None
    assert by_key["1"].doi is None
    assert by_key["2"].authors == "K. Doe and A. Lee"
    assert by_key["2"].title == "Another Study"
    assert by_key["2"].year == "2021"

    # In-text mentions: "[1]" on the body page, and "[2]" on the body page.
    assert len(mentions) == 2
    mentions_by_key = {m.key: m for m in mentions}
    assert set(mentions_by_key) == {"1", "2"}
    m1 = mentions_by_key["1"]
    assert m1.page_index == 0
    # bbox should be derived from the run containing "[1]".
    assert m1.bbox.x0 >= 40 and m1.bbox.x1 <= 400
    m2 = mentions_by_key["2"]
    assert m2.page_index == 0


def test_numeric_style_multi_run_marker_gets_union_bbox():
    # A marker split across separate text runs (e.g. a font-change boundary)
    # should still be detected, with the bbox spanning all runs involved.
    body_page = _page(
        0,
        (
            _run("See reference ", 40, 50, 120, 62),
            _run("[", 120, 50, 126, 62),
            _run("1", 126, 50, 132, 62),
            _run("]", 132, 50, 138, 62),
            _run(" for details.", 138, 50, 220, 62),
        ),
    )
    biblio_page = _page(
        1,
        (
            _run("References", 40, 400, 150, 412),
            _run('[1] J. Smith, "A Study of Things," 2019.', 40, 420, 550, 432),
        ),
    )
    citations, mentions = detect_citations([body_page, biblio_page])
    assert len(citations) == 1
    assert len(mentions) == 1
    m = mentions[0]
    assert m.key == "1"
    assert m.page_index == 0
    # Union of the "[", "1", "]" runs.
    assert m.bbox == BBox(x0=120, y0=50, x1=138, y1=62)


def test_numeric_mentions_only_emitted_for_known_keys():
    # "[99]" doesn't correspond to any bibliography entry and must not
    # produce a phantom mention.
    body_page = _page(
        0, (_run("An unrelated bracket [99] appears here.", 40, 50, 400, 62),)
    )
    biblio_page = _page(
        1,
        (
            _run("References", 40, 400, 150, 412),
            _run('[1] J. Smith, "A Study of Things," 2019.', 40, 420, 550, 432),
        ),
    )
    citations, mentions = detect_citations([body_page, biblio_page])
    assert len(citations) == 1
    assert mentions == []


# --- author-year style end-to-end -------------------------------------------


def test_author_year_style_end_to_end():
    body_page = _page(
        0,
        (
            _run("Prior work established this (Smith, 2020).", 40, 50, 400, 62),
            _run("Smith (2020) also showed a related result.", 40, 70, 400, 82),
            _run("This aligns with (Doe & Lee, 2019).", 40, 90, 400, 102),
        ),
    )
    biblio_runs = (
        _run("References", 40, 400, 150, 412),
        _run(
            "Smith, J. (2020). A study of things. Journal of Examples, 12(3), 45-67.",
            40, 420, 550, 432,
        ),
        _run(
            "Doe, K., & Lee, A. (2019). Another study. Proc. Big Conf.",
            40, 440, 550, 452,
        ),
    )
    biblio_page = _page(1, biblio_runs)

    citations, mentions = detect_citations([body_page, biblio_page])

    assert len(citations) == 2
    by_key = {c.key: c for c in citations}
    assert set(by_key) == {"Smith2020", "Doe2019"}
    smith = by_key["Smith2020"]
    assert smith.authors == "Smith, J."
    assert smith.title == "A study of things"
    assert smith.year == "2020"
    assert smith.page_index == 1
    doe = by_key["Doe2019"]
    assert doe.authors == "Doe, K., & Lee, A."
    assert doe.title == "Another study"
    assert doe.year == "2019"

    mentions_by_key: dict[str, list[CitationMention]] = {}
    for m in mentions:
        mentions_by_key.setdefault(m.key, []).append(m)
    # Two mentions of Smith2020 ("(Smith, 2020)" and narrative "Smith (2020)")
    # and one of Doe2019.
    assert len(mentions_by_key["Smith2020"]) == 2
    assert len(mentions_by_key["Doe2019"]) == 1
    assert all(m.page_index == 0 for ms in mentions_by_key.values() for m in ms)


def test_author_year_entry_without_year_is_skipped():
    # An entry we can't confidently extract a year from can't be given a
    # reliable key, so it's dropped rather than guessed.
    lines = [("Smith, J. No year here at all.", 0)]
    citations = _build_author_year_citations(lines)
    assert citations == []


# --- no bibliography section --------------------------------------------


def test_document_with_no_bibliography_returns_empty_not_crash():
    pages = [
        _page(0, (_run("Abstract text.", 40, 50, 300, 62),)),
        _page(1, (_run("Body text with (Smith, 2020) mentioned.", 40, 50, 400, 62),)),
    ]
    citations, mentions = detect_citations(pages)
    assert citations == []
    assert mentions == []


def test_empty_pages_list_returns_empty():
    assert detect_citations([]) == ([], [])


# --- numeric range/list expansion -------------------------------------------


def test_bracket_dash_range_expands_to_individual_keys():
    match = _NUMERIC_MENTION_PATTERN.search("see [3]-[5] for details")
    assert match is not None
    assert _numeric_keys_in_match(match) == ["3", "4", "5"]


def test_en_dash_range_also_expands():
    match = _NUMERIC_MENTION_PATTERN.search("see [3]–[5] for details")
    assert match is not None
    assert _numeric_keys_in_match(match) == ["3", "4", "5"]


def test_single_bracket_range_expands():
    match = _NUMERIC_MENTION_PATTERN.search("see [3-5] for details")
    assert match is not None
    assert _numeric_keys_in_match(match) == ["3", "4", "5"]


def test_comma_list_is_not_treated_as_a_range():
    match = _NUMERIC_MENTION_PATTERN.search("see [3, 7] for details")
    assert match is not None
    assert _numeric_keys_in_match(match) == ["3", "7"]


def test_mixed_comma_and_range_body():
    match = _NUMERIC_MENTION_PATTERN.search("see [3, 5-7] for details")
    assert match is not None
    assert _numeric_keys_in_match(match) == ["3", "5", "6", "7"]


def test_reversed_range_is_rejected():
    match = _NUMERIC_MENTION_PATTERN.search("see [9-3] for details")
    assert match is not None
    assert _numeric_keys_in_match(match) == []


def test_oversized_range_is_rejected():
    match = _NUMERIC_MENTION_PATTERN.search(f"see [1-{MAX_RANGE_EXPANSION + 10}] here")
    assert match is not None
    assert _numeric_keys_in_match(match) == []


def test_end_to_end_bracket_dash_range_expansion():
    body_page = _page(
        0, (_run("These results are shown in [3]-[5].", 40, 50, 400, 62),)
    )
    biblio_runs = (
        _run("References", 40, 400, 150, 412),
        _run('[3] A. One, "Title Three," 2018.', 40, 420, 550, 432),
        _run('[4] B. Two, "Title Four," 2019.', 40, 440, 550, 452),
        _run('[5] C. Three, "Title Five," 2020.', 40, 460, 550, 472),
    )
    biblio_page = _page(1, biblio_runs)

    citations, mentions = detect_citations([body_page, biblio_page])
    assert len(citations) == 3
    keys = sorted(m.key for m in mentions)
    assert keys == ["3", "4", "5"]
    assert all(m.page_index == 0 for m in mentions)
    # All three share the same source bbox (the whole "[3]-[5]" span).
    assert len({m.bbox for m in mentions}) == 1


# --- helper-level unit tests -------------------------------------------


def test_split_numeric_entries_groups_continuations():
    lines = [
        ("[1] J. Smith, \"A Study,\"", 0),
        ("in Proc. Big Conf., 2019.", 0),
        ("[2] K. Doe, \"Another,\" 2020.", 0),
    ]
    entries = _split_numeric_entries(lines)
    assert len(entries) == 2
    assert entries[0]["num"] == "1"
    assert entries[0]["parts"] == [
        "[1] J. Smith, \"A Study,\"",
        "in Proc. Big Conf., 2019.",
    ]
    assert entries[1]["num"] == "2"


def test_split_author_year_entries_groups_continuations():
    lines = [
        ("Smith, J. (2020). A study of", 0),
        ("things. Journal of Examples.", 0),
        ("Doe, K. (2019). Another study.", 0),
    ]
    entries = _split_author_year_entries(lines)
    assert len(entries) == 2
    assert entries[0]["surname"] == "Smith"
    assert entries[1]["surname"] == "Doe"


def test_numeric_entry_start_matches_bracket_and_dot_forms():
    assert _NUMERIC_ENTRY_START.match("[12] Smith, J.")
    assert _NUMERIC_ENTRY_START.match("12. Smith, J.")
    assert _NUMERIC_ENTRY_START.match("not a marker") is None
    # Dotted form requires a capital letter right after — otherwise it's
    # likely body prose, not a marker.
    assert _NUMERIC_ENTRY_START.match("12. and then some lowercase text") is None


def test_author_year_entry_start_requires_surname_comma_initial():
    assert _AUTHOR_YEAR_ENTRY_START.match("Smith, J. (2020).")
    assert _AUTHOR_YEAR_ENTRY_START.match("[1] Smith, J.") is None
    assert _AUTHOR_YEAR_ENTRY_START.match("the quick brown fox") is None


def test_extract_numeric_authors_title_no_quote_returns_none():
    assert _extract_numeric_authors_title("no quoted title in here at all 2020") == (
        None,
        None,
    )


def test_extract_year_numeric_takes_the_last_year_like_token():
    content = 'J. Smith, "Title," vol. 19, no. 3, 2020, pp. 1-9.'
    assert _extract_year_numeric(content) == "2020"


def test_extract_year_author_reads_parenthesized_year():
    assert _extract_year_author("Smith, J. (2020). Title.") == "2020"
    assert _extract_year_author("Smith, J. No parens here.") is None


def test_first_surname_strips_trailing_punctuation():
    assert _first_surname("Smith & Doe") == "Smith"
    assert _first_surname("Smith et al.") == "Smith"
    assert _first_surname("Smith,") == "Smith"


def test_bbox_for_span_unions_overlapping_runs():
    runs = (
        _run("abc", 0, 0, 10, 10),
        _run("def", 10, 0, 20, 12),
        _run("ghi", 20, 0, 30, 14),
    )
    page = _page(0, runs)
    offsets = _run_offsets(page)
    # "abcdef" spans the first two runs only.
    bbox = _bbox_for_span(offsets, 0, 6)
    assert bbox == BBox(x0=0, y0=0, x1=20, y1=12)


def test_bbox_for_span_returns_none_out_of_range():
    page = _page(0, (_run("abc", 0, 0, 10, 10),))
    offsets = _run_offsets(page)
    assert _bbox_for_span(offsets, 100, 110) is None


# --- trailing back-matter section stops entry collection -------------------


def test_trailing_section_stops_bibliography_collection():
    pages = [
        _page(
            0,
            (
                _run("References", 40, 50, 150, 62),
                _run('[1] J. Smith, "A Study of Things," 2019.', 40, 70, 550, 82),
                _run("Appendix A", 40, 90, 200, 102),
                _run("Some appendix content that looks unrelated.", 40, 110, 550, 122),
            ),
        )
    ]
    citations, _ = detect_citations(pages)
    assert len(citations) == 1
    assert "appendix" not in citations[0].raw_text.lower()
