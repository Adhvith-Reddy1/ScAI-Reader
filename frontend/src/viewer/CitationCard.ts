/**
 * Singleton textbox shown when the reader clicks an in-text citation marker.
 *
 * It resolves the marker's number(s) against the document's parsed reference
 * list (referenceStore) and shows the author(s) and title of each cited work.
 * Positioning mirrors FigureCard: anchored next to the marker, page-relative
 * so it tracks scrolling, dismissed by the close button, Escape, or clicking
 * a different marker.
 */

import type { CitationMarker, ReferenceEntry } from "../api.ts";
import {
  getReferencesState,
  loadReferences,
  subscribeReferences,
} from "../referenceStore.ts";

const CARD_WIDTH_PX = 320;
const MARGIN_PX = 10;

let cardEl: HTMLDivElement | null = null;
let titleEl: HTMLDivElement | null = null;
let bodyEl: HTMLDivElement | null = null;
let unsubscribe: (() => void) | null = null;
let activeDocId: string | null = null;
let activeMarker: CitationMarker | null = null;

function ensureCard(): HTMLDivElement {
  if (cardEl) return cardEl;
  const el = document.createElement("div");
  el.className = "citation-card";
  el.setAttribute("role", "dialog");
  el.style.display = "none";

  const header = document.createElement("div");
  header.className = "citation-card-header";

  const title = document.createElement("div");
  title.className = "citation-card-title";
  header.appendChild(title);

  const close = document.createElement("button");
  close.className = "citation-card-close";
  close.setAttribute("aria-label", "Close citation");
  close.textContent = "×";
  close.addEventListener("click", () => hideCitationCard());
  header.appendChild(close);

  el.appendChild(header);

  const body = document.createElement("div");
  body.className = "citation-card-body";
  el.appendChild(body);

  document.body.appendChild(el);
  cardEl = el;
  titleEl = title;
  bodyEl = body;

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && el.style.display !== "none") hideCitationCard();
  });
  return el;
}

function renderEntry(ref: ReferenceEntry): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "citation-entry";

  const num = document.createElement("span");
  num.className = "citation-entry-num";
  num.textContent = `[${ref.number}]`;
  row.appendChild(num);

  const detail = document.createElement("div");
  detail.className = "citation-entry-detail";

  const titleLine = document.createElement("div");
  titleLine.className = "citation-entry-title";
  titleLine.textContent = ref.title || "Untitled work";
  detail.appendChild(titleLine);

  if (ref.authors) {
    const authorLine = document.createElement("div");
    authorLine.className = "citation-entry-authors";
    authorLine.textContent = ref.authors;
    detail.appendChild(authorLine);
  }

  row.appendChild(detail);
  return row;
}

function renderMissing(number: number, message: string): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "citation-entry is-missing";
  const num = document.createElement("span");
  num.className = "citation-entry-num";
  num.textContent = `[${number}]`;
  row.appendChild(num);
  const detail = document.createElement("div");
  detail.className = "citation-entry-detail";
  detail.textContent = message;
  row.appendChild(detail);
  return row;
}

function render(): void {
  if (!activeDocId || !activeMarker) return;
  const el = ensureCard();
  const body = bodyEl!;
  body.replaceChildren();

  const state = getReferencesState(activeDocId);
  el.classList.remove("is-loading", "is-error");

  if (state.status === "loading" || state.status === "idle") {
    el.classList.add("is-loading");
    body.textContent = "Resolving reference…";
    return;
  }
  if (state.status === "error") {
    el.classList.add("is-error");
    body.replaceChildren();
    const headline = document.createElement("div");
    headline.textContent = "Couldn't read this document's reference list.";
    body.appendChild(headline);
    if (state.message) {
      const detail = document.createElement("div");
      detail.className = "citation-error-detail";
      detail.textContent = state.message;
      body.appendChild(detail);
    }
    return;
  }
  if (state.status === "empty") {
    body.textContent = "No reference list was found in this document.";
    return;
  }

  // status === "ready": resolve each number the marker points at.
  for (const number of activeMarker.numbers) {
    const ref = state.byNumber.get(number);
    body.appendChild(
      ref ? renderEntry(ref) : renderMissing(number, "Not found in reference list."),
    );
  }
}

function positionCard(anchor: DOMRect): void {
  const el = ensureCard();
  el.style.display = "block";
  el.style.width = `${CARD_WIDTH_PX}px`;
  const cardHeight = el.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Prefer directly below the marker, left-aligned to it.
  let left = anchor.left;
  let top = anchor.bottom + MARGIN_PX;

  if (left + CARD_WIDTH_PX > vw - MARGIN_PX) {
    left = Math.max(MARGIN_PX, vw - CARD_WIDTH_PX - MARGIN_PX);
  }
  if (left < MARGIN_PX) left = MARGIN_PX;

  // If it would overflow the bottom, flip above the marker.
  if (top + cardHeight > vh - MARGIN_PX) {
    const above = anchor.top - cardHeight - MARGIN_PX;
    top = above >= MARGIN_PX ? above : Math.max(MARGIN_PX, vh - cardHeight - MARGIN_PX);
  }

  el.style.left = `${left + window.scrollX}px`;
  el.style.top = `${top + window.scrollY}px`;
}

export function showCitationCard(
  docId: string,
  marker: CitationMarker,
  anchor: DOMRect,
): void {
  ensureCard();
  if (unsubscribe) unsubscribe();
  activeDocId = docId;
  activeMarker = marker;
  if (titleEl) {
    const label =
      marker.numbers.length > 1 ? `Citations ${marker.raw}` : `Citation ${marker.raw}`;
    titleEl.textContent = label;
  }

  // Make sure the parse is running, and re-render as it settles.
  loadReferences(docId);
  unsubscribe = subscribeReferences(docId, () => {
    if (activeDocId === docId && activeMarker === marker) render();
  });

  render();
  positionCard(anchor);
}

export function hideCitationCard(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  activeDocId = null;
  activeMarker = null;
  if (cardEl) cardEl.style.display = "none";
}
