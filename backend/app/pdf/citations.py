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
"""

from __future__ import annotations

from dataclasses import dataclass

from .types import BBox, PageText


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


def detect_citations(
    pages: list[PageText],
) -> tuple[list[Citation], list[CitationMention]]:
    """Parse a document's reference list and locate in-text mentions of each
    entry. `pages` must be every page of the document, in order (page_index
    0-based, matching `PageText.page_index`)."""
    raise NotImplementedError
