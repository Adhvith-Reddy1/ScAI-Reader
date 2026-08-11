/**
 * Client-side cache for a document's bibliography, plus small display
 * helpers (lead author, a best-effort link to the paper) shared by the
 * citation marker layer and its popup card.
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

/** The first author's name, split off the full author-list string (e.g.
 * "Wallentin L, Becker RC, Budaj A, et al." -> "Wallentin L"). Falls back to
 * the surname encoded in an author-year key ("Smith2020" -> "Smith") when
 * the parser couldn't confidently extract an author list at all — see
 * app.pdf.citations, which leaves `authors` null rather than guess. */
export function leadAuthor(entry: CitationEntry): string | null {
  if (entry.authors) {
    const first = entry.authors.split(",")[0]?.trim();
    if (first) return first;
  }
  const m = /^([A-Za-z'-]+)\d{4}$/.exec(entry.key);
  return m ? m[1] : null;
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
  const query = entry.title || entry.raw_text;
  return {
    label: "Search for paper ↗",
    url: `https://scholar.google.com/scholar?q=${encodeURIComponent(query)}`,
  };
}

/** Test-only: clear the cache between tests. */
export function _resetForTest(): void {
  cache.clear();
}
