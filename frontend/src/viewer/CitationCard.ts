/**
 * Singleton card showing bibliography details for a clicked citation
 * marker — lead author, paper title, and a link to the paper. Same visual
 * language and dismiss behavior (outside click / Escape / close button) as
 * FigureCard and the definition/explanation tooltip, but with static
 * content: no AI generation, no chat — just the parsed reference.
 *
 * A single marker can carry more than one key (a compound citation like
 * "[3, 7]" produces two mentions at the same spot — see CitationLayer), so
 * the card renders one block per key in that case.
 */

import type { CitationEntry } from "../api.ts";
import { citationLink, getDocumentCitations, leadAuthor } from "../citations.ts";

const CARD_WIDTH_PX = 320;
const MARGIN_PX = 12;

let cardEl: HTMLDivElement | null = null;
let bodyEl: HTMLDivElement | null = null;
let activeRectViewport: DOMRect | null = null;
// Bumped on every show()/hide() so a slow fetch from a superseded call can't
// clobber the card after the reader has already moved on to another marker.
let activeToken = 0;
// Document-level listeners are re-bound each time ensureCard() (re)creates
// the singleton element (only happens after _resetForTest in practice, since
// the real app creates it once) — tracked so _resetForTest can remove the
// old pair instead of leaving them stacked up watching a detached element.
let docKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
let docPointerdownHandler: ((e: PointerEvent) => void) | null = null;

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
  title.textContent = "Citation";
  header.appendChild(title);

  const close = document.createElement("button");
  close.type = "button";
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
  bodyEl = body;

  docKeydownHandler = (e) => {
    if (e.key === "Escape" && el.style.display !== "none") hideCitationCard();
  };
  // Clicking anywhere outside the card closes it — same rule as FigureCard
  // and the pinned explanation panel.
  docPointerdownHandler = (e) => {
    if (el.style.display === "none") return;
    if (!el.contains(e.target as Node)) hideCitationCard();
  };
  document.addEventListener("keydown", docKeydownHandler);
  document.addEventListener("pointerdown", docPointerdownHandler);

  return el;
}

function renderEntry(container: HTMLElement, entry: CitationEntry): void {
  const block = document.createElement("div");
  block.className = "citation-card-entry";

  const author = document.createElement("div");
  author.className = "citation-card-author";
  author.textContent = leadAuthor(entry) ?? "Lead author unavailable";
  block.appendChild(author);

  const title = document.createElement("div");
  title.className = "citation-card-paper-title";
  title.textContent = entry.title ?? entry.raw_text;
  block.appendChild(title);

  const link = citationLink(entry);
  const a = document.createElement("a");
  a.className = "citation-card-link";
  a.href = link.url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = link.label;
  block.appendChild(a);

  container.appendChild(block);
}

function renderMissing(container: HTMLElement, key: string): void {
  const block = document.createElement("div");
  block.className = "citation-card-entry citation-card-entry-missing";
  block.textContent = `Reference ${key} not found.`;
  container.appendChild(block);
}

function positionCard(anchorRectViewport: DOMRect): void {
  const el = ensureCard();
  el.style.display = "block";
  el.style.width = `${CARD_WIDTH_PX}px`;
  const cardHeight = el.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Try right side of the marker first.
  let left = anchorRectViewport.right + MARGIN_PX;
  let top = anchorRectViewport.top;
  if (left + CARD_WIDTH_PX > vw - MARGIN_PX) {
    // Try left side.
    const altLeft = anchorRectViewport.left - CARD_WIDTH_PX - MARGIN_PX;
    if (altLeft >= MARGIN_PX) {
      left = altLeft;
    } else {
      // Fall back to below the marker, centered horizontally.
      left = Math.max(
        MARGIN_PX,
        Math.min(
          anchorRectViewport.left + anchorRectViewport.width / 2 - CARD_WIDTH_PX / 2,
          vw - CARD_WIDTH_PX - MARGIN_PX,
        ),
      );
      top = anchorRectViewport.bottom + MARGIN_PX;
    }
  }
  if (top + cardHeight > vh - MARGIN_PX) {
    top = Math.max(MARGIN_PX, vh - cardHeight - MARGIN_PX);
  }
  if (top < MARGIN_PX) top = MARGIN_PX;

  el.style.left = `${left + window.scrollX}px`;
  el.style.top = `${top + window.scrollY}px`;
}

export async function showCitationCard(
  docId: string,
  keys: string[],
  anchorRectViewport: DOMRect,
): Promise<void> {
  const el = ensureCard();
  const body = bodyEl!;
  activeRectViewport = anchorRectViewport;
  const token = ++activeToken;

  el.classList.remove("is-error");
  body.replaceChildren();
  const loading = document.createElement("div");
  loading.className = "citation-card-loading";
  loading.textContent = "Loading…";
  body.appendChild(loading);
  positionCard(anchorRectViewport);

  let entries: CitationEntry[];
  try {
    entries = await getDocumentCitations(docId);
  } catch {
    if (token !== activeToken) return; // superseded by a newer click
    el.classList.add("is-error");
    body.replaceChildren();
    const err = document.createElement("div");
    err.className = "citation-card-error";
    err.textContent = "Couldn't load citation details.";
    body.appendChild(err);
    if (activeRectViewport) positionCard(activeRectViewport);
    return;
  }
  if (token !== activeToken) return; // superseded by a newer click

  const byKey = new Map(entries.map((e) => [e.key, e]));
  body.replaceChildren();
  for (const key of keys) {
    const entry = byKey.get(key);
    if (entry) renderEntry(body, entry);
    else renderMissing(body, key);
  }
  if (activeRectViewport) positionCard(activeRectViewport);
}

export function hideCitationCard(): void {
  activeToken++;
  activeRectViewport = null;
  if (cardEl) cardEl.style.display = "none";
}

/** Test-only: tear down the singleton card and reset module state. */
export function _resetForTest(): void {
  activeToken++;
  activeRectViewport = null;
  if (docKeydownHandler) document.removeEventListener("keydown", docKeydownHandler);
  if (docPointerdownHandler) document.removeEventListener("pointerdown", docPointerdownHandler);
  docKeydownHandler = null;
  docPointerdownHandler = null;
  cardEl?.remove();
  cardEl = null;
  bodyEl = null;
}
