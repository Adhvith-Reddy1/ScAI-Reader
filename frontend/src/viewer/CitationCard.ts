/**
 * Singleton textbox shown when the reader clicks an in-text citation marker.
 *
 * Resolution is done on the backend: each marker arrives with its reference(s)
 * already attached (author + title). This card just renders them. While the
 * bibliography is still parsing, markers come back unresolved; the page
 * re-fetches when the parse finishes and calls `refreshCitationCard`, which
 * updates an open card in place (or closes it if precision-filtering dropped
 * the marker).
 */

import type { CitationMarker, PageCitationsResponse, ReferenceEntry } from "../api.ts";

type RefStatus = PageCitationsResponse["references_status"];

const CARD_WIDTH_PX = 320;
const MARGIN_PX = 10;

let cardEl: HTMLDivElement | null = null;
let titleEl: HTMLDivElement | null = null;
let bodyEl: HTMLDivElement | null = null;
let activeDocId: string | null = null;
let activeMarker: CitationMarker | null = null;
let activeStatus: RefStatus = "absent";
let activeError: string | null = null;

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
  if (!activeMarker) return;
  const el = ensureCard();
  const body = bodyEl!;
  body.replaceChildren();
  el.classList.remove("is-loading", "is-error");

  // Resolved: render the attached reference(s).
  if (activeMarker.references.length > 0) {
    for (const ref of activeMarker.references) body.appendChild(renderEntry(ref));
    return;
  }

  // Unresolved — explain why based on the bibliography parse state.
  if (activeStatus === "pending" || activeStatus === "absent") {
    el.classList.add("is-loading");
    body.textContent = "Resolving reference…";
    return;
  }
  if (activeStatus === "empty") {
    body.textContent = "No reference list was found in this document.";
    return;
  }
  if (activeStatus === "error") {
    el.classList.add("is-error");
    const headline = document.createElement("div");
    headline.textContent = "Couldn't read this document's reference list.";
    body.appendChild(headline);
    if (activeError) {
      const detail = document.createElement("div");
      detail.className = "citation-error-detail";
      detail.textContent = activeError;
      body.appendChild(detail);
    }
    return;
  }
  // Parsed, but this marker's number isn't in the list (a link marker we kept
  // as ground truth even though it didn't resolve).
  for (const number of activeMarker.numbers) {
    body.appendChild(renderMissing(number, "Not found in reference list."));
  }
}

function setTitle(marker: CitationMarker): void {
  if (!titleEl) return;
  titleEl.textContent =
    marker.numbers.length > 1 ? `Citations ${marker.raw}` : `Citation ${marker.raw}`;
}

function positionCard(anchor: DOMRect): void {
  const el = ensureCard();
  el.style.display = "block";
  el.style.width = `${CARD_WIDTH_PX}px`;
  const cardHeight = el.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let left = anchor.left;
  let top = anchor.bottom + MARGIN_PX;

  if (left + CARD_WIDTH_PX > vw - MARGIN_PX) {
    left = Math.max(MARGIN_PX, vw - CARD_WIDTH_PX - MARGIN_PX);
  }
  if (left < MARGIN_PX) left = MARGIN_PX;

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
  status: RefStatus,
  error: string | null = null,
): void {
  ensureCard();
  activeDocId = docId;
  activeMarker = marker;
  activeStatus = status;
  activeError = error;
  setTitle(marker);
  render();
  positionCard(anchor);
}

/**
 * Called after a page re-fetches its citations (once references finish
 * parsing). If the open card's marker is still present, update it in place;
 * if it was dropped by precision-filtering, close the card.
 */
export function refreshCitationCard(
  docId: string,
  citations: CitationMarker[],
  status: RefStatus,
  error: string | null = null,
): void {
  if (activeDocId !== docId || !activeMarker || !cardEl) return;
  if (cardEl.style.display === "none") return;
  const updated = citations.find((c) => c.marker_id === activeMarker!.marker_id);
  if (!updated) {
    hideCitationCard();
    return;
  }
  activeMarker = updated;
  activeStatus = status;
  activeError = error;
  render();
}

export function hideCitationCard(): void {
  activeDocId = null;
  activeMarker = null;
  activeStatus = "absent";
  activeError = null;
  if (cardEl) cardEl.style.display = "none";
}
