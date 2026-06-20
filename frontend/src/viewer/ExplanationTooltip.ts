/**
 * Singleton hover tooltip that displays AI explanations for blue highlights.
 *
 * Activation rule (per the feature spec): when the cursor sits on a blue
 * highlight for >= 500ms, the tooltip shows above the highlight with the
 * cached explanation. While the model is still streaming, the partial text
 * renders live with a shimmer caret.
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

interface Binding {
  unsubscribe: () => void;
}

let tooltipEl: HTMLDivElement | null = null;
let titleEl: HTMLDivElement | null = null;
let bodyEl: HTMLDivElement | null = null;
let currentBinding: Binding | null = null;
let dwellTimer: number | null = null;
let activeAnnotationId: string | null = null;

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

  document.body.appendChild(el);
  tooltipEl = el;
  titleEl = title;
  bodyEl = body;
  return el;
}

function clearBinding(): void {
  if (currentBinding) {
    currentBinding.unsubscribe();
    currentBinding = null;
  }
}

function hide(): void {
  if (dwellTimer != null) {
    window.clearTimeout(dwellTimer);
    dwellTimer = null;
  }
  clearBinding();
  activeAnnotationId = null;
  if (tooltipEl) tooltipEl.style.display = "none";
}

function position(anchorRect: DOMRect): void {
  const el = ensureTooltip();
  const margin = 12;
  const vw = window.innerWidth;
  const width = Math.min(TOOLTIP_WIDTH_PX, vw - margin * 2);
  el.style.width = `${width}px`;

  // Prefer above the anchor; flip below if no room.
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

  el.classList.remove(
    "is-loading",
    "is-error",
    "is-ready",
    "is-empty",
  );

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
  anchorRect: DOMRect,
  annotationId: string,
  text: string | null,
  docId: string,
): Promise<void> {
  activeAnnotationId = annotationId;
  clearBinding();

  const unsubscribe = subscribeExplanation(annotationId, () => {
    if (activeAnnotationId !== annotationId) return;
    render(annotationId);
    position(anchorRect);
  });
  currentBinding = { unsubscribe };

  render(annotationId);
  position(anchorRect);

  const state = getExplanationState(annotationId);
  if (state.status === "idle") {
    const hydrated = await hydrateExplanation(docId, annotationId);
    if (activeAnnotationId !== annotationId) return;
    if (!hydrated && text) {
      startExplanation(docId, annotationId, text);
    }
  }
}

/**
 * Wire up a blue annotation group. The caller hands us the SVG group element
 * (which already carries pointer-events: auto in the existing AnnotationLayer
 * styling) plus the metadata we need.
 *
 * Returns a teardown that removes the listeners — call when the annotation
 * layer is rebuilt.
 */
export function bindBlueAnnotation(
  group: SVGGElement,
  doc: DocumentMeta,
  annotationId: string,
  text: string | null,
): () => void {
  const onEnter = (e: MouseEvent) => {
    if (dwellTimer != null) window.clearTimeout(dwellTimer);
    const anchorRect = (e.currentTarget as Element).getBoundingClientRect();
    dwellTimer = window.setTimeout(() => {
      void show(anchorRect, annotationId, text, doc.id);
    }, DWELL_MS);
  };
  const onLeave = () => {
    if (dwellTimer != null) {
      window.clearTimeout(dwellTimer);
      dwellTimer = null;
    }
    // Defer hiding so a quick mouse jiggle doesn't flicker. Only hide if
    // the cursor really left both the annotation and the tooltip area.
    window.setTimeout(() => {
      if (activeAnnotationId === annotationId) {
        const hovered = tooltipEl?.matches(":hover");
        if (!hovered) hide();
      }
    }, 80);
  };

  group.addEventListener("mouseenter", onEnter);
  group.addEventListener("mouseleave", onLeave);

  // Also hide if the user clicks anywhere else.
  return () => {
    group.removeEventListener("mouseenter", onEnter);
    group.removeEventListener("mouseleave", onLeave);
    if (activeAnnotationId === annotationId) hide();
  };
}

/** Public hide, for callers that want to dismiss explicitly. */
export function hideExplanationTooltip(): void {
  hide();
}
