/**
 * Singleton card showing the AI explanation for a figure.
 *
 * Mirrors the highlight explanation/definition tooltip's collapsed → pinned
 * flow: double-click opens it collapsed (interpretation text + an "Ask a
 * follow-up ›" button), and only clicking that promotes it to the full
 * resizable chat panel. It dismisses in either state when the reader clicks
 * outside it, presses Escape, or (once pinned) clicks its own close button.
 * Unlike the highlight tooltip it isn't hover-driven — it opens on
 * double-click rather than a dwell timer, and there's no "sticky-open new
 * highlight" equivalent — but the collapsed/pinned chrome and behavior are
 * otherwise the same.
 *
 * It anchors to the right margin of the figure if there's room, otherwise
 * just below the figure. Positioning is page-anchored so it follows the
 * page when the user scrolls.
 */

import {
  AI_NOT_CONFIGURED_CODE,
  AI_QUOTA_EXCEEDED_CODE,
  type PageFigure,
} from "../api.ts";
import { renderFormattedText } from "../aiText.ts";
import { openAiSetup } from "../AiSetup.ts";
import { openUserKeyPrompt } from "../UserKeyPrompt.ts";
import {
  getFigureChat,
  getFigureState,
  retryFigureExplanation,
  sendFigureChatMessage,
  startFigureExplanation,
  subscribeFigure,
} from "../figureStore.ts";
import { ResizablePanel } from "./ResizablePanel.ts";

// Collapsed width mirrors the explanation/definition tooltip's collapsed
// look (content-sized, no resize). Pinned defaults mirror its pinned-chat
// sizing — wide/tall enough to read comfortably, capped well under the
// viewport so the thread scrolls internally instead of the card growing
// without limit.
const COLLAPSED_WIDTH_PX = 340;
const DEFAULT_CARD_WIDTH = 380;
const DEFAULT_CAP_PX = 480;
const RESIZE_MIN_W = 260;
const RESIZE_MIN_H = 200;
const MARGIN_PX = 12;

const SAVED_SIZE_KEY = "scai.figureBoxSize";

let cardEl: HTMLDivElement | null = null;
let titleEl: HTMLDivElement | null = null;
let bodyEl: HTMLDivElement | null = null;
let closeEl: HTMLButtonElement | null = null;
let chatEl: HTMLDivElement | null = null;
let threadEl: HTMLDivElement | null = null;
let chatErrorEl: HTMLDivElement | null = null;
let inputEl: HTMLInputElement | null = null;
let sendEl: HTMLButtonElement | null = null;
let footEl: HTMLDivElement | null = null;
let unsubscribe: (() => void) | null = null;
let activeDocId: string | null = null;
let activeFigureId: string | null = null;
let activeFigure: PageFigure | null = null;
let activeRectViewport: DOMRect | null = null;
// Once the reader clicks "Ask a follow-up ›" the card is "pinned": the full
// resizable chat panel replaces the collapsed footer — same distinction as
// the highlight explanation tooltip's collapsed vs. pinned state.
let pinned = false;
// Owns the card's resize handles, drag-to-resize, and remembered
// {width, height} — the same shared behavior the pinned explanation panel
// uses, so the two panels can't drift apart. Built once, alongside the rest
// of the DOM, in ensureCard().
let resizePanel: ResizablePanel | null = null;

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

  // Hidden until pinned — collapsed state dismisses via outside-click/Escape
  // only, same as the highlight explanation tooltip's collapsed look.
  const close = document.createElement("button");
  close.className = "figure-card-close";
  close.setAttribute("aria-label", "Close figure explanation");
  close.textContent = "×";
  close.style.display = "none";
  close.addEventListener("click", () => hideFigureCard());
  header.appendChild(close);

  el.appendChild(header);

  const body = document.createElement("div");
  body.className = "figure-card-body";
  el.appendChild(body);

  // Follow-up chat — same structure/classes as the highlight tooltip's
  // pinned chat, so it picks up the same styling for free. Hidden until the
  // card is pinned.
  const chat = document.createElement("div");
  chat.className = "explanation-chat";

  const thread = document.createElement("div");
  thread.className = "explanation-chat-thread";
  chat.appendChild(thread);

  const chatError = document.createElement("div");
  chatError.className = "explanation-chat-error";
  chat.appendChild(chatError);

  const form = document.createElement("form");
  form.className = "explanation-chat-form";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "explanation-chat-input";
  input.placeholder = "Ask a follow-up…";
  const send = document.createElement("button");
  send.type = "submit";
  send.className = "explanation-chat-send";
  send.textContent = "Send";
  form.appendChild(input);
  form.appendChild(send);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submitChat();
  });
  chat.appendChild(form);
  el.appendChild(chat);

  // Collapsed-state footer: just "Ask a follow-up ›" (figures have no
  // Delete-equivalent, unlike the highlight tooltip's footer).
  const foot = document.createElement("div");
  foot.className = "figure-card-foot";
  const openChat = document.createElement("button");
  openChat.type = "button";
  openChat.className = "explanation-chat-open";
  openChat.textContent = "Ask a follow-up ›";
  openChat.addEventListener("click", () => {
    pinned = true;
    render();
    if (activeRectViewport) positionCard(activeRectViewport);
    inputEl?.focus();
  });
  foot.appendChild(openChat);
  el.appendChild(foot);

  // Eight resize handles (edges + corners) — shared with the pinned
  // explanation/definition panel so the two panels' resize behavior can't
  // drift apart. Only interactive once pinned (gated in CSS via .is-pinned).
  resizePanel = new ResizablePanel({
    el,
    storageKey: SAVED_SIZE_KEY,
    defaultWidth: DEFAULT_CARD_WIDTH,
    defaultHeight: DEFAULT_CAP_PX,
    minWidth: RESIZE_MIN_W,
    minHeight: RESIZE_MIN_H,
  });

  document.body.appendChild(el);
  cardEl = el;
  titleEl = title;
  bodyEl = body;
  closeEl = close;
  chatEl = chat;
  threadEl = thread;
  chatErrorEl = chatError;
  inputEl = input;
  sendEl = send;
  footEl = foot;

  // Esc dismisses.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && el.style.display !== "none") {
      hideFigureCard();
    }
  });

  // Clicking anywhere outside the card closes it — same rule as the
  // pinned highlight-explanation panel.
  document.addEventListener("pointerdown", (e) => {
    if (el.style.display === "none") return;
    if (!el.contains(e.target as Node)) {
      hideFigureCard();
    }
  });

  return el;
}

function submitChat(): void {
  if (!activeDocId || !activeFigureId || !activeFigure) return;
  if (!inputEl) return;
  const value = inputEl.value;
  if (!value.trim()) return;
  sendFigureChatMessage(
    activeDocId,
    activeFigureId,
    activeFigure.page,
    activeFigure.label,
    value,
    activeFigure.bbox,
  );
  inputEl.value = "";
}

function renderChat(): void {
  if (!activeDocId || !activeFigureId) return;
  const el = cardEl!;
  const state = getFigureState(activeDocId, activeFigureId);
  const chatAvailable = state.status === "ready";

  el.classList.toggle("is-pinned", pinned);
  // Close (×) only appears once pinned — same rule as the highlight
  // explanation tooltip. The collapsed footer ("Ask a follow-up ›") shows
  // only once there's an interpretation worth following up on, and hides
  // once pinned (the chat itself replaces it).
  if (closeEl) closeEl.style.display = pinned ? "block" : "none";
  if (footEl) footEl.style.display = !pinned && chatAvailable ? "flex" : "none";
  if (chatEl) chatEl.style.display = pinned && chatAvailable ? "flex" : "none";
  if (!pinned || !chatAvailable) return;

  const chat = getFigureChat(activeDocId, activeFigureId);

  const thread = threadEl!;
  thread.replaceChildren();
  for (const msg of chat.messages) {
    const row = document.createElement("div");
    row.className = `explanation-chat-msg is-${msg.role}`;
    renderFormattedText(row, msg.content);
    thread.appendChild(row);
  }
  thread.classList.toggle("is-streaming", chat.streaming);
  thread.scrollTop = thread.scrollHeight;

  if (chatErrorEl) {
    chatErrorEl.textContent = chat.error ?? "";
    chatErrorEl.style.display = chat.error ? "block" : "none";
  }

  if (inputEl) inputEl.disabled = chat.streaming;
  if (sendEl) sendEl.disabled = chat.streaming;
}

function render(): void {
  if (!activeDocId || !activeFigureId) return;
  const state = getFigureState(activeDocId, activeFigureId);
  const el = ensureCard();
  const body = bodyEl!;

  el.classList.remove("is-loading", "is-error", "is-ready");
  if (state.status === "loading") {
    el.classList.add("is-loading");
    renderFormattedText(body, state.content || "Looking at the figure…");
  } else if (state.status === "ready") {
    el.classList.add("is-ready");
    renderFormattedText(body, state.content);
  } else if (state.status === "error") {
    el.classList.add("is-error");
    if (state.code === AI_NOT_CONFIGURED_CODE) {
      // Guide the reader to setup instead of leaving them at a dead end.
      body.textContent = "";
      const msg = document.createElement("span");
      msg.textContent = "Turn on AI explanations with a one-time API key. ";
      const setup = document.createElement("button");
      setup.type = "button";
      setup.className = "explanation-setup-ai";
      setup.textContent = "Set up AI →";
      setup.addEventListener("click", (e) => {
        e.stopPropagation();
        openAiSetup();
      });
      body.append(msg, setup);
    } else if (state.code === AI_QUOTA_EXCEEDED_CODE) {
      body.textContent = "";
      const msg = document.createElement("span");
      msg.textContent = "Daily free AI limit reached. Add your own API key to keep going. ";
      const addKey = document.createElement("button");
      addKey.type = "button";
      addKey.className = "explanation-setup-ai";
      addKey.textContent = "Add key →";
      addKey.addEventListener("click", (e) => {
        e.stopPropagation();
        const docId = activeDocId;
        const figure = activeFigure;
        openUserKeyPrompt(() => {
          if (docId && figure) {
            retryFigureExplanation(
              docId,
              figure.figure_id,
              figure.page,
              figure.label,
              figure.bbox,
            );
          }
        });
      });
      body.append(msg, addKey);
    } else {
      body.textContent = state.error;
    }
  } else {
    body.textContent = "Loading…";
  }

  renderChat();
}

function positionCard(figureRectViewport: DOMRect): void {
  const el = ensureCard();
  const panel = resizePanel!;
  el.style.display = pinned ? "flex" : "block";

  // Once pinned, the card is positioned (and sized) exactly once per open
  // session — same rule as the pinned explanation panel. After that,
  // re-renders (new chat messages arriving) and resize drags own its
  // geometry; the capped height means content growth never needs to push
  // the card around anyway. While collapsed, keep repositioning each render
  // (content — the streaming interpretation — can change its height).
  if (pinned && panel.placed) return;

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let width: number;
  if (pinned) {
    const size = panel.size;
    width = Math.min(size.width, vw - MARGIN_PX * 2);
    el.style.width = `${width}px`;
    // Height is left to grow with content up to the cap (the thread scrolls
    // once it hits that), so clear any stale explicit height and apply a
    // provisional cap to measure with.
    el.style.height = "";
    el.style.maxHeight = `${Math.min(size.height, vh - MARGIN_PX * 2)}px`;
    panel.markPlaced();
  } else {
    width = Math.min(COLLAPSED_WIDTH_PX, vw - MARGIN_PX * 2);
    el.style.width = `${width}px`;
    el.style.height = "";
    el.style.maxHeight = "";
  }

  const cardHeight = el.offsetHeight;

  // Try right side of the figure first.
  let left = figureRectViewport.right + MARGIN_PX;
  let top = figureRectViewport.top;
  if (left + width > vw - MARGIN_PX) {
    // Try left side.
    const altLeft = figureRectViewport.left - width - MARGIN_PX;
    if (altLeft >= MARGIN_PX) {
      left = altLeft;
    } else {
      // Fall back to below the figure, centered horizontally.
      left = Math.max(
        MARGIN_PX,
        Math.min(
          figureRectViewport.left + figureRectViewport.width / 2 - width / 2,
          vw - width - MARGIN_PX,
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

  // Final cap: grow only as far as the bottom of the screen allows, never
  // past the remembered/default cap. Beyond this the thread scrolls. Only
  // applies while pinned — the collapsed card isn't capped.
  if (pinned) {
    el.style.maxHeight = `${Math.min(panel.size.height, vh - top - MARGIN_PX)}px`;
  }

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
  activeFigure = figure;
  activeRectViewport = figureRectViewport;
  // Every open starts collapsed — same as the highlight explanation
  // tooltip, the chat only opens when the reader asks for it.
  pinned = false;
  if (titleEl) titleEl.textContent = figure.label;

  unsubscribe = subscribeFigure(docId, figure.figure_id, () => {
    if (
      activeDocId === docId &&
      activeFigureId === figure.figure_id
    ) {
      render();
      // positionCard() no-ops once the card has been placed for this open
      // session (its height is capped, so content/chat growth never needs
      // to push it around) — this call just re-anchors it the first time.
      if (activeRectViewport) positionCard(activeRectViewport);
    }
  });

  render();
  positionCard(figureRectViewport);

  // Kick off the stream if we don't already have content.
  const state = getFigureState(docId, figure.figure_id);
  if (state.status === "idle") {
    void startFigureExplanation(
      docId,
      figure.figure_id,
      figure.page,
      figure.label,
      figure.bbox,
    );
  }
}

export function hideFigureCard(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  activeDocId = null;
  activeFigureId = null;
  activeFigure = null;
  activeRectViewport = null;
  pinned = false;
  // The card must be re-placed next open, but the reader's chosen size is
  // remembered by resizePanel and re-applied then.
  resizePanel?.reset();
  if (cardEl) {
    cardEl.style.display = "none";
    // Drop the explicit height so the saved height is re-applied as the
    // grow-to cap (rather than a stale fixed value) next open.
    cardEl.style.height = "";
  }
}

/** Test-only: tear down the singleton card and reset module state. */
export function _resetForTest(): void {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  activeDocId = null;
  activeFigureId = null;
  activeFigure = null;
  activeRectViewport = null;
  pinned = false;
  cardEl?.remove();
  cardEl = null;
  titleEl = null;
  bodyEl = null;
  closeEl = null;
  chatEl = null;
  threadEl = null;
  chatErrorEl = null;
  inputEl = null;
  sendEl = null;
  footEl = null;
  resizePanel = null;
}
