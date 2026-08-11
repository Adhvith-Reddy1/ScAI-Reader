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
    MIN_HEADINGLESS_ENTRIES,
    MIN_HEADINGLESS_YEAR_FRACTION,
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
    _find_headingless_numeric_run,
    _find_heading_positions,
    _first_surname,
    _keys_from_digit_list,
    _numeric_keys_in_match,
    _page_body_font_size,
    _run_offsets,
    _split_author_year_entries,
    _split_numeric_entries,
    _superscript_numeric_mentions_on_page,
    _SUPERSCRIPT_MARKER_PATTERN,
    detect_citations,
)
from app.pdf.types import BBox, PageText, TextRun

PAGE_W = 612.0
PAGE_H = 792.0

# A representative NEJM-style body font size, for tests of the superscript
# (bracket-less) numeric mention scanner -- real superscript markers extract
# at roughly 0.4-0.55x the surrounding body text's font size (confirmed
# against a real NEJM PDF).
BODY_FONT_SIZE = 9.3
SUPERSCRIPT_FONT_SIZE = 3.9


def _run(
    text: str, x0: float, y0: float, x1: float, y1: float, font_size: float = 10.0
) -> TextRun:
    return TextRun(text=text, bbox=BBox(x0, y0, x1, y1), font_size=font_size)


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


def test_find_heading_positions_returns_empty_without_heading():
    pages = [_page(0, (_run("Just some body text.", 40, 50, 300, 62),))]
    assert _find_heading_positions(pages) == []


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


# --- regression: real-world layout quirks found against actual papers ------
#
# The four cases below each reproduce a specific extraction bug found by
# running detect_citations against two real PDFs (an NEJM review article and
# an FDA report), fixed after inspecting PDFium's actual run/font output.


def test_split_numeric_entries_handles_marker_on_its_own_run():
    # Hanging-indent numbered lists (confirmed against a real NEJM PDF)
    # extract the "1." marker and the entry's text as two SEPARATE runs/
    # lines, not one combined "1. Pocock SJ..." line.
    lines = [
        ("1.", 0),
        ("Pocock SJ, Stone GW. The primary", 0),
        ("outcome fails.", 0),
        ("2.", 0),
        ("Cardiac Arrhythmia Suppression Trial.", 0),
    ]
    entries = _split_numeric_entries(lines)
    assert len(entries) == 2
    assert entries[0]["num"] == "1"
    assert entries[0]["parts"] == [
        "1.",
        "Pocock SJ, Stone GW. The primary",
        "outcome fails.",
    ]
    assert entries[1]["num"] == "2"


def test_split_numeric_entries_rejects_out_of_sequence_stray_numbers():
    # A numbered reference list is always strictly sequential. A stray
    # number that lands alone on its own run mid-entry (e.g. a page/volume
    # number split across a line wrap, confirmed against a real FDA PDF
    # where "...1542-50." broke after "50.") must NOT be mistaken for a new
    # entry -- it should fold into the current entry as a continuation.
    lines = [
        ("1.", 0),
        ("Smith J. Some title. J Clin Psychiatry, 2006.", 0),
        ("67", 0),
        ("50.", 0),  # stray page-range fragment, NOT entry 50
        ("2.", 0),
        ("Doe A. Another title.", 0),
    ]
    entries = _split_numeric_entries(lines)
    assert len(entries) == 2
    assert entries[0]["num"] == "1"
    assert "50." in entries[0]["parts"]
    assert entries[1]["num"] == "2"


def test_split_numeric_entries_handles_bare_digit_marker_with_separate_period():
    # An even more fragmented layout (confirmed against a real FDA PDF): the
    # marker's digits and its trailing period land in two SEPARATE runs
    # ("88" then "." as its own run), too split for the dotted-marker
    # pattern alone to recognize.
    lines = [
        ("1.", 0),
        ("Smith J. Some title.", 0),
        ("88", 0),
        (".", 0),
        ("Eli Lilly and Company. Briefing Document.", 0),
    ]
    entries = _split_numeric_entries(lines)
    # The sequence 1 -> 88 doesn't continue, so the bare "88" is correctly
    # rejected as entry 2 here (no entry 2-87 precede it in this fixture);
    # the point of this test is that it does NOT crash and entry 1 absorbs
    # the stray fragments as continuations rather than losing them.
    assert entries[0]["num"] == "1"
    assert "88" in entries[0]["parts"]


def test_split_numeric_entries_accepts_bare_digit_marker_when_sequential():
    # Same fragmented-marker layout as above, but this time "88" DOES
    # continue the sequence from a preceding entry 87, so it must be
    # accepted as a real new entry rather than folded in as a continuation.
    lines = [
        ("87.", 0),
        ("Valenstein M. Adherence review.", 0),
        ("88", 0),
        (".", 0),
        ("Eli Lilly and Company. Briefing Document.", 0),
    ]
    entries = _split_numeric_entries(lines)
    assert len(entries) == 2
    assert entries[0]["num"] == "87"
    assert entries[1]["num"] == "88"
    assert entries[1]["parts"] == ["88", ".", "Eli Lilly and Company. Briefing Document."]


def test_find_heading_positions_finds_toc_entry_and_real_heading_both():
    # A table of contents' own "References....36" line frequently extracts
    # as a bare "References" run (the dot-leader and page number land in
    # separate runs) -- confirmed against a real FDA PDF. _find_heading_positions
    # itself doesn't try to disambiguate them (both are real heading-shaped
    # matches) -- that's detect_citations's job, via MIN_REGION_ENTRIES (see
    # the end-to-end test below).
    toc_page = _page(
        0,
        (
            _run("Table of Contents", 40, 40, 200, 52),
            _run("Overview", 40, 60, 150, 72),
            _run("References", 40, 80, 150, 92),  # TOC entry, not the section
        ),
    )
    real_biblio_page = _page(
        1,
        (
            _run("References", 40, 400, 150, 412),
            _run('[1] J. Smith, "A Study of Things," 2019.', 40, 420, 550, 432),
        ),
    )
    positions = _find_heading_positions([toc_page, real_biblio_page])
    assert positions == [(0, 2), (1, 0)]


def test_detect_citations_ignores_toc_entry_and_keeps_the_real_region():
    # End-to-end: the TOC's false "References" match produces a "region"
    # spanning the whole document body between it and the real heading --
    # confirmed against a real FDA PDF, where this caused the ENTIRE document
    # body to be swallowed as "bibliography lines" and in-text citation
    # brackets like "[1]" to be mistaken for entry markers. MIN_REGION_ENTRIES
    # is what discards that degenerate region (it has at most one match, "[1]",
    # short of the bar) while keeping the real region (three real entries).
    toc_page = _page(
        0,
        (
            _run("Table of Contents", 40, 40, 200, 52),
            _run("Overview", 40, 60, 150, 72),
            _run("References", 40, 80, 150, 92),  # TOC entry, not the section
        ),
    )
    body_page = _page(
        1,
        (
            _run("Roughly 9 in 10 drugs are never approved.[1]", 40, 50, 400, 62),
        ),
    )
    real_biblio_page = _page(
        2,
        (
            _run("References", 40, 400, 150, 412),
            _run('[1] J. Smith, "A Study of Things," 2019.', 40, 420, 550, 432),
            _run('[2] K. Doe, "Another Study," 2020.', 40, 440, 550, 452),
            _run('[3] A. Lee, "A Third Study," 2021.', 40, 460, 550, 472),
        ),
    )
    citations, _ = detect_citations([toc_page, body_page, real_biblio_page])
    assert {c.key for c in citations} == {"1", "2", "3"}
    assert "drugs are never approved" not in citations[0].raw_text


# --- superscript numeric mentions (no brackets) -----------------------------


def test_superscript_marker_pattern_matches_digit_lists_with_stray_prefix():
    assert _SUPERSCRIPT_MARKER_PATTERN.match("1")
    assert _SUPERSCRIPT_MARKER_PATTERN.match("21,22 ")
    assert _SUPERSCRIPT_MARKER_PATTERN.match("y2")  # a merge-artifact prefix
    assert _SUPERSCRIPT_MARKER_PATTERN.match("375;10") is None
    assert _SUPERSCRIPT_MARKER_PATTERN.match("not a number") is None


def test_keys_from_digit_list_handles_commas_and_ranges():
    assert _keys_from_digit_list("21,22") == ["21", "22"]
    assert _keys_from_digit_list("5-7") == ["5", "6", "7"]


def test_page_body_font_size_returns_the_dominant_font():
    page = _page(
        0,
        (
            _run("A normal body sentence here.", 40, 50, 300, 62, font_size=BODY_FONT_SIZE),
            _run("Another normal body sentence.", 40, 70, 300, 82, font_size=BODY_FONT_SIZE),
            _run("1", 300, 70, 306, 78, font_size=SUPERSCRIPT_FONT_SIZE),
        ),
    )
    assert _page_body_font_size(page) == BODY_FONT_SIZE


def test_superscript_numeric_mention_detected_via_small_font():
    page = _page(
        0,
        (
            _run(
                "as in our previous article,", 40, 50, 300, 62, font_size=BODY_FONT_SIZE
            ),
            _run("1", 300, 51, 305, 58, font_size=SUPERSCRIPT_FONT_SIZE),
            _run(" which focused on appraisal.", 305, 50, 450, 62, font_size=BODY_FONT_SIZE),
        ),
    )
    mentions = _superscript_numeric_mentions_on_page(page, {"1"})
    assert len(mentions) == 1
    assert mentions[0].key == "1"
    assert mentions[0].page_index == 0
    assert mentions[0].bbox == BBox(300, 51, 305, 58)


def test_superscript_compound_mention_detected():
    page = _page(
        0,
        (
            _run("the PLATO trial", 40, 50, 150, 62, font_size=BODY_FONT_SIZE),
            _run("21,22 ", 150, 51, 168, 58, font_size=SUPERSCRIPT_FONT_SIZE),
            _run(" involving patients", 168, 50, 300, 62, font_size=BODY_FONT_SIZE),
        ),
    )
    mentions = _superscript_numeric_mentions_on_page(page, {"21", "22"})
    assert {m.key for m in mentions} == {"21", "22"}
    assert all(m.bbox == BBox(150, 51, 168, 58) for m in mentions)


def test_superscript_mention_not_emitted_for_unknown_key():
    page = _page(
        0,
        (
            _run("a footer page number", 40, 50, 300, 62, font_size=BODY_FONT_SIZE),
            _run("972", 300, 51, 315, 58, font_size=SUPERSCRIPT_FONT_SIZE),
        ),
    )
    assert _superscript_numeric_mentions_on_page(page, {"1", "2"}) == []


def test_superscript_mention_requires_meaningfully_smaller_font():
    # A digit run at (nearly) body font size is ordinary text, not a
    # superscript marker -- it must not be treated as a citation.
    page = _page(
        0,
        (
            _run("body text", 40, 50, 150, 62, font_size=BODY_FONT_SIZE),
            _run("1", 150, 50, 158, 62, font_size=BODY_FONT_SIZE * 0.95),
        ),
    )
    assert _superscript_numeric_mentions_on_page(page, {"1"}) == []


def test_superscript_mentions_drop_dense_rows_like_affiliation_bylines():
    # Regression test for a real false-positive class found against a real
    # Nature article: an author-affiliation byline ("Ang Cui1,2,12, Teddy
    # Huang3, Shuqiang Li2,3, ...") is glyph-for-glyph indistinguishable
    # from a citation superscript (small font, digit-only), and the numbers
    # routinely fall within a real bibliography's key range by coincidence.
    # What sets it apart is density: real in-text citations scatter one or
    # two to a line, while a byline (or, separately confirmed, a chart's
    # numbered axis ticks) crams many small numbers onto the SAME baseline.
    # Five-plus matches sharing a y0 -- more than any real prose line in
    # either real document that surfaced this -- are dropped as a row.
    row_y = 50
    dense_row = tuple(
        _run(str(i), 40 + i * 20, row_y, 45 + i * 20, row_y + 7, font_size=SUPERSCRIPT_FONT_SIZE)
        for i in range(1, 6)  # 5 matches on one row -- over the limit
    )
    page = _page(
        0,
        (_run("Author One", 40, 30, 150, 42, font_size=BODY_FONT_SIZE),) + dense_row,
    )
    keys = {str(i) for i in range(1, 6)}
    assert _superscript_numeric_mentions_on_page(page, keys) == []


def test_superscript_mentions_keep_sparse_rows_below_the_density_bar():
    # A handful of legitimate citations sharing a line (a dense sentence
    # citing several sources in a row) must not be swept up by the same
    # filter -- only rows past MAX_SUPERSCRIPT_MATCHES_PER_ROW are dropped.
    row_y = 50
    sparse_row = tuple(
        _run(str(i), 40 + i * 20, row_y, 45 + i * 20, row_y + 7, font_size=SUPERSCRIPT_FONT_SIZE)
        for i in range(1, 4)  # 3 matches -- under the limit
    )
    page = _page(
        0,
        (_run("as shown in prior work", 40, 30, 150, 42, font_size=BODY_FONT_SIZE),) + sparse_row,
    )
    keys = {str(i) for i in range(1, 4)}
    mentions = _superscript_numeric_mentions_on_page(page, keys)
    assert {m.key for m in mentions} == {"1", "2", "3"}


def test_detect_citations_end_to_end_with_superscript_style():
    # Full pipeline: numeric bibliography + bare superscript in-text markers
    # (no brackets), the NEJM/JAMA/Lancet house style. Reference numbers must
    # be contiguous (1, 2, 3, ...) since the entry splitter relies on that
    # invariant to reject stray numbers -- see
    # test_split_numeric_entries_rejects_out_of_sequence_stray_numbers.
    body_page = _page(
        0,
        (
            _run(
                "as in our previous article,", 40, 50, 300, 62, font_size=BODY_FONT_SIZE
            ),
            _run("1", 300, 51, 305, 58, font_size=SUPERSCRIPT_FONT_SIZE),
            _run(
                " and the PLATO trial", 305, 50, 420, 62, font_size=BODY_FONT_SIZE
            ),
            _run("2,3 ", 420, 51, 438, 58, font_size=SUPERSCRIPT_FONT_SIZE),
            _run(" involving patients.", 438, 50, 550, 62, font_size=BODY_FONT_SIZE),
        ),
    )
    biblio_page = _page(
        1,
        (
            _run("References", 40, 400, 150, 412, font_size=BODY_FONT_SIZE),
            _run("1.", 40, 420, 60, 432, font_size=BODY_FONT_SIZE),
            _run(
                "Pocock SJ, Stone GW. The primary outcome fails. N Engl J Med 2016.",
                40, 440, 550, 452, font_size=BODY_FONT_SIZE,
            ),
            _run("2.", 40, 460, 60, 472, font_size=BODY_FONT_SIZE),
            _run(
                "Wallentin L, et al. Ticagrelor versus clopidogrel. N Engl J Med 2009.",
                40, 480, 550, 492, font_size=BODY_FONT_SIZE,
            ),
            _run("3.", 40, 500, 60, 512, font_size=BODY_FONT_SIZE),
            _run(
                "Carroll KJ, Fleming TR. Statistical evaluation. Stat Biopharm Res 2013.",
                40, 520, 550, 532, font_size=BODY_FONT_SIZE,
            ),
        ),
    )
    citations, mentions = detect_citations([body_page, biblio_page])
    assert {c.key for c in citations} == {"1", "2", "3"}
    assert {m.key for m in mentions} == {"1", "2", "3"}
    assert all(m.page_index == 0 for m in mentions)


# --- multi-region merging (split reference lists) ---------------------------


def test_find_heading_positions_finds_multiple_headings():
    pages = [
        _page(
            0,
            (
                _run("References", 40, 400, 150, 412),
                _run('[1] J. Smith, "A Study of Things," 2019.', 40, 420, 550, 432),
            ),
        ),
        _page(
            1,
            (
                _run("References", 40, 400, 150, 412),
                _run('[2] K. Doe, "Another Study," 2020.', 40, 420, 550, 432),
            ),
        ),
    ]
    assert _find_heading_positions(pages) == [(0, 0), (1, 0)]


def test_detect_citations_merges_main_and_methods_reference_lists():
    # Nature-family journals commonly print a "References" list for the
    # main text and a SEPARATE "References" list for the Methods section,
    # continuing the SAME citation numbering across both -- confirmed
    # against a real Nature Immunology article (entries 1-73 under one
    # heading, 74-87 under a second heading several pages later).
    main_page = _page(
        0,
        (
            _run("References", 40, 400, 150, 412),
            _run('[1] J. Smith, "A Study of Things," 2019.', 40, 420, 550, 432),
            _run('[2] K. Doe, "Another Study," 2020.', 40, 440, 550, 452),
            _run('[3] A. Lee, "A Third Study," 2021.', 40, 460, 550, 472),
        ),
    )
    methods_page = _page(
        1,
        (
            _run("References", 40, 400, 150, 412),
            _run('[4] B. Fox, "A Fourth Study," 2022.', 40, 420, 550, 432),
            _run('[5] C. Gray, "A Fifth Study," 2023.', 40, 440, 550, 452),
            _run('[6] D. Park, "A Sixth Study," 2024.', 40, 460, 550, 472),
        ),
    )
    citations, _ = detect_citations([main_page, methods_page])
    assert {c.key for c in citations} == {"1", "2", "3", "4", "5", "6"}
    by_key = {c.key: c for c in citations}
    assert by_key["4"].authors == "B. Fox"


def test_single_heading_region_trusted_regardless_of_entry_count():
    # With only one heading match there's nothing to disambiguate against
    # (no competing region a low entry count would need to lose to), so a
    # short reference list -- a real short communication/letter can have
    # very few -- is still trusted. MIN_REGION_ENTRIES only kicks in with
    # more than one heading match (see the multi-heading tests above and
    # test_detect_citations_ignores_toc_entry_and_keeps_the_real_region).
    page = _page(
        0,
        (
            _run("References", 40, 400, 150, 412),
            _run('[1] J. Smith, "A Study of Things," 2019.', 40, 420, 550, 432),
        ),
    )
    citations, _ = detect_citations([page])
    assert {c.key for c in citations} == {"1"}


# --- heading-less numeric fallback -------------------------------------------


def _yearful_numeric_run(num: int, y: float) -> TextRun:
    return _run(f"{num}. Author {num}. A real paper title. Journal {2000 + num}.", 40, y, 500, y + 12)


def test_find_headingless_numeric_run_finds_list_with_no_heading():
    # Confirmed against a real Nature article: the numbered reference list
    # has NO heading at all -- it just starts right after a lead-in
    # paragraph. Simulated here as a numbered list with no "References" run
    # anywhere in the page.
    runs = tuple(
        _yearful_numeric_run(i, 50 + i * 15) for i in range(1, MIN_HEADINGLESS_ENTRIES + 2)
    )
    result = _find_headingless_numeric_run([_page(0, runs)])
    assert result is not None
    lines, _ = result
    assert lines[0][0].startswith("1.")


def test_find_headingless_numeric_run_requires_minimum_entries():
    # Too short to trust without a heading's prior -- could be an ordinary
    # numbered list (e.g. Methods steps) rather than a bibliography.
    runs = tuple(_yearful_numeric_run(i, 50 + i * 15) for i in range(1, 4))
    assert _find_headingless_numeric_run([_page(0, runs)]) is None


def test_find_headingless_numeric_run_requires_year_fraction():
    # Long enough, but nothing looks like a real citation (no year-shaped
    # tokens anywhere) -- an ordinary numbered list, not a bibliography.
    runs = tuple(
        _run(f"{i}. Step number {i} in the procedure.", 40, 50 + i * 15, 500, 62 + i * 15)
        for i in range(1, MIN_HEADINGLESS_ENTRIES + 2)
    )
    assert _find_headingless_numeric_run([_page(0, runs)]) is None


def test_find_headingless_numeric_run_prefers_real_bibliography_over_affiliation_splice():
    # Regression test for a real bug found against a real Nature article: a
    # numbered author-affiliation list (institutions numbered 1, 2, 3...
    # matching author superscripts on the byline) is itself a plausible-
    # looking heading-less candidate. Once its own numbering runs out, the
    # sequential-numbering rule in _split_numeric_entries happily keeps
    # absorbing unrelated body text as "continuation" until it happens to
    # reach a run matching whatever number comes next -- which, since the
    # REAL bibliography contains a marker for every number 1..N, it always
    # eventually does. That splices "K affiliations + the real bibliography
    # from K+1 to N" into one candidate that ties the genuine,
    # uncontaminated candidate on final entry count AND year fraction (both
    # can land at/near 100% if the contaminating content happens to contain
    # year-shaped tokens too, as it did in the real document). The fix:
    # among candidates tied for the max count, prefer the LATEST start --
    # the genuine candidate is necessarily the latest one that still
    # reaches that count (starting any later would instead miss real
    # entries and produce a LOWER count).
    n = MIN_HEADINGLESS_ENTRIES + 3
    affiliation_runs: list[TextRun] = []
    for i in range(1, 4):
        affiliation_runs.append(_run(str(i), 40, 50 + i * 12, 60, 60 + i * 12))
        affiliation_runs.append(
            _run(f"Institution {i}, City, Country. Est. {1950 + i}.", 65, 50 + i * 12, 400, 60 + i * 12)
        )
    affiliation_page = _page(0, tuple(affiliation_runs))
    real_biblio_page = _page(
        1, tuple(_yearful_numeric_run(i, 50 + i * 15) for i in range(1, n + 1))
    )

    result = _find_headingless_numeric_run([affiliation_page, real_biblio_page])
    assert result is not None
    lines, _ = result
    assert lines[0][0] == "1. Author 1. A real paper title. Journal 2001."


def test_detect_citations_end_to_end_with_headingless_reference_list():
    n = MIN_HEADINGLESS_ENTRIES + 2
    body_page = _page(
        0,
        (
            _run(
                "as in our previous article,", 40, 50, 300, 62, font_size=BODY_FONT_SIZE
            ),
            _run("1", 300, 51, 305, 58, font_size=SUPERSCRIPT_FONT_SIZE),
            _run(" which focused on prior work.", 305, 50, 500, 62, font_size=BODY_FONT_SIZE),
        ),
    )
    biblio_page = _page(1, tuple(_yearful_numeric_run(i, 50 + i * 15) for i in range(1, n + 1)))
    citations, mentions = detect_citations([body_page, biblio_page])
    assert {c.key for c in citations} == {str(i) for i in range(1, n + 1)}
    assert any(m.key == "1" and m.page_index == 0 for m in mentions)


# --- superscript font ratio (journal-dependent) ------------------------------


def test_superscript_mention_detected_at_nature_family_font_ratio():
    # Confirmed against two real Nature-family articles: superscript
    # markers there sit at ~0.74-0.76x body size -- noticeably smaller, but
    # not as small as NEJM/Vancouver-style markers (~0.4-0.55x). The ratio
    # threshold must be wide enough to catch both clusters.
    page = _page(
        0,
        (
            _run("as in our previous article,", 40, 50, 300, 62, font_size=BODY_FONT_SIZE),
            _run("1", 300, 51, 305, 58, font_size=BODY_FONT_SIZE * 0.75),
        ),
    )
    mentions = _superscript_numeric_mentions_on_page(page, {"1"})
    assert len(mentions) == 1
    assert mentions[0].key == "1"
