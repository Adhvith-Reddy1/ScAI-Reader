/**
 * Singleton pinned card showing the AI explanation for a figure.
 *
 * Unlike the hover tooltip on blue highlights, this stays open until the
 * user dismisses it (close button, Escape, or opening a different figure).
 * It anchors to the right margin of the figure if there's room, otherwise
 * just below the figure. Positioning is page-anchored so it follows the
 * page when the user scrolls.
 */

import type { PageFigure } from "../api.ts";
import {
  getFigureState,
  startFigureExplanation,
  subscribeFigure,
} from "../figureStore.ts";

const CARD_WIDTH_PX = 340;
const MARGIN_PX = 12;

let cardEl: HTMLDivElement | null = null;
let titleEl: HTMLDivElement | null = null;
let bodyEl: HTMLDivElement | null = null;
let unsubscribe: (() => void) | null = null;
let activeDocId: string | null = null;
let activeFigureId: string | null = null;

function ensureCard(): HTMLDivElement {
  if (cardEl) return cardEl;
  const el = document.createElement("div");
  el.className = "figure-card";
  el.setAttribute("role", "dialog");
  el.style.display = "none";

  const header = document.createElement("div");
  header.className = "figure-card-header";

  const title = document.createElement("div");
  title.className = "figure-card-title";
  header.appendChild(title);

  const close = document.createElement("button");
  close.className = "figure-card-close";
  close.setAttribute("aria-label", "Close figure explanation");
  close.textContent = "×";
  close.addEventListener("click", () => hideFigureCard());
  header.appendChild(close);

  el.appendChild(header);

  const body = document.createElement("div");
  body.className = "figure-card-body";
  el.appendChild(body);

  document.body.appendChild(el);
  cardEl = el;
  titleEl = title;
  bodyEl = body;

  // Esc dismisses.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && el.style.display !== "none") {
      hideFigureCard();
    }
  });
  return el;
}

function render(): void {
  if (!activeDocId || !activeFigureId) return;
  const state = getFigureState(activeDocId, activeFigureId);
  const el = ensureCard();
  const body = bodyEl!;

  el.classList.remove("is-loading", "is-error", "is-ready");
  if (state.status === "loading") {
    el.classList.add("is-loading");
    body.textContent = state.content || "Looking at the figure…";
  } else if (state.status === "ready") {
    el.classList.add("is-ready");
    body.textContent = state.content;
  } else if (state.status === "error") {
    el.classList.add("is-error");
    body.textContent = state.error;
  } else {
    body.textContent = "Loading…";
  }
}

function positionCard(figureRectViewport: DOMRect): void {
  const el = ensureCard();
  el.style.display = "block";
  el.style.width = `${CARD_WIDTH_PX}px`;
  const cardHeight = el.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Try right side of the figure first.
  let left = figureRectViewport.right + MARGIN_PX;
  let top = figureRectViewport.top;
  if (left + CARD_WIDTH_PX > vw - MARGIN_PX) {
    // Try left side.
    const altLeft = figureRectViewport.left - CARD_WIDTH_PX - MARGIN_PX;
    if (altLeft >= MARGIN_PX) {
      left = altLeft;
    } else {
      // Fall back to below the figure, centered horizontally.
      left = Math.max(
        MARGIN_PX,
        Math.min(
          figureRectViewport.left +
            figureRectViewport.width / 2 -
            CARD_WIDTH_PX / 2,
          vw - CARD_WIDTH_PX - MARGIN_PX,
        ),
      );
      top = figureRectViewport.bottom + MARGIN_PX;
    }
  }
  // Clamp vertically.
  if (top + cardHeight > vh - MARGIN_PX) {
    top = Math.max(MARGIN_PX, vh - cardHeight - MARGIN_PX);
  }
  if (top < MARGIN_PX) top = MARGIN_PX;

  el.style.left = `${left + window.scrollX}px`;
  el.style.top = `${top + window.scrollY}px`;
}

export function showFigureCard(
  docId: string,
  figure: PageFigure,
  figureRectViewport: DOMRect,
): void {
  ensureCard();
  if (unsubscribe) unsubscribe();
  activeDocId = docId;
  activeFigureId = figure.figure_id;
  if (titleEl) titleEl.textContent = figure.label;

  unsubscribe = subscribeFigure(docId, figure.figure_id, () => {
    if (
      activeDocId === docId &&
      activeFigureId === figure.figure_id
    ) {
      render();
    }
  });

  render();
  positionCard(figureRectViewport);

  // Kick off the stream if we don't already have content.
  const state = getFigureState(docId, figure.figure_id);
  if (state.status === "idle") {
    void startFigureExplanation(docId, figure.figure_id, figure.page, figure.label);
  }
}

export function hideFigureCard(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  activeDocId = null;
  activeFigureId = null;
  if (cardEl) cardEl.style.display = "none";
}
