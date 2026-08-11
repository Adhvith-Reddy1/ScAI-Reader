"""Citation detection: bibliography entries and their in-text mentions.

A `Citation` is one entry in a document's reference list (e.g. "[12] Smith,
J. et al. ..."). A `CitationMention` is one occurrence of that entry's marker
in the body text (e.g. the "[12]" inside a sentence). Both are keyed by
`key` — the literal marker text as it appears in the paper (a number like
"12" for numeric/IEEE-style refs, or an author-year token like "Smith2020"
for author-date style) — scoped to one `doc_id`.

Detection needs the whole document's page text (the reference list is a
distinct section, usually at the end, and mentions are scattered across
every page), unlike figure detection which only needs one page at a time.

Approach, in four stages:

  1. Find every "References"/"Bibliography"/"Works Cited" heading (own line,
     case-insensitive — see `_SECTION_HEADING_PATTERN`) in the document, not
     just one — a paper can legitimately have more than one (confirmed
     against a real Nature Immunology article: a "References" section for
     the main text, entries 1-73, then a SEPARATE "References" section
     after the Methods section, entries 74-87, continuing the same number
     sequence — this is documented Nature-family house style, not a one-off).
     Each heading bounds a candidate region running to the next heading (or
     a trailing back-matter section, or the document end). A region is only
     trusted once it's shown to contain a real, sequential run of entries
     (see `MIN_REGION_ENTRIES`) — this is what keeps a table of contents'
     own "References....36" line (which frequently extracts as a bare
     "References" run, the dot-leader and page number landing in separate
     runs) from being mistaken for the section itself.
  2. If no heading yields a trustworthy region, fall back to scanning the
     whole document for a heading-less numbered list: some journals
     (confirmed against a real Nature article) print the reference list
     with NO heading at all — the numbering just starts right after a
     fixed lead-in paragraph ("Online content ... are available at
     https://doi.org/..."). See `_find_headingless_numeric_run`.
  3. Decide which of the two dominant reference-list styles the document
     uses by counting how many bibliography lines (across all trusted
     regions combined) look like each style's entry-start marker
     (`_NUMERIC_ENTRY_START` vs `_AUTHOR_YEAR_ENTRY_START`) and picking the
     more common one — real papers don't mix styles within one reference
     list, so the majority vote is reliable, and it lets a single simple
     splitter run over each region instead of guessing per-entry.
     `authors`/`title`/`year` are extracted best-effort from each entry's
     text; fields we can't confidently pull out (venue, doi, or anything
     when the expected delimiter is simply absent) are left None rather
     than guessed. Citations from every trusted region are merged into one
     list (deduped by key, first region wins on a collision).
  4. Scan every page's text, EXCLUDING every trusted bibliography region,
     for mentions of the resulting citation keys — numeric bracket markers
     (with range/list expansion), bare superscript numbers (some journals,
     e.g. NEJM/JAMA/Lancet/Nature, render markers as a small-font number
     with no brackets — see `_superscript_numeric_mentions_on_page`), or
     author-year parenthetical/narrative citations — and keep only the
     ones whose key matches a real bibliography entry, so stray bracketed/
     superscript numbers or capitalized-word-then-parenthesis text
     elsewhere on the page can't produce phantom mentions. Excluding the
     bibliography region(s) matters for numeric style in particular:
     without it, each entry's own "[12]" marker would register as a
     mention of itself.

Only one style is detected per document, and only the common in-text forms
described in the module's own docstring are matched — see the "false
positives / not handled" notes near each pattern for the specific tradeoffs.
See docs/citation-styles-spec.md (repo root) for the underlying research
this module's heuristics are based on, and for patterns deliberately left
unhandled (e.g. a supplementary reference list with its own independent,
restarting numbering, or PNAS-style bare parenthetical "(12)" mentions).
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass

from .types import BBox, PageText, TextRun


@dataclass(frozen=True)
class Citation:
    key: str
    raw_text: str
    page_index: int
    authors: str | None = None
    title: str | None = None
    year: str | None = None
    venue: str | None = None
    doi: str | None = None


@dataclass(frozen=True)
class CitationMention:
    key: str
    page_index: int
    bbox: BBox


# --- bibliography heading -------------------------------------------------

# The heading is virtually always alone on its own line (optionally prefixed
# by a section number, e.g. "7. References"), which is why this matches the
# WHOLE run text (anchored both ends) rather than just a prefix like
# figures.py's CAPTION_PATTERN does — a heading followed by more prose on
# the same run/line is a false match risk (e.g. "References [12] and [13]
# support this claim" inside a sentence), and requiring the full line to be
# just the heading avoids it at the cost of missing the rare paper that runs
# the heading and first entry together in one text run.
_SECTION_HEADING_PATTERN = re.compile(
    r"^\s*(?:\d+[.\)]?\s+)?(References|Bibliography|Works\s+Cited)\s*[:.]?\s*$",
    re.IGNORECASE,
)

# A reference list is occasionally followed by other back-matter sections
# (Appendix, Acknowledgments, ...) on the same or later pages. Once we've
# already collected at least one bibliography line, treating one of these as
# a hard stop keeps that back matter out of the last reference entry instead
# of silently appending it as a very long "continuation". This pattern
# tolerates the heading sharing a run with following prose (a prefix match) —
# fine for words that essentially never start an ordinary sentence or
# citation title. `_TRAILING_SECTION_EXACT_PATTERN` below is for words common
# enough as ordinary sentence-openers (e.g. "Methods...") that a prefix match
# would risk cutting a bibliography off mid-list.
_TRAILING_SECTION_PATTERN = re.compile(
    r"^\s*(Appendix|Supplementary\s+Material|Author\s+Contributions?|"
    r"Acknowledge?ments?|Conflicts?\s+of\s+Interest)\b",
    re.IGNORECASE,
)
# Nature-family back-matter headings that follow a reference list (confirmed
# against a real Nature article's PDF text) — anchored as a full line, unlike
# `_TRAILING_SECTION_PATTERN` above, since e.g. "Methods" is common enough to
# open an ordinary reference title that a bare prefix match is too risky.
# This matters most for the heading-less fallback (`_find_headingless_numeric_run`):
# without a heading to mark where the reference list started, nothing else
# stops it from absorbing an unrelated Methods section's own numbered list as
# "continuation text" of the last real entry.
_TRAILING_SECTION_EXACT_PATTERN = re.compile(
    r"^\s*((Online\s+)?Methods|Data\s+Availability|Code\s+Availability|"
    r"Reporting\s+Summary|Competing\s+Interests?|Publisher.s\s+Note|Open\s+Access)"
    r"\s*[:.]?\s*$",
    re.IGNORECASE,
)


def _find_heading_positions(pages: list[PageText]) -> list[tuple[int, int]]:
    """(page position, run index) of every References/Bibliography/Works
    Cited heading in the document, in document order. A paper can
    legitimately have more than one: Nature-family journals commonly print
    a "References" list for the main text and a SEPARATE, later
    "References" list for the Methods section, continuing the SAME citation
    numbering across both (confirmed against a real Nature Immunology
    article: entries 1-73 under a heading on one page, 74-87 under another
    "References" heading several pages later — and documented Nature-family
    house style, not a one-off). `detect_citations` processes each heading's
    region independently and merges the results — picking only "the first"
    heading would miss the second list; picking only "the last" (this
    function's prior behavior) would miss the first. A table of contents'
    own "References....36" line, which frequently extracts as a bare
    "References" run with the dot-leader and page number in separate runs,
    also shows up here — it's filtered out downstream by requiring a region
    to actually contain a real, sequential run of entries (see
    MIN_REGION_ENTRIES) rather than by position."""
    found: list[tuple[int, int]] = []
    for page_pos, page in enumerate(pages):
        for run_idx, run in enumerate(page.runs):
            if _SECTION_HEADING_PATTERN.match(run.text.strip()):
                found.append((page_pos, run_idx))
    return found


def _collect_bibliography_lines(
    pages: list[PageText],
    start_page_pos: int,
    start_run_idx: int,
    stop_before: tuple[int, int] | None = None,
) -> tuple[list[tuple[str, int]], set[int]]:
    """(text, page_index) for every non-blank run starting at
    (start_page_pos, start_run_idx + 1) up to (but not including)
    `stop_before` if given, else through the end of the document — stopping
    early either way if a trailing back-matter section heading shows up
    after we've already collected some bibliography content (see
    `_TRAILING_SECTION_PATTERN`/`_TRAILING_SECTION_EXACT_PATTERN`).
    `stop_before` bounds one region to end where the NEXT heading starts,
    for documents with more than one reference list (see
    `_find_heading_positions`) — pass `start_run_idx - 1` to start
    INCLUDING a given run instead of after it (used by the heading-less
    fallback, which has no heading run to exclude). Also returns the
    `id()` of every run consumed this way, so the caller can exclude the
    reference list's own entry markers from in-text mention scanning — left
    in, a numeric entry's own "[12]" would otherwise show up as a "mention"
    of itself."""
    lines: list[tuple[str, int]] = []
    excluded: set[int] = set()
    stop_page_pos, stop_run_idx = stop_before if stop_before else (None, None)
    for offset, page in enumerate(pages[start_page_pos:]):
        page_pos = start_page_pos + offset
        if stop_page_pos is not None and page_pos > stop_page_pos:
            break
        run_base_idx = start_run_idx + 1 if offset == 0 else 0
        for local_idx, run in enumerate(page.runs[run_base_idx:]):
            run_idx = run_base_idx + local_idx
            if (
                stop_page_pos is not None
                and page_pos == stop_page_pos
                and run_idx >= stop_run_idx
            ):
                return lines, excluded
            text = run.text.strip()
            if not text:
                continue
            if lines and (
                _TRAILING_SECTION_PATTERN.match(text)
                or _TRAILING_SECTION_EXACT_PATTERN.match(text)
            ):
                return lines, excluded
            lines.append((text, page.page_index))
            excluded.add(id(run))
    return lines, excluded


def _pages_excluding_runs(
    pages: list[PageText], excluded_ids: set[int]
) -> list[PageText]:
    """`pages` with every run in `excluded_ids` removed — used to keep the
    bibliography section itself out of in-text mention scanning."""
    if not excluded_ids:
        return pages
    out: list[PageText] = []
    for page in pages:
        if not any(id(r) in excluded_ids for r in page.runs):
            out.append(page)
            continue
        filtered = tuple(r for r in page.runs if id(r) not in excluded_ids)
        out.append(PageText(page_index=page.page_index, runs=filtered, columns=()))
    return out


# --- entry splitting: numeric style ("[1] ..." / "1. ...") ---------------

# Two marker shapes cover the vast majority of numeric/IEEE-style lists:
# bracketed ("[12] Smith, ...") and dotted ("12. Smith, ..."). The dotted
# form requires either a capital letter right after the marker on the same
# line (an author name always starts capitalized) or nothing at all after
# it. The latter covers a common hanging-indent PDF layout where the number
# is its own text run/line and the entry's text starts on the next one
# (confirmed against real NEJM/JAMA-style references, where "1." and
# "Pocock SJ, ..." extract as two separate runs) — a marker-only run is
# never a coincidental mid-sentence artifact, so relaxing the lookahead for
# it doesn't reopen the false-positive risk the capital-letter check guards
# against elsewhere: an ordinary sentence that happens to open with a number
# ("2020 was...") on a wrapped continuation line isn't mistaken for a new
# entry when text follows on the same run. This doesn't fully eliminate that
# risk (a continuation line starting "1990s span..." would still slip
# through) but handles the common case.
#
# The third alternative (bare digits, no period at all) covers an even more
# fragmented layout, confirmed against a real document, where the marker's
# own period lands in a THIRD separate run ("88" then "." as two more runs
# after the number) -- too fragmented to fold into the dotted pattern above.
# On its own this would be far too permissive (any isolated page/volume
# number could match), but `_split_numeric_entries`'s sequential-numbering
# check is what actually keeps it safe: a bare-digit "marker" is only ever
# accepted if it's exactly one more than the last accepted entry number.
_NUMERIC_ENTRY_START = re.compile(
    r"^\[(?P<num1>\d{1,4})\]\s*"
    r"|^(?P<num2>\d{1,4})\.(?:\s+(?=[A-Z])|\s*$)"
    r"|^(?P<num3>\d{1,4})$"
)


def _split_numeric_entries(
    lines: list[tuple[str, int]],
) -> list[dict]:
    """Group bibliography lines into entries, one per numeric marker. Lines
    without a marker are continuations of the previous entry (a wrapped
    reference, e.g. a long title spilling onto a second line).

    A numbered reference list is always strictly sequential (1, 2, 3, ...,
    N) with no gaps or repeats, so once a first marker is accepted, any
    later "marker" match is only treated as a real new entry if its number
    is exactly one more than the last accepted one — otherwise it's folded
    into the current entry as a continuation line instead. This matters
    because the marker-only case in `_NUMERIC_ENTRY_START` (needed for
    hanging-indent layouts) would otherwise also catch stray numbers that
    happen to land alone on their own run mid-entry (a page/volume number
    split across a line wrap, e.g. "...p. 1261-70." breaking after "1261.")
    — those never continue the sequence, so the +1 check rejects them.
    """
    entries: list[dict] = []
    current: dict | None = None
    expected_next: int | None = None
    for text, page_index in lines:
        m = _NUMERIC_ENTRY_START.match(text)
        num_int = (
            int(m.group("num1") or m.group("num2") or m.group("num3")) if m else None
        )
        if m and (expected_next is None or num_int == expected_next):
            if current is not None:
                entries.append(current)
            current = {"num": str(num_int), "parts": [text], "page_index": page_index}
            expected_next = num_int + 1
        elif current is not None:
            current["parts"].append(text)
    if current is not None:
        entries.append(current)
    return entries


_QUOTED_TITLE_PATTERN = re.compile(r'["“](?P<title>[^"”]+)["”]')
_YEAR_TOKEN_PATTERN = re.compile(r"\b(?:19|20)\d{2}\b")


def _extract_numeric_authors_title(
    content: str,
) -> tuple[str | None, str | None]:
    """Numeric-style entries (IEEE/ACM) conventionally quote the title
    ('J. Smith, "Title," in Proc. ...'); everything before the opening quote
    is the author list. Without a quoted title there's no reliable delimiter
    between authors and the rest of the entry, so both are left None rather
    than guessed."""
    m = _QUOTED_TITLE_PATTERN.search(content)
    if not m:
        return None, None
    authors = content[: m.start()].strip().rstrip(",").strip() or None
    title = m.group("title").strip().rstrip(",").strip() or None
    return authors, title


def _extract_year_numeric(content: str) -> str | None:
    """The LAST 4-digit year-shaped token in the entry — numeric-style
    entries usually place the publication year near the end (after the
    venue), so the last match is a better bet than the first (which could be
    a volume/page number that happens to look year-shaped, e.g. "vol. 19").
    """
    years = [m.group(0) for m in _YEAR_TOKEN_PATTERN.finditer(content)]
    return years[-1] if years else None


def _build_numeric_citations(lines: list[tuple[str, int]]) -> list[Citation]:
    entries = _split_numeric_entries(lines)
    citations: list[Citation] = []
    seen: set[str] = set()
    for entry in entries:
        num = entry["num"]
        if num in seen:
            continue  # duplicate marker (e.g. text-extraction glitch) — keep the first
        seen.add(num)
        raw_text = " ".join(entry["parts"]).strip()
        content = _NUMERIC_ENTRY_START.sub("", raw_text, count=1).strip()
        authors, title = _extract_numeric_authors_title(content)
        year = _extract_year_numeric(content)
        citations.append(
            Citation(
                key=num,
                raw_text=raw_text,
                page_index=entry["page_index"],
                authors=authors,
                title=title,
                year=year,
            )
        )
    return citations


# --- entry splitting: author-year style ("Smith, J. (2020). ...") --------

# A new entry starts where a line opens with a capitalized surname followed
# by a comma and another capitalized token (an initial) — "Smith, J."
# Author-year reference lists don't carry an explicit per-entry marker the
# way numeric lists do, so this is the best generally-available heuristic;
# it can misfire on an entry whose FIRST author has a lowercase-prefixed
# surname ("van der Berg, J.") or on a continuation line that coincidentally
# starts the same way, which is a deliberately accepted gap in scope.
_AUTHOR_YEAR_ENTRY_START = re.compile(r"^(?P<surname>[A-Z][A-Za-z'\-]+),\s*[A-Z]")

_PAREN_YEAR_PATTERN = re.compile(r"\((?P<year>(?:19|20)\d{2})[a-z]?\)")


def _split_author_year_entries(lines: list[tuple[str, int]]) -> list[dict]:
    entries: list[dict] = []
    current: dict | None = None
    for text, page_index in lines:
        m = _AUTHOR_YEAR_ENTRY_START.match(text)
        if m:
            if current is not None:
                entries.append(current)
            current = {
                "surname": m.group("surname"),
                "parts": [text],
                "page_index": page_index,
            }
        elif current is not None:
            current["parts"].append(text)
    if current is not None:
        entries.append(current)
    return entries


def _extract_year_author(content: str) -> str | None:
    m = _PAREN_YEAR_PATTERN.search(content)
    return m.group("year") if m else None


def _extract_author_year_title(content: str) -> str | None:
    """The title conventionally follows the "(year)." parenthetical as its
    own sentence: "Smith, J. (2020). Title of the paper. Venue, ...". Take
    the text up to the next period; if the year parenthetical isn't found at
    all, there's nothing reliable to anchor on, so no title is returned."""
    m = _PAREN_YEAR_PATTERN.search(content)
    if not m:
        return None
    remainder = content[m.end() :].lstrip(". ").strip()
    tm = re.match(r"(?P<title>[^.]+)\.", remainder)
    return tm.group("title").strip() if tm and tm.group("title").strip() else None


def _build_author_year_citations(lines: list[tuple[str, int]]) -> list[Citation]:
    entries = _split_author_year_entries(lines)
    citations: list[Citation] = []
    seen: set[str] = set()
    for entry in entries:
        content = " ".join(entry["parts"]).strip()
        year = _extract_year_author(content)
        if year is None:
            # Without a year we can't build a stable key (and can't
            # distinguish this from a bad split), so skip rather than guess.
            continue
        key = f"{entry['surname']}{year}"
        if key in seen:
            continue
        seen.add(key)
        m = _PAREN_YEAR_PATTERN.search(content)
        authors = content[: m.start()].strip().rstrip(",").strip() or None
        title = _extract_author_year_title(content)
        citations.append(
            Citation(
                key=key,
                raw_text=content,
                page_index=entry["page_index"],
                authors=authors,
                title=title,
                year=year,
            )
        )
    return citations


# --- in-text mention scanning ---------------------------------------------
#
# Mentions are found on the concatenated per-page plain text (`PageText.plain`
# — the runs joined in their given order, same as figures.py implicitly
# assumes runs already correspond to reading order) so a marker split across
# multiple text runs (e.g. "[" / "12" / "]" as separate runs from a font or
# style change) is still matched as one marker; the bbox is then recovered by
# mapping the match's character span back to whichever run(s) overlap it and
# unioning their boxes.


def _run_offsets(page: PageText) -> list[tuple[int, int, TextRun]]:
    """[(start, end, run), ...] character offsets of each run within
    `page.plain` (which is exactly the runs concatenated in this order)."""
    offsets: list[tuple[int, int, TextRun]] = []
    pos = 0
    for run in page.runs:
        end = pos + len(run.text)
        offsets.append((pos, end, run))
        pos = end
    return offsets


def _bbox_for_span(
    offsets: list[tuple[int, int, TextRun]], start: int, end: int
) -> BBox | None:
    runs_in_span = [run for s, e, run in offsets if e > start and s < end]
    if not runs_in_span:
        return None
    return BBox(
        x0=min(r.bbox.x0 for r in runs_in_span),
        y0=min(r.bbox.y0 for r in runs_in_span),
        x1=max(r.bbox.x1 for r in runs_in_span),
        y1=max(r.bbox.y1 for r in runs_in_span),
    )


# Numeric mentions: "[12]" (single), "[3, 7]" / "[3,7]" (list), "[3-5]"
# (range inside one bracket pair), or "[3]-[5]" / "[3]–[5]" (range spelled
# as two separate bracket pairs). The two-bracket form is checked first
# since it's a stricter, more specific shape; the single-bracket form (whose
# body can itself mix commas and dashes, e.g. "[3, 5-7]") is the fallback.
_NUMERIC_MENTION_PATTERN = re.compile(
    r"\[(?P<start>\d{1,4})\]\s*[-–—]\s*\[(?P<end>\d{1,4})\]"
    r"|\[(?P<body>\d{1,4}(?:\s*[,;\-–—]\s*\d{1,4})*)\]"
)

# A range wider than this is almost certainly a mis-parsed page/volume
# number rather than a real citation range — no real paper cites 50+
# consecutive references as one span.
MAX_RANGE_EXPANSION = 50


def _expand_range(a: str, b: str) -> list[str]:
    lo, hi = int(a), int(b)
    if hi < lo or hi - lo > MAX_RANGE_EXPANSION:
        return []
    return [str(n) for n in range(lo, hi + 1)]


def _keys_from_digit_list(body: str) -> list[str]:
    """Split a comma/semicolon-separated digit-group string into individual
    keys, expanding any embedded ranges ("5-7") -- shared by the bracketed
    and superscript numeric-mention scanners."""
    keys: list[str] = []
    for token in re.split(r"[,;]", body):
        token = token.strip()
        if not token:
            continue
        range_m = re.match(r"^(\d{1,4})\s*[-–—]\s*(\d{1,4})$", token)
        if range_m:
            keys.extend(_expand_range(range_m.group(1), range_m.group(2)))
        else:
            keys.append(token)
    return keys


def _numeric_keys_in_match(m: re.Match) -> list[str]:
    if m.group("start") is not None:
        return _expand_range(m.group("start"), m.group("end"))
    return _keys_from_digit_list(m.group("body"))


def _numeric_mentions_on_page(
    page: PageText, keys: set[str]
) -> list[CitationMention]:
    offsets = _run_offsets(page)
    out: list[CitationMention] = []
    for m in _NUMERIC_MENTION_PATTERN.finditer(page.plain):
        matched_keys = [k for k in _numeric_keys_in_match(m) if k in keys]
        if not matched_keys:
            continue
        bbox = _bbox_for_span(offsets, m.start(), m.end())
        if bbox is None:
            continue
        out.extend(
            CitationMention(key=k, page_index=page.page_index, bbox=bbox)
            for k in matched_keys
        )
    return out


# Superscript numeric mentions: some numeric-style journals (NEJM, JAMA,
# Lancet, Nature-family, ...) render in-text markers as bare superscript
# numbers with no enclosing brackets -- "...our previous article,1 which
# focused..." or "...the PLATO trial21,22 involving...". PDFium extracts a
# superscript as its own TextRun, in a meaningfully smaller font-size than
# the body text it's attached to, and occasionally bleeds one stray trailing
# glyph from the previous run into it when the two runs' rects overlap at
# the size-change boundary (e.g. "y2" for a marker glued after "...mortality")
# -- hence allowing up to two leading letters in the pattern below. Matching
# on (small relative font-size) + (digit-list-only content) + (key exists in
# the parsed bibliography) keeps this from firing on ordinary small-font
# text (page numbers, running headers): those either fail the digit-list
# shape (e.g. "375;10") or fail to match a real bibliography key, the same
# safety net `_numeric_mentions_on_page` relies on. One accepted gap: a
# footer page number that is BOTH small-font AND numerically equal to a real
# reference key (e.g. page "5" in a paper with a reference 5) can still slip
# through as a false positive.
_SUPERSCRIPT_MARKER_PATTERN = re.compile(
    r"^[A-Za-z]{0,2}(?P<body>\d{1,4}(?:\s*,\s*\d{1,4})*)\s*$"
)

# The superscript-to-body font ratio varies more by journal than a single
# tight number suggests: NEJM/Vancouver-style markers observed at ~0.4-0.55x
# body size, but Nature-family markers confirmed (against two real Nature
# articles) at ~0.74-0.76x -- comfortably smaller than body text, but not by
# as much. Set wide enough to catch both clusters with margin, while staying
# meaningfully below 1.0 so it doesn't start matching ordinary same-size text.
_SUPERSCRIPT_FONT_RATIO = 0.8

# Runs shorter than this many characters are too often ligature/spacer
# artifacts (single control characters, hyphenation glyphs) to anchor a
# reliable "body font size" estimate for the page -- only longer runs count.
_MIN_BODY_RUN_CHARS = 4


def _page_body_font_size(page: PageText) -> float | None:
    """The most common font-size among the page's substantial text runs --
    an estimate of the prevailing body-text size, against which a
    superscript marker's font is compared."""
    sizes = [
        round(r.font_size, 1) for r in page.runs if len(r.text.strip()) >= _MIN_BODY_RUN_CHARS
    ]
    if not sizes:
        return None
    return Counter(sizes).most_common(1)[0][0]


# A byline listing several authors' institutional affiliations ("Ang
# Cui1,2,12, Teddy Huang3, Shuqiang Li2,3, ...", confirmed against a real
# Nature article's page 1) is, glyph-for-glyph, indistinguishable from a
# citation superscript: small font, digit-only, and the numbers routinely
# fall within a real bibliography's 1..N key range by sheer coincidence (a
# paper with 39 references and a large author list is likely to have SOME
# affiliation number in 1-39). What sets a byline apart structurally is
# density: real in-text citations are scattered one or two to a line across
# a whole page of prose, while an affiliation list crams many small numbers
# onto the SAME baseline in a row (confirmed: 13 and 11 respectively on the
# two byline lines of that real article, vs. at most 2 anywhere else on the
# same page). Rows past this bar are treated as a non-prose numbered list
# and dropped entirely rather than risk resolving to the wrong reference.
_MAX_SUPERSCRIPT_MATCHES_PER_ROW = 4


def _superscript_numeric_mentions_on_page(
    page: PageText, keys: set[str]
) -> list[CitationMention]:
    body_size = _page_body_font_size(page)
    if body_size is None:
        return []
    threshold = body_size * _SUPERSCRIPT_FONT_RATIO
    candidates: list[tuple[str, BBox]] = []
    for run in page.runs:
        if run.font_size >= threshold:
            continue
        text = run.text.strip()
        if not text:
            continue
        m = _SUPERSCRIPT_MARKER_PATTERN.match(text)
        if not m:
            continue
        for k in _keys_from_digit_list(m.group("body")):
            if k in keys:
                candidates.append((k, run.bbox))

    rows: dict[int, int] = {}
    for _, bbox in candidates:
        row = round(bbox.y0)
        rows[row] = rows.get(row, 0) + 1

    return [
        CitationMention(key=k, page_index=page.page_index, bbox=bbox)
        for k, bbox in candidates
        if rows[round(bbox.y0)] <= _MAX_SUPERSCRIPT_MATCHES_PER_ROW
    ]


def _all_numeric_mentions_on_page(
    page: PageText, keys: set[str]
) -> list[CitationMention]:
    return _numeric_mentions_on_page(page, keys) + _superscript_numeric_mentions_on_page(
        page, keys
    )


# Author-year mentions: parenthetical ("(Smith, 2020)", "(Smith & Doe,
# 2020)", "(Smith et al., 2020)") and narrative ("Smith (2020)"). Only the
# FIRST author's surname is used to build the lookup key (matching how
# `_build_author_year_citations` keys entries off the first author too), so
# a multi-author mention still resolves to the right entry. Compound
# citations sharing one set of parens ("(Smith, 2020; Doe, 2019)") are not
# split into two mentions — a deliberately out-of-scope case.
_MENTION_AUTHORS = r"[A-Z][A-Za-z'\-]+(?:\s*(?:&|and)\s*[A-Z][A-Za-z'\-]+)?(?:\s+et\s+al\.?)?"
_AUTHOR_YEAR_PAREN_PATTERN = re.compile(
    r"\((?P<authors>" + _MENTION_AUTHORS + r"),\s*(?P<year>(?:19|20)\d{2})[a-z]?\)"
)
_AUTHOR_YEAR_NARRATIVE_PATTERN = re.compile(
    r"\b(?P<authors>[A-Z][A-Za-z'\-]+)\s*\(\s*(?P<year>(?:19|20)\d{2})[a-z]?\s*\)"
)


def _first_surname(authors_text: str) -> str:
    word = authors_text.strip().split()[0]
    return re.sub(r"[^A-Za-z'\-]", "", word)


def _author_year_mentions_on_page(
    page: PageText, keys: set[str]
) -> list[CitationMention]:
    offsets = _run_offsets(page)
    out: list[CitationMention] = []
    for pattern in (_AUTHOR_YEAR_PAREN_PATTERN, _AUTHOR_YEAR_NARRATIVE_PATTERN):
        for m in pattern.finditer(page.plain):
            key = f"{_first_surname(m.group('authors'))}{m.group('year')}"
            if key not in keys:
                continue
            bbox = _bbox_for_span(offsets, m.start(), m.end())
            if bbox is None:
                continue
            out.append(
                CitationMention(key=key, page_index=page.page_index, bbox=bbox)
            )
    return out


# --- multi-region merging ---------------------------------------------------
#
# A document can have more than one physical reference list that together
# make up its bibliography (see `_find_heading_positions`). Each heading's
# region is collected and built independently, then merged — this is what
# lets a region that turns out to be junk (a table of contents' own
# "References" line) be silently dropped instead of poisoning the whole
# result, while a region that's a real second reference list (Methods)
# still contributes its entries.

# When there's more than one heading candidate, a region's entry count must
# clear this bar to be trusted as a real bibliography rather than e.g. a
# table-of-contents line's own "References" entry (whose "region" — explored
# the same way, bounded by the next heading — is just ordinary body text
# between it and that next heading; real prose essentially never contains
# this many coincidentally-sequential numeric or author-year entry-start-
# shaped lines in a row). Only applied when there's something to disambiguate
# BETWEEN, though: a document with exactly one heading match is trusted with
# however many entries it has (down to the existing "at least one" floor) —
# real short papers/letters can have very few references, and there's no
# competing candidate here for a count threshold to be discriminating against.
MIN_REGION_ENTRIES = 3


def _citations_from_regions(
    region_lines: list[tuple[list[tuple[str, int]], set[int]]],
):
    """Vote for ONE style across all heading-bounded regions combined (a
    document uses one reference-list style throughout, even split across
    more than one physical list), build each region separately with that
    style's splitter, and keep + merge only the regions with enough entries
    to trust as a real bibliography (see MIN_REGION_ENTRIES). Returns
    (citations, excluded_run_ids, scan_page_fn)."""
    all_lines = [line for lines, _ in region_lines for line in lines]
    numeric_hits = sum(1 for text, _ in all_lines if _NUMERIC_ENTRY_START.match(text))
    author_hits = sum(1 for text, _ in all_lines if _AUTHOR_YEAR_ENTRY_START.match(text))
    if numeric_hits == 0 and author_hits == 0:
        return [], set(), _all_numeric_mentions_on_page

    if numeric_hits >= author_hits:
        build = _build_numeric_citations
        scan_page = _all_numeric_mentions_on_page
    else:
        build = _build_author_year_citations
        scan_page = _author_year_mentions_on_page

    min_entries = MIN_REGION_ENTRIES if len(region_lines) > 1 else 1
    merged: dict[str, Citation] = {}
    excluded_ids: set[int] = set()
    for lines, excluded in region_lines:
        region_citations = build(lines)
        if len(region_citations) < min_entries:
            continue
        excluded_ids |= excluded
        for c in region_citations:
            merged.setdefault(c.key, c)
    return list(merged.values()), excluded_ids, scan_page


# --- heading-less fallback ---------------------------------------------------

# Higher than MIN_REGION_ENTRIES: a heading-less candidate has no heading to
# vouch for it, so it needs more evidence before being trusted — an ordinary
# numbered list elsewhere in the document (Methods steps, a numbered figure
# list) can also start at 1 and run for a few entries.
MIN_HEADINGLESS_ENTRIES = 8
# Most of a real bibliography's entries contain a publication-year-shaped
# token; an ordinary numbered list generally doesn't. Set high (not just
# "more than half"): confirmed against a real Nature article that a numbered
# author-affiliation list (institutions numbered 1, 2, 3... matching author
# superscripts on the byline) is itself a plausible-looking candidate, and
# once its own numbering runs out, the sequential-numbering rule in
# `_split_numeric_entries` will happily keep absorbing unrelated body text as
# "continuation" until it happens to reach a run matching whatever number
# comes next — which, if that number is anywhere in 1..N, it always
# eventually will, because the REAL bibliography contains a marker for every
# number 1..N by construction. That's not a rare coincidence to defend
# against occasionally, it's close to guaranteed: a false candidate that
# stops incrementing at K will always eventually resync with the real list's
# own entry K once collection reaches it, silently splicing "K affiliations
# + a real bibliography from K+1 to N" into one candidate that LOOKS
# complete (no gaps, plausible entry count) but has garbage content for its
# first K entries. A high year-fraction bar is what actually catches this:
# the spliced candidate's early (affiliation) entries never have a year, so
# its overall fraction comes in well below a genuine bibliography's — in the
# real case that surfaced this, 66.7% (26 real entries out of a spliced 39)
# vs. a clean candidate's ~100%.
MIN_HEADINGLESS_YEAR_FRACTION = 0.85


def _find_headingless_numeric_run(
    pages: list[PageText],
) -> tuple[list[tuple[str, int]], set[int]] | None:
    """Fallback when no References/Bibliography heading yields a trustworthy
    region at all — confirmed against a real Nature article, whose numbered
    reference list has no heading whatsoever; the numbering just starts
    right after a lead-in paragraph ("Online content ... are available at
    https://doi.org/..."). Scans the whole document for every position a
    numbered list could start at 1, builds a candidate region from each
    (bounded the same way a heading-based region is, via the trailing-
    section patterns — this is what stops a candidate from absorbing an
    unrelated Methods section's own numbered list), and — since there's no
    heading's prior to lean on — only trusts a candidate that clears both
    MIN_HEADINGLESS_ENTRIES and MIN_HEADINGLESS_YEAR_FRACTION.

    Among qualifying candidates, picks by (entry_count, start_position) —
    the MOST entries, and among ties for that, the LATEST start. This isn't
    just a tiebreak convenience: confirmed against the real Nature article
    that surfaced the affiliation-splice problem, MULTIPLE contaminated
    candidates (an author-affiliation list, several figure-legend numbered
    label sequences) all independently spliced onto the SAME real
    bibliography tail and landed on the exact same final entry count with a
    perfect 100% year fraction — tying with the genuine candidate (which
    starts exactly at the bibliography's own "1.") on both count and
    fraction. What breaks the tie correctly is position: every contaminated
    candidate, by construction, starts BEFORE the genuine one (it has to,
    to include the unrelated "prefix" it splices from) and can never start
    after it while still reaching the same final count — starting later
    than the true beginning would instead miss real entries and produce a
    LOWER count. So among candidates tied for the max count, the latest
    start is never the contaminated one; it's the exact place where the
    real list begins, and any well-formed bibliography converging to a
    lower count is naturally excluded by preferring the max count first."""
    candidates: list[tuple[int, int]] = []
    for page_pos, page in enumerate(pages):
        for run_idx, run in enumerate(page.runs):
            m = _NUMERIC_ENTRY_START.match(run.text.strip())
            if not m:
                continue
            num = m.group("num1") or m.group("num2") or m.group("num3")
            if num == "1":
                candidates.append((page_pos, run_idx))

    best: tuple[list[tuple[str, int]], set[int]] | None = None
    best_entry_count = 0
    for page_pos, run_idx in candidates:
        # `run_idx - 1` so _collect_bibliography_lines's `+ 1` offset lands
        # exactly on this candidate run, including it (there's no heading
        # run before it to exclude, unlike the heading-based path).
        lines, excluded = _collect_bibliography_lines(pages, page_pos, run_idx - 1)
        if not lines:
            continue
        entries = _split_numeric_entries(lines)
        if len(entries) < MIN_HEADINGLESS_ENTRIES:
            continue
        with_year = sum(
            1 for e in entries if _YEAR_TOKEN_PATTERN.search(" ".join(e["parts"]))
        )
        if with_year / len(entries) < MIN_HEADINGLESS_YEAR_FRACTION:
            continue
        # >=, not >: candidates are visited in document order, so an equal
        # count keeps overwriting `best` with the latest-starting one — see
        # the docstring for why that's the correct tiebreak, not an
        # arbitrary one.
        if len(entries) >= best_entry_count:
            best = (lines, excluded)
            best_entry_count = len(entries)
    return best


# --- entry point ------------------------------------------------------------


def detect_citations(
    pages: list[PageText],
) -> tuple[list[Citation], list[CitationMention]]:
    """Parse a document's reference list(s) and locate in-text mentions of
    each entry. `pages` must be every page of the document, in order
    (page_index 0-based, matching `PageText.page_index`)."""
    heading_positions = _find_heading_positions(pages)

    region_lines: list[tuple[list[tuple[str, int]], set[int]]] = []
    for i, (page_pos, run_idx) in enumerate(heading_positions):
        stop = heading_positions[i + 1] if i + 1 < len(heading_positions) else None
        lines, excluded = _collect_bibliography_lines(pages, page_pos, run_idx, stop)
        excluded.add(id(pages[page_pos].runs[run_idx]))
        region_lines.append((lines, excluded))

    citations, excluded_ids, scan_page = _citations_from_regions(region_lines)

    if not citations:
        headingless = _find_headingless_numeric_run(pages)
        if headingless is None:
            return [], []
        lines, excluded_ids = headingless
        citations = _build_numeric_citations(lines)
        scan_page = _all_numeric_mentions_on_page

    if not citations:
        return [], []

    keys = {c.key for c in citations}
    mentions: list[CitationMention] = []
    for page in _pages_excluding_runs(pages, excluded_ids):
        mentions.extend(scan_page(page, keys))

    return citations, mentions
