/**
 * Singleton hover tooltip that displays AI explanations for blue highlights.
 *
 * Activation rule: when the cursor sits on a blue highlight for >= 500ms,
 * the tooltip appears above the highlight with the cached explanation.
 * While the model is still streaming, the partial text renders live with
 * a shimmer caret.
 *
 * The text-layer sits above the annotation layer in DOM order (so drag
 * selection works), so `mouseenter` on the SVG group never reaches us.
 * We instead listen for `mousemove` at the page-wrap level and hit-test
 * the cursor against each blue annotation group's bounding rect.
 */

import { AI_NOT_CONFIGURED_CODE, type DocumentMeta } from "../api.ts";
import { openAiSetup } from "../AiSetup.ts";
import {
  getChat,
  getExplanationState,
  hydrateExplanation,
  refineFromChat,
  sendChatMessage,
  startExplanation,
  subscribeExplanation,
} from "../explanationStore.ts";

const DWELL_MS = 200;
const GAP_PX = 8;
const TOOLTIP_WIDTH_PX = 360;
// Pinned panel defaults: wide enough to read comfortably, and a height the box
// grows into as the reply streams before the thread starts scrolling. Kept
// well under the viewport so it never dominates the page.
const DEFAULT_PINNED_WIDTH = 600;
const DEFAULT_CAP_PX = 620;

// Tooltip singleton state.
let tooltipEl: HTMLDivElement | null = null;
let titleEl: HTMLDivElement | null = null;
let bodyEl: HTMLDivElement | null = null;
let closeEl: HTMLButtonElement | null = null;
let deleteEl: HTMLButtonElement | null = null;
let chatEl: HTMLDivElement | null = null;
let threadEl: HTMLDivElement | null = null;
let chatErrorEl: HTMLDivElement | null = null;
let inputEl: HTMLInputElement | null = null;
let sendEl: HTMLButtonElement | null = null;
let applyEl: HTMLButtonElement | null = null;
let footEl: HTMLDivElement | null = null;
let openChatEl: HTMLButtonElement | null = null;
let currentUnsubscribe: (() => void) | null = null;
let dwellTimer: number | null = null;
let hideTimer: number | null = null;
let activeAnnotationId: string | null = null;
// The annotation the cursor is currently INSIDE (may differ from the
// activeAnnotationId until the dwell timer fires).
let pendingAnnotationId: string | null = null;
// Once the reader opens the chat, the tooltip is "pinned": it stops
// auto-hiding and stops following the cursor to other highlights, so they can
// type a follow-up without it vanishing.
let pinned = false;
// Context for the pinned annotation, captured on show().
let activeDoc: DocumentMeta | null = null;
let activeText: string | null = null;
let activeGroup: SVGGElement | null = null;
let activeOnDelete: ((annotationId: string) => void) | null = null;
// The reader's preferred panel size, remembered across opens (and reloads via
// localStorage). Applied each time the panel is pinned.
let savedSize: { width: number; height: number } | null = loadSavedSize();
// Whether the pinned panel has been positioned for the current open session.
// Once placed (or resized), re-renders leave its geometry alone.
let pinnedPlaced = false;

const SAVED_SIZE_KEY = "scai.explanationBoxSize";

function loadSavedSize(): { width: number; height: number } | null {
  try {
    const raw = localStorage.getItem(SAVED_SIZE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (typeof o?.width === "number" && typeof o?.height === "number") {
      return { width: o.width, height: o.height };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function persistSavedSize(): void {
  try {
    if (savedSize) localStorage.setItem(SAVED_SIZE_KEY, JSON.stringify(savedSize));
  } catch {
    /* ignore */
  }
}

interface BlueRegistration {
  group: SVGGElement;
  doc: DocumentMeta;
  annotationId: string;
  text: string | null;
  onDelete: (annotationId: string) => void;
}

interface WrapState {
  registrations: Map<string, BlueRegistration>;
  onMove: (e: MouseEvent) => void;
  onLeave: () => void;
}

const wrapStates = new WeakMap<HTMLElement, WrapState>();

function ensureTooltip(): HTMLDivElement {
  if (tooltipEl) return tooltipEl;
  const el = document.createElement("div");
  el.className = "explanation-tooltip";
  el.setAttribute("role", "tooltip");
  el.style.display = "none";

  const head = document.createElement("div");
  head.className = "explanation-tooltip-head";
  const title = document.createElement("div");
  title.className = "explanation-tooltip-title";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "explanation-tooltip-close";
  close.setAttribute("aria-label", "Close");
  close.textContent = "×";
  close.addEventListener("click", () => {
    pinned = false;
    hide();
  });
  head.appendChild(title);
  head.appendChild(close);
  el.appendChild(head);

  const body = document.createElement("div");
  body.className = "explanation-tooltip-body";
  el.appendChild(body);

  // Chat section — revealed when pinned.
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

  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "explanation-chat-apply";
  apply.textContent = "Update explanation";
  apply.addEventListener("click", () => {
    const doc = activeDoc;
    const id = activeAnnotationId;
    const text = activeText;
    if (!doc || !id || !text) return;
    // Kick the rewrite off in the background and close immediately so the
    // reader can keep reading — the box text updates whenever the model
    // finishes, ready for the next time they hover.
    refineFromChat(doc.id, id, text);
    pinned = false;
    hide();
  });
  chat.appendChild(apply);
  el.appendChild(chat);

  // Footer: Delete on the bottom-left, "Ask a follow-up ›" on the right.
  const foot = document.createElement("div");
  foot.className = "explanation-tooltip-foot";

  const del = document.createElement("button");
  del.type = "button";
  del.className = "explanation-tooltip-delete";
  del.textContent = "Delete";
  del.addEventListener("click", () => {
    if (activeOnDelete && activeAnnotationId) {
      activeOnDelete(activeAnnotationId);
    }
  });
  foot.appendChild(del);

  const openChat = document.createElement("button");
  openChat.type = "button";
  openChat.className = "explanation-chat-open";
  openChat.textContent = "Ask a follow-up ›";
  openChat.addEventListener("click", () => {
    pinned = true;
    rerender();
    inputEl?.focus();
  });
  foot.appendChild(openChat);
  el.appendChild(foot);

  // Eight resize handles (edges + corners), only interactive when pinned.
  for (const dir of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
    const handle = document.createElement("div");
    handle.className = `explanation-resize-handle resize-${dir}`;
    handle.addEventListener("pointerdown", (ev) => startResize(dir, ev));
    el.appendChild(handle);
  }

  // While the cursor is over the tooltip itself, cancel any pending hide
  // so the user can read it (or type) without it flickering away.
  el.addEventListener("mouseenter", () => {
    if (hideTimer != null) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
  });
  el.addEventListener("mouseleave", () => scheduleHide());

  // Escape closes a pinned conversation (standard for a focusable panel).
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && pinned) {
      pinned = false;
      hide();
    }
  });

  // Clicking anywhere outside the panel closes a pinned conversation.
  document.addEventListener("pointerdown", (e) => {
    if (!pinned || !tooltipEl) return;
    if (!tooltipEl.contains(e.target as Node)) {
      pinned = false;
      hide();
    }
  });

  document.body.appendChild(el);
  tooltipEl = el;
  titleEl = title;
  bodyEl = body;
  closeEl = close;
  deleteEl = del;
  chatEl = chat;
  threadEl = thread;
  chatErrorEl = chatError;
  inputEl = input;
  sendEl = send;
  applyEl = apply;
  footEl = foot;
  openChatEl = openChat;
  return el;
}

function submitChat(): void {
  if (!activeDoc || !activeAnnotationId || !activeText || !inputEl) return;
  const value = inputEl.value;
  if (!value.trim()) return;
  sendChatMessage(activeDoc.id, activeAnnotationId, activeText, value);
  inputEl.value = "";
}

/** Re-render the active annotation and re-anchor to its highlight. */
function rerender(): void {
  if (activeAnnotationId == null) return;
  render(activeAnnotationId);
  if (activeGroup) position(activeGroup.getBoundingClientRect());
}

const RESIZE_MIN_W = 260;
const RESIZE_MIN_H = 200;

/** Drag a resize handle to size the panel; content reflows to fit. */
function startResize(dir: string, e: PointerEvent): void {
  if (!tooltipEl) return;
  e.preventDefault();
  e.stopPropagation();
  const el = tooltipEl;
  const startX = e.clientX;
  const startY = e.clientY;
  const rect = el.getBoundingClientRect();
  const startW = rect.width;
  const startH = rect.height;
  const startLeft = parseFloat(el.style.left) || rect.left + window.scrollX;
  const startTop = parseFloat(el.style.top) || rect.top + window.scrollY;
  const maxW = window.innerWidth - 24;
  const maxH = window.innerHeight - 24;

  const onMove = (ev: PointerEvent) => {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    let w = startW;
    let h = startH;
    if (dir.includes("e")) w = startW + dx;
    if (dir.includes("w")) w = startW - dx;
    if (dir.includes("s")) h = startH + dy;
    if (dir.includes("n")) h = startH - dy;
    w = Math.max(RESIZE_MIN_W, Math.min(maxW, w));
    h = Math.max(RESIZE_MIN_H, Math.min(maxH, h));
    // Dragging a west/north edge keeps the opposite edge anchored.
    const left = dir.includes("w") ? startLeft + (startW - w) : startLeft;
    const top = dir.includes("n") ? startTop + (startH - h) : startTop;

    el.style.width = `${w}px`;
    // Set height AND max-height together so the drag can grow the panel past
    // the placement cap; the dragged height becomes the new cap.
    el.style.height = `${h}px`;
    el.style.maxHeight = `${h}px`;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    pinnedPlaced = true;
    // Remember this size (height is the grow-to cap) for the next open.
    savedSize = { width: w, height: h };
    persistSavedSize();
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function clearSubscription(): void {
  if (currentUnsubscribe) {
    currentUnsubscribe();
    currentUnsubscribe = null;
  }
}

function hide(): void {
  // A pinned tooltip stays put — the reader is mid-conversation. Only an
  // explicit close (which clears `pinned` first) gets through.
  if (pinned) return;
  if (dwellTimer != null) {
    window.clearTimeout(dwellTimer);
    dwellTimer = null;
  }
  if (hideTimer != null) {
    window.clearTimeout(hideTimer);
    hideTimer = null;
  }
  clearSubscription();
  activeAnnotationId = null;
  activeDoc = null;
  activeText = null;
  activeGroup = null;
  activeOnDelete = null;
  // The panel must be re-placed next open, but the reader's chosen size is
  // remembered (in savedSize) and re-applied then.
  pinnedPlaced = false;
  if (tooltipEl) {
    tooltipEl.style.display = "none";
    // Drop the explicit height so a fresh collapsed hover sizes to content;
    // the saved height is re-applied from savedSize when next pinned.
    tooltipEl.style.height = "";
  }
}

function scheduleHide(): void {
  if (pinned) return;
  if (hideTimer != null) window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    // Only hide if the cursor isn't back on the tooltip or a tracked group.
    if (pendingAnnotationId == null && !tooltipEl?.matches(":hover")) hide();
  }, 120);
}

function position(anchorRect: DOMRect): void {
  const el = ensureTooltip();
  // Pinned panel lays out as a flex column (so the thread scrolls); the
  // collapsed hover tooltip is a plain block.
  el.style.display = pinned ? "flex" : "block";

  // The pinned panel is positioned (and sized) exactly once per open session.
  // After that, re-renders and resize drags own its geometry — don't yank it.
  if (pinned && pinnedPlaced) return;

  const margin = 12;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let width: number;
  if (pinned) {
    width = Math.min(savedSize?.width ?? DEFAULT_PINNED_WIDTH, vw - margin * 2);
    el.style.width = `${width}px`;
    // The panel height is left to grow with content (the thread scrolls once
    // it hits the cap), so clear any stale explicit height and apply a
    // provisional cap to measure with.
    el.style.height = "";
    const cap = Math.min(savedSize?.height ?? DEFAULT_CAP_PX, vh - margin * 2);
    el.style.maxHeight = `${cap}px`;
    pinnedPlaced = true;
  } else {
    width = Math.min(TOOLTIP_WIDTH_PX, vw - margin * 2);
    el.style.width = `${width}px`;
  }

  const tooltipHeight = el.offsetHeight;

  const centerX = anchorRect.left + anchorRect.width / 2;
  let x = centerX - width / 2;
  x = Math.max(margin, Math.min(x, vw - width - margin));

  // Prefer above the highlight; flip below if it won't fit; then clamp so the
  // whole panel stays on-screen.
  let y = anchorRect.top - tooltipHeight - GAP_PX;
  if (y < margin) y = anchorRect.bottom + GAP_PX;
  y = Math.min(y, vh - tooltipHeight - margin);
  y = Math.max(margin, y);

  if (pinned) {
    // Final cap: grow only as far as the bottom of the screen allows, never
    // past the remembered/default cap. Beyond this the thread scrolls.
    const cap = Math.min(savedSize?.height ?? DEFAULT_CAP_PX, vh - y - margin);
    el.style.maxHeight = `${cap}px`;
  }

  el.style.left = `${x + window.scrollX}px`;
  el.style.top = `${y + window.scrollY}px`;
}

function render(annotationId: string): void {
  const el = ensureTooltip();
  const state = getExplanationState(annotationId);
  const title = titleEl!;
  const body = bodyEl!;

  el.classList.remove("is-loading", "is-error", "is-ready", "is-empty");

  if (state.status === "loading") {
    el.classList.add("is-loading");
    title.textContent =
      state.kind === "definition" ? "Definition" : "Explanation";
    body.textContent = state.content || "Thinking…";
  } else if (state.status === "ready") {
    el.classList.add("is-ready");
    title.textContent =
      state.kind === "definition" ? "Definition" : "Explanation";
    body.textContent = state.content;
  } else if (state.status === "error") {
    el.classList.add("is-error");
    if (state.code === AI_NOT_CONFIGURED_CODE) {
      // Not a failure so much as "not turned on yet" — guide the reader to
      // setup instead of showing a dead-end error.
      title.textContent = "AI isn't set up yet";
      body.textContent = "";
      const msg = document.createElement("span");
      msg.textContent =
        "Turn on AI explanations with a one-time Anthropic API key. ";
      const setup = document.createElement("button");
      setup.type = "button";
      setup.className = "explanation-setup-ai";
      setup.textContent = "Set up AI →";
      setup.addEventListener("click", (e) => {
        e.stopPropagation();
        openAiSetup();
      });
      body.append(msg, setup);
    } else {
      title.textContent = "Explanation unavailable";
      body.textContent = state.error;
    }
  } else {
    el.classList.add("is-empty");
    title.textContent = "Explanation";
    body.textContent = "No explanation has been generated for this highlight.";
  }

  // The chat only makes sense once there's an actual definition/explanation
  // to clarify — not on the error or "nothing generated" states.
  const chatAvailable =
    (state.status === "ready" || state.status === "loading") &&
    activeText != null;
  renderChat(annotationId, chatAvailable);
}

function renderChat(annotationId: string, chatAvailable: boolean): void {
  const el = tooltipEl!;
  el.classList.toggle("is-pinned", pinned);

  // The footer (Delete + "Ask a follow-up") shows only in the collapsed hover
  // state. Once the reader opens the chat we assume they don't want to delete,
  // so the whole footer is hidden while pinned. Delete itself is available in
  // every collapsed state (incl. error/empty); the follow-up affordance only
  // when there's an explanation worth clarifying.
  if (footEl) footEl.style.display = pinned ? "none" : "flex";
  if (deleteEl) deleteEl.style.display = "inline-flex";
  if (openChatEl) {
    openChatEl.style.display = chatAvailable ? "inline-flex" : "none";
  }
  if (closeEl) closeEl.style.display = pinned ? "block" : "none";
  if (chatEl) chatEl.style.display = pinned ? "flex" : "none";
  if (!pinned) return;

  const chat = getChat(annotationId);

  // Thread.
  const thread = threadEl!;
  thread.replaceChildren();
  for (const msg of chat.messages) {
    const row = document.createElement("div");
    row.className = `explanation-chat-msg is-${msg.role}`;
    row.textContent = msg.content;
    thread.appendChild(row);
  }
  if (chat.streaming) {
    thread.classList.add("is-streaming");
  } else {
    thread.classList.remove("is-streaming");
  }
  thread.scrollTop = thread.scrollHeight;

  // Error line.
  if (chatErrorEl) {
    chatErrorEl.textContent = chat.error ?? "";
    chatErrorEl.style.display = chat.error ? "block" : "none";
  }

  // Controls — disable while a reply or rewrite is mid-flight.
  const busy = chat.streaming || chat.refining;
  if (inputEl) inputEl.disabled = busy;
  if (sendEl) sendEl.disabled = busy;
  if (applyEl) {
    applyEl.disabled = busy || chat.messages.length === 0;
    applyEl.textContent = chat.refining
      ? "Updating…"
      : "Update explanation";
  }
}

async function show(
  registration: BlueRegistration,
  anchorRect: DOMRect,
): Promise<void> {
  const { doc, annotationId, text } = registration;
  activeAnnotationId = annotationId;
  activeDoc = doc;
  activeText = text;
  activeGroup = registration.group;
  activeOnDelete = registration.onDelete;
  clearSubscription();

  currentUnsubscribe = subscribeExplanation(annotationId, () => {
    if (activeAnnotationId !== annotationId) return;
    render(annotationId);
    // Re-query rect each render so it tracks scroll/zoom. Anchor to the
    // *current* group (activeGroup), which re-binding swaps in when the page
    // re-lays-out, rather than the possibly-detached one from this closure.
    if (activeGroup) position(activeGroup.getBoundingClientRect());
  });

  render(annotationId);
  position(anchorRect);

  const state = getExplanationState(annotationId);
  if (state.status === "idle") {
    const hydrated = await hydrateExplanation(doc.id, annotationId);
    if (activeAnnotationId !== annotationId) return;
    if (!hydrated && text) {
      startExplanation(doc.id, annotationId, text);
    }
  }
}

function pointInRect(x: number, y: number, r: DOMRect): boolean {
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

function findHitRegistration(
  state: WrapState,
  x: number,
  y: number,
): BlueRegistration | null {
  for (const reg of state.registrations.values()) {
    // group is the <g class="annotation"> containing one or more <rect>s.
    for (const rect of reg.group.querySelectorAll("rect")) {
      if (pointInRect(x, y, rect.getBoundingClientRect())) return reg;
    }
  }
  return null;
}

function setupWrapListeners(wrap: HTMLElement): WrapState {
  const onMove = (e: MouseEvent) => {
    // While pinned the reader owns the tooltip — don't let cursor movement
    // over other highlights swap it out from under their conversation.
    if (pinned) return;
    const state = wrapStates.get(wrap);
    if (!state) return;
    const hit = findHitRegistration(state, e.clientX, e.clientY);
    const hitId = hit?.annotationId ?? null;

    if (hitId === pendingAnnotationId) return; // unchanged
    pendingAnnotationId = hitId;

    if (hit) {
      // Entered a (different) blue annotation — restart dwell.
      if (dwellTimer != null) window.clearTimeout(dwellTimer);
      if (hideTimer != null) {
        window.clearTimeout(hideTimer);
        hideTimer = null;
      }
      const reg = hit;
      const anchorRect = reg.group.getBoundingClientRect();
      dwellTimer = window.setTimeout(() => {
        dwellTimer = null;
        void show(reg, anchorRect);
      }, DWELL_MS);
    } else {
      // Left all blue annotations — cancel pending dwell, queue a hide.
      if (dwellTimer != null) {
        window.clearTimeout(dwellTimer);
        dwellTimer = null;
      }
      if (activeAnnotationId != null) scheduleHide();
    }
  };

  const onLeave = () => {
    pendingAnnotationId = null;
    if (dwellTimer != null) {
      window.clearTimeout(dwellTimer);
      dwellTimer = null;
    }
    if (activeAnnotationId != null) scheduleHide();
  };

  wrap.addEventListener("mousemove", onMove);
  wrap.addEventListener("mouseleave", onLeave);

  return { registrations: new Map(), onMove, onLeave };
}

/**
 * Register a blue annotation for hover-tooltip behavior.
 *
 * Hover detection is done at the page-wrap level via a single mousemove
 * listener that hit-tests against the registered groups — direct
 * mouseenter on the SVG group is unreliable because the text-layer
 * overlays it.
 */
export function bindBlueAnnotation(
  group: SVGGElement,
  doc: DocumentMeta,
  annotationId: string,
  text: string | null,
  onDelete: (annotationId: string) => void,
): () => void {
  // The caller (AnnotationLayer) appends `group` to a freshly-created SVG
  // and only attaches that SVG to the DOM after returning. So at this
  // moment `group.closest('.page-wrap')` returns null. Defer to the next
  // microtask so the lookup runs after the SVG is in the document.
  let cancelled = false;
  let resolvedCleanup: (() => void) | null = null;

  queueMicrotask(() => {
    if (cancelled) return;
    const wrap = group.closest<HTMLElement>(".page-wrap");
    if (!wrap) return;

    let state = wrapStates.get(wrap);
    if (!state) {
      state = setupWrapListeners(wrap);
      wrapStates.set(wrap, state);
    }
    state.registrations.set(annotationId, {
      group,
      doc,
      annotationId,
      text,
      onDelete,
    });
    // Keep the live delete callback fresh if the panel is already open for it.
    if (activeAnnotationId === annotationId) activeOnDelete = onDelete;

    // If a pinned conversation is open for this highlight and the page just
    // re-laid-out (zoom/scroll rebuilds the SVG), re-anchor to the new group
    // so the panel tracks the highlight instead of stranding at (0,0).
    if (pinned && activeAnnotationId === annotationId) {
      activeGroup = group;
      position(group.getBoundingClientRect());
    }

    resolvedCleanup = () => {
      const s = wrapStates.get(wrap);
      if (!s) return;
      s.registrations.delete(annotationId);
      if (activeAnnotationId === annotationId) hide();
      if (pendingAnnotationId === annotationId) pendingAnnotationId = null;
      if (s.registrations.size === 0) {
        wrap.removeEventListener("mousemove", s.onMove);
        wrap.removeEventListener("mouseleave", s.onLeave);
        wrapStates.delete(wrap);
      }
    };
  });

  return () => {
    cancelled = true;
    if (resolvedCleanup) resolvedCleanup();
  };
}

/** Public hide, for callers that want to dismiss explicitly. */
export function hideExplanationTooltip(): void {
  pinned = false;
  hide();
}

/** Test-only: tear down the singleton tooltip and reset module state. */
export function _resetForTest(): void {
  pinned = false;
  pinnedPlaced = false;
  savedSize = null;
  if (currentUnsubscribe) currentUnsubscribe();
  currentUnsubscribe = null;
  if (dwellTimer != null) window.clearTimeout(dwellTimer);
  if (hideTimer != null) window.clearTimeout(hideTimer);
  dwellTimer = null;
  hideTimer = null;
  activeAnnotationId = null;
  pendingAnnotationId = null;
  activeDoc = null;
  activeText = null;
  activeGroup = null;
  activeOnDelete = null;
  tooltipEl?.remove();
  tooltipEl = null;
}

/**
 * Force the tooltip closed if it's currently showing (or pinned open for) the
 * given annotation. Called when a highlight is deleted so a pinned chat panel
 * doesn't linger over a highlight that no longer exists.
 */
export function dismissExplanationFor(annotationId: string): void {
  if (activeAnnotationId === annotationId) {
    pinned = false;
    hide();
  }
}
