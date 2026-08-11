# Citation styles spec

Reference document for `backend/app/pdf/citations.py` (bibliography detection
and in-text mention matching). Synthesizes two sources: (1) direct inspection
of five real PDFs' extracted text layers (NEJM, an FDA report, a Nature
article, a Nature Immunology article, and a Nature paper reprint informally
named "Virtual Lab"), and (2) research into the published author-guideline
conventions of the journals a reader of this app is likely to upload —
Nature-family, Science/PNAS/Cell Press, Vancouver-style medical journals,
IEEE/ACM/preprints, and author-year (APA/Harvard) venues.

Every claim below is tagged with how it was established:

- **[confirmed]** — verified by directly reading a real PDF's extracted text
  (this app's own PDFium backend), or by directly reading a journal's own
  author-guidelines page.
- **[corroborated]** — independent secondary sources (library citation
  guides, style-guide aggregators) agree, but not independently re-verified
  against the journal's own primary documentation this round (some outbound
  fetches to publisher domains were blocked in the research sandbox).
- **[conflicting]** — sources disagree; needs a real PDF to resolve before
  being relied on.
- **[inferred]** — general knowledge, not directly sourced this round.

None of this changes `Citation`/`CitationMention`'s data model — this is
about what `detect_citations` needs to *recognize*, not what it stores.

## 1. The core problem: reference lists are not one shape

The current parser (as of the NEJM/FDA fixes) assumes a reference list is:
one heading, one contiguous region running to a trailing-section stop, one
style, entries numbered 1..N with no gaps. Real papers break every part of
that assumption in ways that are common enough to design for, not edge
cases to shrug off:

| Pattern | Confirmed in | What it breaks |
|---|---|---|
| No heading at all before the numbered list | Nature (s41586, this session) **[confirmed]**, family-wide per Nature's own AIP guidance **[confirmed]** | Heading-based start detection finds nothing → 0 citations |
| Reference list split into 2+ headed sections sharing ONE continuous number sequence (main text 1-73, Methods 74-87) | Nature Immunology (s41590, this session) **[confirmed]**; documented Nature-family-wide policy: *"If further references are included in the Methods section, their numbering should continue from the end of the last reference number in the rest of the paper"* **[confirmed]**; same for Extended Data refs | Taking only the first OR only the last heading match misses one whole segment |
| A table-of-contents "References....36" line extracting as a bare heading-shaped run | FDA report (prior session) **[confirmed]** | A naive "first heading wins" swallows the entire document body as bibliography |
| Reference list split into 2+ sections with INDEPENDENT, RESTARTING numbering (main text 1..N, then a separate Supplementary/SI reference list also starting at 1) | PNAS SI Appendix, Cell Press Supplemental Information **[corroborated]** — not yet seen directly in a test PDF | "Merge regions by key" would silently collide entry "1" from two unrelated lists if both ever land in one uploaded PDF |
| One journal, two eras / two house styles depending on publication date (Cell Press: author-year before Oct 2022, numbered superscript after) | Cell Press policy change **[corroborated]** | A parser can't hard-code "this journal = this style"; must keep detecting style empirically per-document (already how this parser works — no change needed, just don't regress it) |

## 2. In-text marker styles: five shapes, not three

The parser currently recognizes: bracketed numeric (`[12]`, `[3, 7]`,
`[3]-[5]`), bare superscript numeric (`21,22`), and author-year
(parenthetical + narrative). Research surfaced two more real shapes:

1. **Bracketed numeric** `[12]`, `[3, 7]`, `[3]-[5]` — IEEE, ACM, PLOS
   family **[confirmed for PLOS/FDA-report style — already seen directly]**,
   many CS/EE arXiv papers.
2. **Bare superscript numeric** `12`, `21,22` (no brackets) — NEJM, JAMA,
   Lancet, Nature family **[confirmed directly, twice now]**, Cell Press
   *since October 2022* **[corroborated]**.
3. **Parenthetical numeric, non-superscript** `(12)`, `(12, 13)`, `(12–15)`
   — PNAS **[corroborated]**, possibly Science **[conflicting — one source
   says superscript, another parenthetical, needs a real Science PDF]**.
   **This shape is not handled by the parser at all today** — the numeric
   mention scanner only looks inside `[...]` or at small-font runs; a plain
   `(12)` in body-sized font is invisible to it. Building this safely means
   reusing the same "must match a real bibliography key" safety net the
   other numeric scanners rely on, since a bare `(12)` is otherwise
   indistinguishable from an ordinary parenthetical number (a page count, a
   percentage, an equation reference).
4. **Author-year, parenthetical/narrative** — already handled. Two nuances
   surfaced worth checking against the existing implementation: (a) APA's
   own rule is **alphabetical**, not chronological, ordering for multiple
   works in one parenthetical (`(Adams et al., 2019; Shumway & Shulman,
   2015)`) — irrelevant to *detecting* mentions (order doesn't matter for
   matching), only relevant if this app ever tries to validate/reorder
   citations; (b) `&` vs `and` varies by context in APA (parenthetical `&`,
   narrative `and`) and is presumably already tolerated since
   `_MENTION_AUTHORS` allows both — worth a quick look, not a redesign.
5. **No `et al.` at all** — Science explicitly *forbids* `et al.` in its
   reference list (all authors must be listed) **[corroborated]**. Doesn't
   change mention detection (still keyed off the first author), but is a
   reminder that `_extract_numeric_authors_title`/citation-display code
   shouldn't assume `et al.` will show up as a boundary signal for every
   numeric-style paper.

## 3. Reference-entry format variation (relevant to `citations.ts`'s
   raw_text-derived author/description heuristics, not the backend parser)

The frontend's `leadAuthor()`/`paperDescription()` heuristics (see
`frontend/src/citations.ts`) classify comma-separated segments as
"looks like a name." Research confirms the *shape* of a name segment varies
by journal family in ways the current patterns don't all cover:

| Family | Author order | Delimiter | Example | Status |
|---|---|---|---|---|
| Nature, Cell Press | Surname first, comma, initials **with** periods | `Surname, A. B.,` | `Arai, K. I. et al.` **[confirmed directly]** | Not matched by current `AUTHOR_SURNAME_INITIALS` (`Surname AB`, no comma/periods) or `AUTHOR_INITIALS_SURNAME` (`A.B. Surname`, no comma before) — **a real gap**, this specific "Surname, A. B." shape isn't one of the current patterns |
| NEJM, JAMA, Lancet (Vancouver) | Surname first, no comma, initials **without** periods | `Surname AB` | `Pocock SJ` **[confirmed directly]** | Matched today |
| FDA-report/APA-ish | Surname, comma, initials with periods, OR initials-then-surname | `Surname, A.A.,` / `A.A. Surname,` | `DiMasi, J.A.,` / `H.G. Grabowski,` | Matched today |
| IEEE | Initials first, no inversion | `J. K. Smith` | — **[confirmed via IEEE's own style manual]** | Not matched — current patterns all assume surname-first or a clearly bounded initials block; `J. K. Smith` as a whole segment isn't recognized as "surname-only" or "initials+surname" cleanly |
| ACM | Full first name, no inversion | `Patricia S. Abril` | — **[confirmed via ACM's own reference-format example]** | Not matched — full first names (not initials) aren't covered by any current pattern |
| APA/eLife/Frontiers (author-year) | Surname first, comma, initials with periods | `Surname, A. B.` | eLife CSL example **[corroborated]** | Same gap as Nature/Cell Press row |

**The Nature/Cell-Press "Surname, A. B." shape is the highest-value gap to
close** — it's the format used by two of the biggest journal families this
app's users will upload, and it's a small, well-scoped regex addition (a
surname segment followed by a comma-separated segment matching
`([A-Z]\.\s*){1,3}`, i.e. what today's code calls "initials only" but
currently only merges into a lead when it's the *second* segment after a
bare surname — need to also accept it when there's a comma between them,
which the current `cleanSegment`/split-on-comma logic mostly already
produces as two segments "Arai" and "K. I." — worth a follow-up look at
why the existing merge branch (`AUTHOR_SURNAME_ONLY && AUTHOR_INITIALS_ONLY`
→ join with `, `) doesn't already catch this; may just need the FDA-report
test coverage extended with a Nature-shaped example to confirm/deny).

**Lowercase-prefixed surnames** (`van der Berg`, `de la Cruz`) are common in
Dutch/German/Spanish names and explicitly sanctioned by APA style (keep the
author's own capitalization, alphabetize by the prefix) **[confirmed via
APA's own style page]**. Already a known, explicitly-documented gap in both
the backend's `_AUTHOR_YEAR_ENTRY_START` regex and the frontend's `NAME`
pattern — this research just confirms it's worth the effort at some point
rather than a rare curiosity.

## 4. Structural stop-boundaries (what reliably follows a reference list)

Useful for bounding a heading-less or multi-region collection pass so it
doesn't run past the actual list into unrelated content (this was a real
problem: a heading-less Nature reference list, uncapped, will keep
absorbing an unrelated *Methods* section's own numbered list as
"continuation text" of the last real entry unless something stops it).

- **Nature family:** `Methods`, `Data availability`, `Code availability`,
  `Reporting summary`, `Competing interests`, `Publisher's Note`,
  `Open Access` — all confirmed as standalone headings that follow the
  reference list (or Methods, if Methods precedes it) in the one real
  Nature PDF inspected this session **[confirmed directly]**.
- **Science:** `Acknowledgments` directly follows "References and Notes"
  **[corroborated]**.
- **PLOS:** `Supporting Information` (with `S1 Fig`/`S1 Table` caption
  lines) follows References **[corroborated]**.
- **IEEE:** `Acknowledgment` (no "s") **[confirmed via IEEE style manual]**,
  or an author biography/photo block.
- **APA:** `Appendices` follow References (footnotes/tables/figures sit
  between) — correcting an assumption that "Author Note" trails the
  references; it's actually on the title page **[confirmed via APA's own
  style page]**.
- Already handled: `Appendix`, `Supplementary Material`, `Author
  Contributions`, `Acknowledg(e)ments`, `Conflicts of Interest`.

## 5. Explicitly out of scope (for now)

- **Independently-renumbered supplementary reference lists** (PNAS SI
  Appendix, Cell Press Supplemental Information) that restart at 1 *within
  the same uploaded PDF* as the main list. Both are typically separate PDF
  files in practice (not merged into the main article PDF a reader would
  upload), which limits real-world exposure — but if it ever happens, this
  parser's "merge regions by key" approach would need a real fix (e.g.
  keying regions by `(region_index, key)` instead of just `key`, and
  presenting duplicate keys as genuinely separate citations) rather than
  the silent-collision behavior it'd have today. Not building this
  speculatively; flagging it so a future bug report referencing a PNAS or
  Cell Press paper with a merged SI isn't a surprise.
- **BMJ's marker style** and **Annals of Internal Medicine's marker
  style/et-al threshold** — sources conflict or are thin; needs a real PDF
  before encoding either into the parser. Don't guess.
- **Parenthetical bare-numeric mentions** `(12)` (PNAS-style) — real gap
  (see §2.3) but not yet built; flagging as the next scanner to add once a
  real PNAS PDF is available to validate against (the false-positive risk
  — an ordinary parenthetical number — makes "validate against a real
  document before shipping" more important here than it was for the
  bracket/superscript scanners).
- **IEEE initials-first / ACM full-first-name** author formats for the
  frontend's `leadAuthor()` heuristic (§3) — real gap, lower priority than
  the Nature/Cell-Press comma+periods shape since this app's likely users
  (per the documents tested so far) skew biomedical, not EE/CS.

## 6. Suggested next steps, in priority order

1. ✅ **Done.** **Multi-region backend fix** (§1): support 2+ heading
   matches, each bounded to the next heading (not "first" or "last"),
   filtered by a minimum entry count before being trusted (only when
   there's more than one region to disambiguate against — a lone heading
   is trusted regardless of count), and merged. Fixes the Nature
   Immunology case (73 + 14 entries → 87 merged) and keeps the FDA
   table-of-contents case working. See `_find_heading_positions`,
   `_citations_from_regions`, `MIN_REGION_ENTRIES` in citations.py.
2. ✅ **Done.** **Heading-less numeric fallback** (§1): when zero regions
   from (1) qualify, scan the whole document for candidate numbered lists
   starting at 1, requiring a stricter entry-count bar plus most entries
   containing a year-shaped token. Fixes the Nature (s41586) case (0 → 39
   citations found). Also extended the trailing-stop patterns per §4
   (`_TRAILING_SECTION_EXACT_PATTERN`) so an unbounded heading-less region
   can't run into an unrelated Methods numbered list. See
   `_find_headingless_numeric_run`, `MIN_HEADINGLESS_ENTRIES`,
   `MIN_HEADINGLESS_YEAR_FRACTION` in citations.py.

   **A second real bug surfaced and was fixed while validating (1)/(2)
   against real Nature PDFs, not predicted by the research above**: a
   numbered author-affiliation list (institutions numbered 1, 2, 3...
   matching author superscripts on the byline) is itself a plausible
   heading-less candidate. Once its own numbering runs out, the
   sequential-numbering rule keeps absorbing unrelated body text as
   "continuation" until it happens to reach a run matching whatever number
   comes next — which it always eventually does, since the real
   bibliography contains a marker for every number 1..N. That splices "K
   affiliations + the real bibliography from K+1 to N" into a candidate
   that ties the genuine one on final entry count and even year fraction.
   Fix: among candidates tied for the max entry count, prefer the LATEST
   start — provably never the contaminated one (see
   `_find_headingless_numeric_run`'s docstring for the full argument, and
   `test_find_headingless_numeric_run_prefers_real_bibliography_over_affiliation_splice`
   in test_citations.py for the regression test). Also widened
   `_SUPERSCRIPT_FONT_RATIO` from 0.7 to 0.8: Nature-family superscript
   markers were confirmed at ~0.74-0.76x body font size, a real cluster
   this app hadn't seen before NEJM's tighter ~0.4-0.55x.
3. ✅ **Done.** **Nature/Cell-Press "Surname, A. B." shape** in
   `citations.ts`'s frontend heuristics (§3) — confirmed empirically
   against real Nature citation text that the base surname+initials merge
   already worked, but the common "Surname, K. I. et al. Title..."
   single-lead-author shape (initials glued directly to "et al." with no
   comma between them) did not — added `INITIALS_ET_AL_PREFIX` to handle
   it. A related, more complex shape ("Surname, Initials, Surname2 &
   Surname3, Initials3. Title...", the last two authors joined by "&"
   with no "et al." at all) was found but NOT fixed — same
   already-imperfect-but-honest fallback as before, not a regression, and
   scoped out for now as a further variant of the same open-ended
   author-list-punctuation problem.
4. Everything in §5, opportunistically, when a real document surfaces the
   need — not speculatively.

Validated end-to-end (backend `detect_citations` + the full upload
pipeline) against five real PDFs before/after: NEJM (50/50 refs, 89/89
mentioned — unchanged, no regression), the FDA report (129/129, 129/129 —
unchanged), a real CC-BY Nature article (0 → 39/39 refs found, 38/39
mentioned — the one gap is a separate, narrower known limit where a
figure-dense page skews the local font-size baseline
`_page_body_font_size` relies on), a Nature Immunology article (14 → 87/87
refs found, 75/87 mentioned), and the "Virtual Lab" Nature paper (0 →
51/51 refs found, 48/51 mentioned). The Nature article is committed as a
test fixture (`backend/tests/fixtures/pdfs/nature_cytokine_atlas_cc_by.pdf`,
trimmed to 9 pages — CC BY 4.0, safe to redistribute with attribution, see
`conftest.py`'s `nature_cytokine_atlas_pdf` fixture for the citation); the
other two aren't committed (license unconfirmed), validated locally only.

## Appendix: per-journal quick reference

| Journal/family | Heading | Marker | Author format | et al. threshold |
|---|---|---|---|---|
| Nature family | none (after "Online content..." lead-in); Methods/Extended Data continue main numbering | superscript, no brackets | `Surname, A. B.,` | >5 authors |
| Science | "References and Notes" (always) | superscript (conflicting evidence) | initials-first, comma-sep | **never** — all authors listed |
| PNAS | "References" | parenthetical `(12)` | comma-sep, `Surname, AB` | ≥10 authors |
| Cell Press (post-Oct-2022) | "References" | superscript | `Last, F.M., ... and Last, F.M. (Year)` | >10 authors |
| Cell Press (pre-Oct-2022) | "References" | author-year `(Smith et al., 2020)` | same as above, no year-in-numbered-list | n/a |
| NEJM / JAMA / Lancet | "References" | superscript, no brackets | `Surname AB` (no comma/periods) | >6 authors (first 3 + et al.) |
| BMJ | "References" | **conflicting — verify** | `Surname AB` (assumed) | ~6 (uncertain) |
| Annals of Internal Medicine | "References" | **uncertain — verify** | `Surname AB` (assumed) | >3 (uncertain) |
| PLOS (ONE/Medicine/Biology) | "References" | bracketed `[19]` | `Surname AB` | >6 authors |
| IEEE | "References" | bracketed `[1]` | initials-first, not inverted | n/a (no explicit rule found) |
| ACM | "REFERENCES" (all-caps) | bracketed `[1]`, comma-joined compounds | full first name, not inverted | n/a |
| arXiv (CS/ML) | "References" | author-year (natbib) | varies by template | varies |
| arXiv (EE/physics/math) | "References" | bracketed `[1]` | varies by template | varies |
| bioRxiv/medRxiv | mirrors target journal | mirrors target journal | mirrors target journal | mirrors target journal |
| APA-family / eLife / Frontiers (Harvard variant) | "References" | author-year | `Surname, A. B. (Year)` | eLife/APA: 3+ authors; Frontiers: 3+ (first 6 then et al. in list) |
| AER / economics (Chicago author-date) | "References" | author-year, **no comma**: `(Smith 2020)` | varies | in-text 5+; list 11+ |
