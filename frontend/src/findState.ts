/**
 * Find-in-page state. Coordinates the FindBar (UI) with each rendered
 * PageView (which owns its text spans and reports its per-page matches).
 *
 *   FindBar       — setQuery, next, prev, subscribeQuery, subscribeMatches
 *   PageView      — registerPageAdapter on text-layer build,
 *                   unregisterPage on dispose; the adapter knows how to
 *                   scroll to and mark its own match-N.
 *
 * Matches are ordered by (page asc, in-page index asc). next/prev cycle
 * through the global list and tell the owning page to mark + scroll.
 */

export interface PageMatchAdapter {
  page: number;
  count: number;
  scrollToMatchAndMark(inPageIndex: number): void;
  clearActiveMark(): void;
}

let query = "";
const adapters = new Map<number, PageMatchAdapter>();
let current: { page: number; inPage: number } | null = null;
// True once the user has hit next/prev for the current query. While false,
// late-arriving page registrations re-anchor `current` to the earliest match
// overall (so the order in which pages happen to register doesn't leak into
// what gets highlighted as match #1).
let manuallyNavigated = false;

const querySubs = new Set<(q: string) => void>();
const matchesSubs = new Set<() => void>();

export function getQuery(): string {
  return query;
}

export function setQuery(q: string): void {
  if (q === query) return;
  query = q;
  current = null;
  manuallyNavigated = false;
  fireQuery();
  fireMatches();
}

export function clearQuery(): void {
  setQuery("");
}

export function subscribeQuery(cb: (q: string) => void): () => void {
  querySubs.add(cb);
  return () => {
    querySubs.delete(cb);
  };
}

/** Fires whenever the match set changes (page registers/unregisters or query
 *  changes). FindBar uses this to update the count display. */
export function subscribeMatches(cb: () => void): () => void {
  matchesSubs.add(cb);
  return () => {
    matchesSubs.delete(cb);
  };
}

export function registerPageAdapter(adapter: PageMatchAdapter): void {
  adapters.set(adapter.page, adapter);
  // While the user hasn't started navigating, keep `current` pinned to the
  // first match overall (lowest page, in-page index 0). This means a
  // late-arriving earlier page wins the anchor without surprising the user.
  if (!manuallyNavigated) {
    const first = firstAvailable();
    if (first && (!current || first.page !== current.page || first.inPage !== current.inPage)) {
      setCurrent(first.page, first.inPage);
    }
  } else if (current == null && adapter.count > 0) {
    setCurrent(adapter.page, 0);
  }
  fireMatches();
}

export function unregisterPage(page: number): void {
  if (!adapters.has(page)) return;
  adapters.delete(page);
  if (current && current.page === page) {
    // Pick the next available match (first one in any remaining page).
    const next = firstAvailable();
    current = next;
    if (next) {
      adapters.get(next.page)?.scrollToMatchAndMark(next.inPage);
    }
  }
  fireMatches();
}

export function getTotalMatches(): number {
  let t = 0;
  for (const a of adapters.values()) t += a.count;
  return t;
}

/** 1-indexed global index of the current match across pages. 0 if none. */
export function getCurrentIndex(): number {
  if (!current) return 0;
  let idx = 0;
  for (const page of sortedPages()) {
    const adapter = adapters.get(page);
    if (!adapter) continue;
    if (page === current.page) return idx + current.inPage + 1;
    idx += adapter.count;
  }
  return 0;
}

export function next(): void {
  step(+1);
}

export function prev(): void {
  step(-1);
}

function step(direction: 1 | -1): void {
  const total = getTotalMatches();
  if (total === 0) return;
  const flat = flatMatches();
  manuallyNavigated = true;
  if (!current) {
    setCurrent(flat[0].page, flat[0].inPage);
    return;
  }
  const i = flat.findIndex(
    (m) => m.page === current!.page && m.inPage === current!.inPage,
  );
  const nextI = (i + direction + flat.length) % flat.length;
  const m = flat[nextI];
  setCurrent(m.page, m.inPage);
}

function setCurrent(page: number, inPage: number): void {
  // Clear any prior active mark before moving.
  if (current) {
    adapters.get(current.page)?.clearActiveMark();
  }
  current = { page, inPage };
  adapters.get(page)?.scrollToMatchAndMark(inPage);
  fireMatches();
}

function firstAvailable(): { page: number; inPage: number } | null {
  for (const page of sortedPages()) {
    const a = adapters.get(page);
    if (a && a.count > 0) return { page, inPage: 0 };
  }
  return null;
}

function flatMatches(): { page: number; inPage: number }[] {
  const out: { page: number; inPage: number }[] = [];
  for (const page of sortedPages()) {
    const a = adapters.get(page);
    if (!a) continue;
    for (let i = 0; i < a.count; i++) out.push({ page, inPage: i });
  }
  return out;
}

function sortedPages(): number[] {
  return Array.from(adapters.keys()).sort((a, b) => a - b);
}

function fireQuery(): void {
  for (const cb of querySubs) cb(query);
}
function fireMatches(): void {
  for (const cb of matchesSubs) cb();
}

/** For tests. */
export function _resetForTest(): void {
  query = "";
  adapters.clear();
  current = null;
  querySubs.clear();
  matchesSubs.clear();
}
