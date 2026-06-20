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

import type { DocumentMeta } from "../api.ts";
import {
  getExplanationState,
  hydrateExplanation,
  startExplanation,
  subscribeExplanation,
} from "../explanationStore.ts";

const DWELL_MS = 500;
const GAP_PX = 8;
const TOOLTIP_WIDTH_PX = 360;

// Tooltip singleton state.
let tooltipEl: HTMLDivElement | null = null;
let titleEl: HTMLDivElement | null = null;
let bodyEl: HTMLDivElement | null = null;
let currentUnsubscribe: (() => void) | null = null;
let dwellTimer: number | null = null;
let hideTimer: number | null = null;
let activeAnnotationId: string | null = null;
// The annotation the cursor is currently INSIDE (may differ from the
// activeAnnotationId until the dwell timer fires).
let pendingAnnotationId: string | null = null;

interface BlueRegistration {
  group: SVGGElement;
  doc: DocumentMeta;
  annotationId: string;
  text: string | null;
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

  const title = document.createElement("div");
  title.className = "explanation-tooltip-title";
  el.appendChild(title);

  const body = document.createElement("div");
  body.className = "explanation-tooltip-body";
  el.appendChild(body);

  // While the cursor is over the tooltip itself, cancel any pending hide
  // so the user can read it without it flickering away.
  el.addEventListener("mouseenter", () => {
    if (hideTimer != null) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
  });
  el.addEventListener("mouseleave", () => scheduleHide());

  document.body.appendChild(el);
  tooltipEl = el;
  titleEl = title;
  bodyEl = body;
  return el;
}

function clearSubscription(): void {
  if (currentUnsubscribe) {
    currentUnsubscribe();
    currentUnsubscribe = null;
  }
}

function hide(): void {
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
  if (tooltipEl) tooltipEl.style.display = "none";
}

function scheduleHide(): void {
  if (hideTimer != null) window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    // Only hide if the cursor isn't back on the tooltip or a tracked group.
    if (pendingAnnotationId == null && !tooltipEl?.matches(":hover")) hide();
  }, 120);
}

function position(anchorRect: DOMRect): void {
  const el = ensureTooltip();
  const margin = 12;
  const vw = window.innerWidth;
  const width = Math.min(TOOLTIP_WIDTH_PX, vw - margin * 2);
  el.style.width = `${width}px`;

  el.style.display = "block";
  const tooltipHeight = el.offsetHeight;

  const centerX = anchorRect.left + anchorRect.width / 2;
  let x = centerX - width / 2;
  x = Math.max(margin, Math.min(x, vw - width - margin));

  let y = anchorRect.top - tooltipHeight - GAP_PX;
  if (y < margin) {
    y = anchorRect.bottom + GAP_PX;
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
    title.textContent = "Explanation unavailable";
    body.textContent = state.error;
  } else {
    el.classList.add("is-empty");
    title.textContent = "Explanation";
    body.textContent = "No explanation has been generated for this highlight.";
  }
}

async function show(
  registration: BlueRegistration,
  anchorRect: DOMRect,
): Promise<void> {
  const { doc, annotationId, text } = registration;
  activeAnnotationId = annotationId;
  clearSubscription();

  currentUnsubscribe = subscribeExplanation(annotationId, () => {
    if (activeAnnotationId !== annotationId) return;
    render(annotationId);
    // Re-query rect each render so it tracks scroll/zoom.
    position(registration.group.getBoundingClientRect());
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
): () => void {
  const wrap = group.closest<HTMLElement>(".page-wrap");
  if (!wrap) return () => {};

  let state = wrapStates.get(wrap);
  if (!state) {
    state = setupWrapListeners(wrap);
    wrapStates.set(wrap, state);
  }
  state.registrations.set(annotationId, { group, doc, annotationId, text });

  return () => {
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
}

/** Public hide, for callers that want to dismiss explicitly. */
export function hideExplanationTooltip(): void {
  hide();
}
