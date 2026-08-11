/**
 * Client-side cache for a document's bibliography, plus small display
 * helpers (lead author, a description of the paper, a best-effort link to
 * it) shared by the citation marker layer and its popup card.
 *
 * Unlike figureStore/explanationStore this holds no AI-generated content —
 * citation metadata is static once parsed, so a plain per-document cache
 * (no streaming, no store/subscribe machinery) is all it needs.
 */

import { fetchDocumentCitations, type CitationEntry } from "./api.ts";

const cache = new Map<string, Promise<CitationEntry[]>>();

/** All bibliography entries for a document, fetched once and cached for the
 * life of the tab. A failed fetch isn't cached, so the next call retries. */
export function getDocumentCitations(docId: string): Promise<CitationEntry[]> {
  let pending = cache.get(docId);
  if (!pending) {
    pending = fetchDocumentCitations(docId).catch((e: unknown) => {
      cache.delete(docId);
      throw e;
    });
    cache.set(docId, pending);
  }
  return pending;
}

// --- best-effort author/description extraction from raw_text ---------------
//
// The backend (app.pdf.citations) only fills in `authors`/`title` when a
// reference quotes its title ("Title," — an IEEE/ACM convention) — real
// numeric-style reference lists (NEJM, JAMA, FDA reports, most journals)
// don't quote titles at all, so those fields come back null for the large
// majority of real citations. But every reference's `raw_text` reliably
// starts with its author list regardless of style, so we don't need the
// full author-list/title split the backend deliberately avoids guessing —
// just "where does the author list end" is enough to pull out a lead author
// and, for whatever's left, a description of the paper (title + venue, even
// if we can't cleanly isolate the title alone).
//
// Two real styles this was validated against (see citations.test.ts):
//   Vancouver/NEJM: "Pocock SJ, Stone GW. The primary outcome fails..."
//   FDA/APA-ish:    "DiMasi, J.A., H.G. Grabowski, and R.W. Hansen, Briefing: ..."
// They delimit authors differently (periods vs. commas), so this classifies
// each comma-separated segment as "looks like a name" and consumes leading
// author-ish segments rather than assuming one universal delimiter. It's a
// display heuristic, not a parser: an imperfect split (a stray author name
// leaking into the description) is an accepted tradeoff, never a fabricated
// answer — when nothing looks author-ish at all, everything falls back to
// the full raw text, same as before this heuristic existed.

// A surname token. Uses \p{L} (any Unicode letter), not [a-zA-Z] — author
// surnames routinely carry diacritics ("Engstrøm", "Fröbert", "Kelbæk", all
// pulled from this app's own real-document test fixtures) that a plain
// ASCII class would silently reject, falling back to "unavailable" for a
// name that was right there in the text. Also tolerant of a hyphenated
// compound name with stray spacing around the hyphen ("Heresco - Levy",
// "Sanofi - Aventis") — confirmed as a common PDF-text-extraction artifact
// in real reference lists (the rasterizer/text-run boundary lands mid-hyphen
// and reintroduces spaces around it). Matching it loosely here is a
// display-only heuristic, so a company name shaped like "Sanofi - Aventis"
// being treated the same as a hyphenated surname is a fine trade — either
// way it's "who published this".
const NAME = "[\\p{L}][\\p{L}'’-]*(?:\\s*-\\s*[\\p{L}][\\p{L}'’-]*)?";
// An optional "Jr"/"Sr"/generational suffix after a surname + initials, e.g.
// "Mentzer RM Jr" (a real Vancouver-style example from this app's own test
// fixtures).
const SUFFIX = "(?:\\s+(?:Jr\\.?|Sr\\.?|II|III|IV))?";
// Initials themselves are effectively always plain ASCII capitals, even for
// an author whose surname carries diacritics.
const AUTHOR_INITIALS_SURNAME = new RegExp(`^([A-Z]\\.){1,3}\\s*${NAME}$`, "u");
const AUTHOR_SURNAME_INITIALS = new RegExp(`^${NAME}\\s+[A-Z]{1,3}${SUFFIX}$`, "u");
const AUTHOR_SURNAME_ONLY = new RegExp(`^${NAME}$`, "u");
const AUTHOR_INITIALS_ONLY = /^([A-Z]\.){1,3}$/;
const AUTHOR_ET_AL = /^et\s+al\.?$/i;
// Bounds how many leading segments we'll ever treat as authors, so a
// pathological reference (many comma-separated numbers/terms that happen to
// look name-ish) can't strip an unbounded amount of real title text.
const MAX_AUTHOR_SEGMENTS = 8;

// Clinical-trial/consortium "group authorship" — very common in the medical
// literature this app targets ("The SPRINT Research Group.", "...
// Investigators.", "... (CTT) Collaborators.") — and unlike an individual
// author's name, the group's own name is virtually always followed directly
// by a period with no comma anywhere in it, so the comma-segmentation logic
// below never recognizes it. Matched separately, up front, against a fixed
// small vocabulary of group-authorship suffixes: specific enough that it
// won't misfire on an ordinary title that happens to contain one of these
// words attached to something else.
const GROUP_AUTHOR = new RegExp(
  "^((?:The\\s+)?[\\p{L}][\\p{L}\\d\\s'’()-]{1,80}?\\s+" +
    "(?:Investigators?|Collaborators?|Trialists?|Consortium|(?:Study|Research)\\s+Group|Group))" +
    "\\.\\s+(?=[A-Z])",
  "u",
);

function stripEntryMarker(rawText: string): string {
  return rawText.replace(/^\[\d{1,4}\]\s*/, "").replace(/^\d{1,4}\s*\.\s*/, "");
}

function cleanSegment(seg: string): string {
  return seg.trim().replace(/^(and|&)\s+/i, "");
}

function isCompletePerson(seg: string): boolean {
  return AUTHOR_INITIALS_SURNAME.test(seg) || AUTHOR_SURNAME_INITIALS.test(seg);
}

function isAuthorish(seg: string): boolean {
  return (
    isCompletePerson(seg) ||
    AUTHOR_SURNAME_ONLY.test(seg) ||
    AUTHOR_INITIALS_ONLY.test(seg) ||
    AUTHOR_ET_AL.test(seg)
  );
}

// Nature/Cell-Press style: a single named author's initials glued directly
// to "et al." with no comma between them and the title right after --
// "Arai, K. I. et al. Cytokines: coordinators..." (confirmed against a real
// CC-BY Nature article) has only ONE comma total, unlike the "Surname,
// Initials, Surname2, Initials2, ..." APA/FDA-report style where every
// name gets its own comma-delimited segment (already handled by the
// surname+initials merge above). Matched as a PREFIX, not a whole-segment
// shape like AUTHOR_INITIALS_ONLY, since the title runs on in the same
// segment right after "et al.".
const INITIALS_ET_AL_PREFIX = /^((?:[A-Z]\.\s*){1,3})et\s+al\.?\s*/i;

interface AuthorSplit {
  lead: string | null;
  /** Whatever's left after the leading author-ish segments — a
   * description of the paper (title + venue, when we can't cleanly isolate
   * just the title). Never empty: falls back to the full stripped text. */
  rest: string;
}

function splitAuthorsFromRawText(strippedText: string): AuthorSplit {
  const trimmedWhole = strippedText.trim();

  const groupMatch = GROUP_AUTHOR.exec(trimmedWhole);
  if (groupMatch) {
    return {
      lead: groupMatch[1].trim(),
      rest: trimmedWhole.slice(groupMatch[0].length).trim(),
    };
  }

  const rawSegs = strippedText.split(",");
  if (rawSegs.length < 2) return { lead: null, rest: trimmedWhole };
  const segs = rawSegs.map(cleanSegment);

  let lead: string | null = null;
  if (isCompletePerson(segs[0])) {
    lead = segs[0];
  } else if (AUTHOR_SURNAME_ONLY.test(segs[0]) && AUTHOR_INITIALS_ONLY.test(segs[1])) {
    // "DiMasi, J.A." — surname and initials landed in separate segments.
    lead = `${segs[0]}, ${segs[1]}`;
  } else if (AUTHOR_INITIALS_ONLY.test(segs[0]) && AUTHOR_SURNAME_ONLY.test(segs[1])) {
    lead = `${segs[0]} ${segs[1]}`;
  } else if (AUTHOR_SURNAME_ONLY.test(segs[0]) || AUTHOR_INITIALS_ONLY.test(segs[0])) {
    lead = segs[0];
  }

  let i = 0;
  while (i < segs.length && i < MAX_AUTHOR_SEGMENTS && isAuthorish(segs[i])) i++;

  // "Surname, K. I. et al. Title..." (see INITIALS_ET_AL_PREFIX) — the loop
  // above stops one segment early here, since that segment isn't JUST "et
  // al." (AUTHOR_ET_AL requires a whole-segment match). If the first
  // un-consumed segment starts with this shape, complete `lead` with the
  // initials and advance the description past "et al." within that segment.
  if (i < segs.length) {
    const m = INITIALS_ET_AL_PREFIX.exec(segs[i]);
    if (m) {
      if (lead === segs[0]) lead = `${segs[0]}, ${m[1].trim()}`;
      const tailSegs = [segs[i].slice(m[0].length), ...rawSegs.slice(i + 1)];
      const rest = tailSegs.join(",").trim();
      return { lead, rest: rest || trimmedWhole };
    }
  }

  // "et al." commonly sits in the SAME segment as the title with no comma
  // between them ("..., et al. Title starts here.", Vancouver style) — the
  // loop above only recognizes "et al." as its own whole segment, so strip
  // a leading "et al." off whatever's left too.
  const rest = i > 0 ? rawSegs.slice(i).join(",").trim().replace(/^et\s+al\.?\s+/i, "") : "";
  return { lead, rest: rest || trimmedWhole };
}

/** The first author's name. Prefers the backend's confidently-parsed
 * `authors` field (only set when a quoted title gave it a reliable
 * delimiter); otherwise derives it directly from `raw_text`, which reliably
 * starts with the author list regardless of citation style; otherwise falls
 * back to the surname encoded in an author-year key ("Smith2020" ->
 * "Smith"). */
export function leadAuthor(entry: CitationEntry): string | null {
  if (entry.authors) {
    const first = entry.authors.split(",")[0]?.trim();
    if (first) return first;
  }
  const { lead } = splitAuthorsFromRawText(stripEntryMarker(entry.raw_text));
  if (lead) return lead;
  const m = /^([A-Za-z'-]+)\d{4}$/.exec(entry.key);
  return m ? m[1] : null;
}

/** A description of the cited paper. Prefers the backend's confidently-
 * parsed `title`; otherwise everything left in `raw_text` after stripping
 * the leading author list — title and venue together when we can't isolate
 * just the title, which still says what the paper is. */
export function paperDescription(entry: CitationEntry): string {
  if (entry.title) return entry.title;
  return splitAuthorsFromRawText(stripEntryMarker(entry.raw_text)).rest;
}

/**
 * A best-effort external link for the paper: a direct DOI link when the
 * parser found one, otherwise a Google Scholar search built from whatever
 * identifying text is available. Always returns a usable link — a search
 * gets the reader there in one click even without a resolvable DOI (DOI
 * extraction isn't implemented yet, so this is the common case today).
 */
export function citationLink(entry: CitationEntry): { label: string; url: string } {
  if (entry.doi) {
    return { label: "View paper ↗", url: `https://doi.org/${entry.doi}` };
  }
  const query = entry.title || paperDescription(entry);
  return {
    label: "Search for paper ↗",
    url: `https://scholar.google.com/scholar?q=${encodeURIComponent(query)}`,
  };
}

/** Test-only: clear the cache between tests. */
export function _resetForTest(): void {
  cache.clear();
}
