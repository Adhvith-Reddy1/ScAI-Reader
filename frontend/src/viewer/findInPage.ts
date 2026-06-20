/**
 * Per-page find helper. Walks a built text layer (one `<span class="text-run">`
 * per text run), tags every span whose text contains the query (case-
 * insensitive) with `find-match`, and returns the ordered list of matched
 * spans for the caller to track current-match navigation.
 *
 * v1 behavior: at most one match per span. A span containing two occurrences
 * of "the" still counts as one match. Splitting spans to mark each occurrence
 * would require rebuilding the layer and is deferred.
 */

const MATCH_CLASS = "find-match";
const MATCH_CURRENT_CLASS = "find-match-current";

export function applyFindToTextLayer(
  textLayer: HTMLElement,
  query: string,
): HTMLElement[] {
  clearFindMarks(textLayer);
  if (!query) return [];
  const q = query.toLowerCase();

  // Spans are queried in DOM order, which matches reading order (columns
  // are appended top-to-bottom in TextLayer, runs in column reading order).
  const spans = Array.from(
    textLayer.querySelectorAll<HTMLElement>(".text-run"),
  );
  const hits: HTMLElement[] = [];
  for (const span of spans) {
    const text = (span.textContent ?? "").toLowerCase();
    if (text.includes(q)) {
      span.classList.add(MATCH_CLASS);
      hits.push(span);
    }
  }
  return hits;
}

export function clearFindMarks(textLayer: HTMLElement): void {
  textLayer
    .querySelectorAll<HTMLElement>("." + MATCH_CLASS)
    .forEach((el) => el.classList.remove(MATCH_CLASS, MATCH_CURRENT_CLASS));
}

export function markCurrent(span: HTMLElement | null): void {
  // Find any previous current marker globally (cheap; there's only ever one).
  document
    .querySelectorAll<HTMLElement>("." + MATCH_CURRENT_CLASS)
    .forEach((el) => el.classList.remove(MATCH_CURRENT_CLASS));
  if (span) span.classList.add(MATCH_CURRENT_CLASS);
}
