/**
 * Singleton pinned card showing the AI explanation for a figure.
 *
 * Like the definition/explanation tooltip once it's pinned open, this
 * dismisses when the reader clicks outside it, presses Escape, or clicks
 * its own close button — and supports a follow-up chat thread for when the
 * first interpretation wasn't enough. Unlike the highlight tooltip it isn't
 * hover-driven: it opens directly on double-click and stays open (no
 * separate "pinned" state to toggle), so the chat is available as soon as
 * an interpretation is ready.
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

const CARD_WIDTH_PX = 340;
const MARGIN_PX = 12;

let cardEl: HTMLDivElement | null = null;
let titleEl: HTMLDivElement | null = null;
let bodyEl: HTMLDivElement | null = null;
let chatEl: HTMLDivElement | null = null;
let threadEl: HTMLDivElement | null = null;
let chatErrorEl: HTMLDivElement | null = null;
let inputEl: HTMLInputElement | null = null;
let sendEl: HTMLButtonElement | null = null;
let unsubscribe: (() => void) | null = null;
let activeDocId: string | null = null;
let activeFigureId: string | null = null;
let activeFigure: PageFigure | null = null;
let activeRectViewport: DOMRect | null = null;

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

  // Follow-up chat — same structure/classes as the highlight tooltip's
  // pinned chat, so it picks up the same styling for free.
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

  document.body.appendChild(el);
  cardEl = el;
  titleEl = title;
  bodyEl = body;
  chatEl = chat;
  threadEl = thread;
  chatErrorEl = chatError;
  inputEl = input;
  sendEl = send;

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
  const state = getFigureState(activeDocId, activeFigureId);
  const chatAvailable = state.status === "ready";
  if (chatEl) chatEl.style.display = chatAvailable ? "flex" : "none";
  if (!chatAvailable) return;

  const chat = getFigureChat(activeDocId, activeFigureId);

  const thread = threadEl!;
  thread.replaceChildren();
  for (const msg of chat.messages) {
    const row = document.createElement("div");
    row.className = `explanation-chat-msg is-${msg.role}`;
    row.textContent = msg.content;
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
    body.textContent = state.content || "Looking at the figure…";
  } else if (state.status === "ready") {
    el.classList.add("is-ready");
    body.textContent = state.content;
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
  activeFigure = figure;
  activeRectViewport = figureRectViewport;
  if (titleEl) titleEl.textContent = figure.label;

  unsubscribe = subscribeFigure(docId, figure.figure_id, () => {
    if (
      activeDocId === docId &&
      activeFigureId === figure.figure_id
    ) {
      render();
      // Content (or the chat thread) can change the card's height —
      // re-clamp to the viewport so it never drifts off-screen.
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
  if (cardEl) cardEl.style.display = "none";
}

/** Test-only: tear down the singleton card and reset module state. */
export function _resetForTest(): void {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  activeDocId = null;
  activeFigureId = null;
  activeFigure = null;
  activeRectViewport = null;
  cardEl?.remove();
  cardEl = null;
  titleEl = null;
  bodyEl = null;
  chatEl = null;
  threadEl = null;
  chatErrorEl = null;
  inputEl = null;
  sendEl = null;
}
