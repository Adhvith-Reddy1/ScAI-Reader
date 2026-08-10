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

Approach, in three stages:

  1. Find the "References"/"Bibliography"/"Works Cited" heading (own line,
     case-insensitive — see `_SECTION_HEADING_PATTERN`) and collect every
     run of text after it, across all remaining pages, as the bibliography
     region.
  2. Decide which of the two dominant reference-list styles the document
     uses by counting how many bibliography lines look like each style's
     entry-start marker (`_NUMERIC_ENTRY_START` vs `_AUTHOR_YEAR_ENTRY_START`)
     and picking the more common one — real papers don't mix styles within
     one reference list, so the majority vote is reliable, and it lets a
     single simple splitter run over the whole section instead of guessing
     per-entry. `authors`/`title`/`year` are extracted best-effort from each
     entry's text; fields we can't confidently pull out (venue, doi, or
     anything when the expected delimiter is simply absent) are left None
     rather than guessed.
  3. Scan every page's text, EXCLUDING the bibliography section itself, for
     mentions of the resulting citation keys — numeric bracket markers (with
     range/list expansion) or author-year parenthetical/narrative citations
     — and keep only the ones whose key matches a real bibliography entry,
     so stray bracketed numbers or capitalized-word-then-parenthesis text
     elsewhere on the page can't produce phantom mentions. Excluding the
     bibliography region itself matters for numeric style in particular:
     without it, each entry's own "[12]" marker would register as a mention
     of itself.

Only one style is detected per document, and only the common in-text forms
described in the module's own docstring are matched — see the "false
positives / not handled" notes near each pattern for the specific tradeoffs.
"""

from __future__ import annotations

import re
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
# of silently appending it as a very long "continuation".
_TRAILING_SECTION_PATTERN = re.compile(
    r"^\s*(Appendix|Supplementary\s+Material|Author\s+Contributions?|"
    r"Acknowledge?ments?|Conflicts?\s+of\s+Interest)\b",
    re.IGNORECASE,
)


def _find_bibliography_start(pages: list[PageText]) -> tuple[int, int] | None:
    """(page position in `pages`, run index) of the first heading match, or
    None if no bibliography section is found."""
    for page_pos, page in enumerate(pages):
        for run_idx, run in enumerate(page.runs):
            if _SECTION_HEADING_PATTERN.match(run.text.strip()):
                return page_pos, run_idx
    return None


def _collect_bibliography_lines(
    pages: list[PageText], start_page_pos: int, start_run_idx: int
) -> tuple[list[tuple[str, int]], set[int]]:
    """(text, page_index) for every non-blank run from just after the
    heading through the end of the document, stopping early if a trailing
    back-matter section heading shows up after we've already collected some
    bibliography content (see `_TRAILING_SECTION_PATTERN`). Also returns the
    `id()` of every run consumed this way, so the caller can exclude the
    reference list's own entry markers from in-text mention scanning — left
    in, a numeric entry's own "[12]" would otherwise show up as a "mention"
    of itself."""
    lines: list[tuple[str, int]] = []
    excluded: set[int] = set()
    for offset, page in enumerate(pages[start_page_pos:]):
        runs = page.runs[start_run_idx + 1 :] if offset == 0 else page.runs
        for run in runs:
            text = run.text.strip()
            if not text:
                continue
            if lines and _TRAILING_SECTION_PATTERN.match(text):
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
# form requires a capital letter right after the marker (an author name
# always starts capitalized) so an ordinary sentence that happens to open
# with a number ("2020 was...") on a wrapped continuation line isn't
# mistaken for a new entry — this doesn't fully eliminate that risk (a
# continuation line starting "1990s span..." would still slip through) but
# handles the common case.
_NUMERIC_ENTRY_START = re.compile(
    r"^\[(?P<num1>\d{1,4})\]\s*|^(?P<num2>\d{1,4})\.\s+(?=[A-Z])"
)


def _split_numeric_entries(
    lines: list[tuple[str, int]],
) -> list[dict]:
    """Group bibliography lines into entries, one per numeric marker. Lines
    without a marker are continuations of the previous entry (a wrapped
    reference, e.g. a long title spilling onto a second line)."""
    entries: list[dict] = []
    current: dict | None = None
    for text, page_index in lines:
        m = _NUMERIC_ENTRY_START.match(text)
        if m:
            if current is not None:
                entries.append(current)
            num = m.group("num1") or m.group("num2")
            current = {"num": num, "parts": [text], "page_index": page_index}
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


def _numeric_keys_in_match(m: re.Match) -> list[str]:
    if m.group("start") is not None:
        return _expand_range(m.group("start"), m.group("end"))
    keys: list[str] = []
    for token in re.split(r"[,;]", m.group("body")):
        token = token.strip()
        if not token:
            continue
        range_m = re.match(r"^(\d{1,4})\s*[-–—]\s*(\d{1,4})$", token)
        if range_m:
            keys.extend(_expand_range(range_m.group(1), range_m.group(2)))
        else:
            keys.append(token)
    return keys


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


# --- entry point ------------------------------------------------------------


def detect_citations(
    pages: list[PageText],
) -> tuple[list[Citation], list[CitationMention]]:
    """Parse a document's reference list and locate in-text mentions of each
    entry. `pages` must be every page of the document, in order (page_index
    0-based, matching `PageText.page_index`)."""
    start = _find_bibliography_start(pages)
    if start is None:
        return [], []
    start_page_pos, start_run_idx = start
    lines, excluded_ids = _collect_bibliography_lines(
        pages, start_page_pos, start_run_idx
    )
    if not lines:
        return [], []
    excluded_ids.add(id(pages[start_page_pos].runs[start_run_idx]))

    numeric_hits = sum(1 for text, _ in lines if _NUMERIC_ENTRY_START.match(text))
    author_hits = sum(1 for text, _ in lines if _AUTHOR_YEAR_ENTRY_START.match(text))
    if numeric_hits == 0 and author_hits == 0:
        return [], []

    if numeric_hits >= author_hits:
        citations = _build_numeric_citations(lines)
        scan_page = _numeric_mentions_on_page
    else:
        citations = _build_author_year_citations(lines)
        scan_page = _author_year_mentions_on_page

    if not citations:
        return [], []

    keys = {c.key for c in citations}
    mentions: list[CitationMention] = []
    for page in _pages_excluding_runs(pages, excluded_ids):
        mentions.extend(scan_page(page, keys))

    return citations, mentions
