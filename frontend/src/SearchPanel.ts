/**
 * Sidebar panel for full-text search within the active document.
 *
 *   const root = buildSearchPanel();
 *   mountSidebarPanel("search", "Search", root);
 *   setActiveSearchDoc("abc123");
 *   focusSearchInput();        // wired from main.ts on Cmd/Ctrl-F
 *
 * The panel keeps a tiny module-level handle so main.ts can call
 * `focusSearchInput()` without threading a ref through.
 */

import { fetchSearchResults, type SearchResult } from "./api.ts";
import { jumpToPage } from "./pageNav.ts";

const DEBOUNCE_MS = 200;

let activeDocId: string | null = null;
let focusInputFn: (() => void) | null = null;

export function setActiveSearchDoc(docId: string | null): void {
  activeDocId = docId;
}

export function focusSearchInput(): void {
  focusInputFn?.();
}

export interface BuildOptions {
  /** Override the debounce delay; tests use 0 to bypass debouncing. */
  debounceMs?: number;
}

export function buildSearchPanel(opts: BuildOptions = {}): HTMLElement {
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
  const root = document.createElement("div");
  root.className = "search-panel";

  const input = document.createElement("input");
  input.type = "search";
  input.className = "search-input";
  input.placeholder = "Search this document…";
  input.setAttribute("aria-label", "Search this document");
  root.appendChild(input);

  const status = document.createElement("div");
  status.className = "search-status";
  root.appendChild(status);

  const list = document.createElement("div");
  list.className = "search-results";
  root.appendChild(list);

  focusInputFn = () => {
    input.focus();
    input.select();
  };

  showEmpty(status, list);

  let timer: ReturnType<typeof setTimeout> | null = null;
  // Monotonic token so a slow in-flight request doesn't overwrite a newer
  // result. The classic stale-response race.
  let requestId = 0;

  const run = async (q: string): Promise<void> => {
    const docId = activeDocId;
    if (!docId) {
      status.textContent = "Open a document to search.";
      list.replaceChildren();
      return;
    }
    if (q.trim() === "") {
      showEmpty(status, list);
      return;
    }
    const myId = ++requestId;
    status.textContent = "Searching…";
    try {
      const resp = await fetchSearchResults(docId, q);
      if (myId !== requestId) return;
      renderResults(status, list, resp.results);
    } catch {
      if (myId !== requestId) return;
      status.textContent = "Search failed.";
      list.replaceChildren();
    }
  };

  input.addEventListener("input", () => {
    if (timer != null) clearTimeout(timer);
    const value = input.value;
    timer = setTimeout(() => void run(value), debounceMs);
  });

  return root;
}

function showEmpty(status: HTMLElement, list: HTMLElement): void {
  status.textContent = "Type to search.";
  list.replaceChildren();
}

function renderResults(
  status: HTMLElement,
  list: HTMLElement,
  results: SearchResult[],
): void {
  if (results.length === 0) {
    status.textContent = "No matches.";
    list.replaceChildren();
    return;
  }
  status.textContent = `${results.length} match${results.length === 1 ? "" : "es"}`;
  const frag = document.createDocumentFragment();
  for (const r of results) {
    frag.appendChild(buildRow(r));
  }
  list.replaceChildren(frag);
}

function buildRow(r: SearchResult): HTMLElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "search-result";
  row.setAttribute("data-page", String(r.page));

  const page = document.createElement("div");
  page.className = "search-result-page";
  page.textContent = `Page ${r.page}`;
  row.appendChild(page);

  const snip = document.createElement("div");
  snip.className = "search-result-snippet";
  // Server returns plain text with <mark>…</mark> tags injected by FTS5's
  // snippet(). FTS5 takes the source text verbatim, so any HTML special chars
  // in the PDF would land in the snippet unescaped. Sanitize by building DOM
  // nodes ourselves: split on the <mark> delimiters and wrap matched runs.
  appendMarkedSnippet(snip, r.snippet);
  row.appendChild(snip);

  row.addEventListener("click", () => jumpToPage(r.page));
  return row;
}

function appendMarkedSnippet(parent: HTMLElement, snippet: string): void {
  // Simple split: snippet is "before<mark>match</mark>after<mark>...</mark>...".
  // We don't trust the server's HTML so we never use innerHTML.
  const re = /<mark>([\s\S]*?)<\/mark>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(snippet)) !== null) {
    if (m.index > last) {
      parent.appendChild(
        document.createTextNode(snippet.slice(last, m.index)),
      );
    }
    const mark = document.createElement("mark");
    mark.textContent = m[1];
    parent.appendChild(mark);
    last = m.index + m[0].length;
  }
  if (last < snippet.length) {
    parent.appendChild(document.createTextNode(snippet.slice(last)));
  }
}

/** For tests. */
export function _resetForTest(): void {
  activeDocId = null;
  focusInputFn = null;
}
