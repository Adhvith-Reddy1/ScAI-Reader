import {
  createHighlight,
  deleteAnnotation,
  fetchPageFigures,
  fetchPageText,
  listAnnotations,
  pageImageUrl,
  type Annotation,
  type DocumentMeta,
  type PageDimension,
  type PageFigure,
  type PageText,
  type Rect,
} from "../api.ts";
import { seedFigure } from "../figureStore.ts";
import { showToast } from "../toast.ts";
import { showFigureCard } from "./FigureCard.ts";
import { pageBBoxToViewport } from "./coords.ts";
import {
  getQuery as getFindQuery,
  registerPageAdapter,
  subscribeQuery as subscribeFindQuery,
  unregisterPage,
} from "../findState.ts";
import { getBaseScale, subscribeFit } from "../fit.ts";
import { getHighlightMode } from "../highlightMode.ts";
import { getExplainMode } from "../explainMode.ts";
import { seedExplanation, startExplanation } from "../explanationStore.ts";
import { getZoom, subscribeZoom } from "../zoom.ts";
import { buildAnnotationLayer } from "./AnnotationLayer.ts";
import { buildFigureLayer } from "./FigureLayer.ts";
import { dismissExplanationFor } from "./ExplanationTooltip.ts";
import { applyFindToTextLayer, markCurrent } from "./findInPage.ts";
import {
  buildLiveSelectionLayer,
  registerLiveSelection,
} from "./LiveSelectionLayer.ts";
import { buildTextLayer } from "./TextLayer.ts";
import {
  clientRectsRelativeTo,
  mergeAdjacentLineRects,
  rectsToPageSpace,
} from "./selection.ts";
import type { PageGeometry } from "./coords.ts";

const MIN_DPI = 150;
const MAX_DPI = 300;

interface PageState {
  geom: PageGeometry | null;
  text: PageText | null;
  annotationLayer: SVGSVGElement | null;
  figureLayer: SVGSVGElement | null;
  mouseupWired: boolean;
  figuresWired: boolean;
  figures: PageFigure[];
  hoveredFigureId: string | null;
  currentDpi: number;
  findHits: HTMLElement[];
}

export interface PageViewHandle {
  element: HTMLElement;
  dispose: () => void;
}

export function buildPageView(
  meta: DocumentMeta,
  pageNumber: number,
  pageDim: PageDimension,
): PageViewHandle {
  const wrap = document.createElement("div");
  wrap.className = "page-wrap";

  const num = document.createElement("div");
  num.className = "page-number";
  num.textContent = `Page ${pageNumber} of ${meta.page_count}`;

  const img = document.createElement("img");
  img.className = "page";
  img.alt = `Page ${pageNumber}`;
  img.loading = "lazy";

  wrap.appendChild(num);
  wrap.appendChild(img);

  const state: PageState = {
    geom: null,
    text: null,
    annotationLayer: null,
    figureLayer: null,
    mouseupWired: false,
    figuresWired: false,
    figures: [],
    hoveredFigureId: null,
    currentDpi: 0,
    findHits: [],
  };

  const applyDisplay = (): void => {
    const effectiveScale = getBaseScale() * getZoom();
    const widthPx = pageDim.width_pt * effectiveScale;
    const heightPx = pageDim.height_pt * effectiveScale;
    wrap.style.width = `${widthPx}px`;
    wrap.style.height = `${heightPx}px`;
    img.style.width = `${widthPx}px`;
    img.style.height = `${heightPx}px`;

    // Pick a raster DPI that gives ≥1 source pixel per CSS pixel, snapped to
    // an integer and clamped so cache buckets don't proliferate.
    const desired = Math.ceil(effectiveScale * 72);
    const dpi = Math.min(MAX_DPI, Math.max(MIN_DPI, desired));
    if (dpi !== state.currentDpi) {
      state.currentDpi = dpi;
      img.src = pageImageUrl(meta.id, pageNumber, dpi);
    }
  };

  const layout = (): void => {
    if (!state.text) return;
    const text = state.text;
    const effectiveScale = getBaseScale() * getZoom();
    const widthCss = pageDim.width_pt * effectiveScale;
    const heightCss = pageDim.height_pt * effectiveScale;

    const geom: PageGeometry = {
      pageWidthPt: text.page_width_pt,
      pageHeightPt: text.page_height_pt,
      displayWidthPx: widthCss,
      displayHeightPx: heightCss,
    };
    state.geom = geom;

    wrap
      .querySelectorAll(".live-selection-layer, .text-layer")
      .forEach((el) => el.remove());
    if (state.annotationLayer) {
      state.annotationLayer.remove();
      state.annotationLayer = null;
    }
    if (state.figureLayer) {
      state.figureLayer.remove();
      state.figureLayer = null;
    }

    const liveSelectionLayer = buildLiveSelectionLayer();
    liveSelectionLayer.setAttribute("width", String(widthCss));
    liveSelectionLayer.setAttribute("height", String(heightCss));
    wrap.appendChild(liveSelectionLayer);
    wrap.appendChild(buildTextLayer(text, geom));
    registerLiveSelection(wrap, liveSelectionLayer);
    void refreshAnnotations(meta, pageNumber, wrap, state);
    renderFigureLayer(wrap, state);

    if (!state.mouseupWired) {
      wireHighlightOnSelection(meta, pageNumber, wrap, state);
      state.mouseupWired = true;
    }

    if (!state.figuresWired) {
      wireFigureInteractions(meta, wrap, state);
      state.figuresWired = true;
      void loadFigures(meta, pageNumber, wrap, state);
    }

    // Re-apply the current find query against the freshly-built text layer.
    refreshFindMatches(pageNumber, wrap, state);
  };

  const init = async (): Promise<void> => {
    if (!state.text) {
      try {
        state.text = await fetchPageText(meta.id, pageNumber);
      } catch {
        return;
      }
    }
    layout();
  };

  applyDisplay();

  if (img.complete && img.naturalWidth > 0) {
    void init();
  } else {
    img.addEventListener("load", () => void init(), { once: true });
  }

  const unsubZoom = subscribeZoom(() => {
    applyDisplay();
    if (state.text) layout();
  });
  const unsubFit = subscribeFit(() => {
    applyDisplay();
    if (state.text) layout();
  });
  const unsubFind = subscribeFindQuery(() => {
    refreshFindMatches(pageNumber, wrap, state);
  });

  return {
    element: wrap,
    dispose: () => {
      unsubZoom();
      unsubFit();
      unsubFind();
      unregisterPage(pageNumber);
    },
  };
}

function refreshFindMatches(
  pageNumber: number,
  wrap: HTMLElement,
  state: PageState,
): void {
  const textLayer = wrap.querySelector<HTMLElement>(".text-layer");
  if (!textLayer) return;
  const hits = applyFindToTextLayer(textLayer, getFindQuery());
  state.findHits = hits;
  registerPageAdapter({
    page: pageNumber,
    count: hits.length,
    scrollToMatchAndMark: (inPageIndex: number) => {
      const span = state.findHits[inPageIndex];
      if (!span) return;
      markCurrent(span);
      span.scrollIntoView({ block: "center", behavior: "auto" });
    },
    clearActiveMark: () => {
      // Removing only THIS page's current mark; markCurrent(null) elsewhere
      // would clear the new one we're about to set. So scope to our hits.
      for (const span of state.findHits) span.classList.remove("find-match-current");
    },
  });
}

async function refreshAnnotations(
  meta: DocumentMeta,
  pageNumber: number,
  wrap: HTMLElement,
  state: PageState,
): Promise<void> {
  if (!state.geom) return;
  let annotations: Annotation[];
  try {
    annotations = await listAnnotations(meta.id, pageNumber);
  } catch {
    annotations = [];
  }

  // Prime the explanation store with whatever the server has cached for
  // these highlights. Hovering won't hit the network — the tooltip pops
  // straight to the ready state.
  for (const ann of annotations) {
    if (ann.explanation) {
      seedExplanation(ann.id, ann.explanation.kind, ann.explanation.content);
    }
  }

  if (state.annotationLayer) state.annotationLayer.remove();
  const svg = buildAnnotationLayer(
    annotations,
    state.geom,
    async (annotationId) => {
      try {
        await deleteAnnotation(meta.id, annotationId);
      } catch {
        return;
      }
      // Close any explanation panel pinned to the highlight we just removed.
      dismissExplanationFor(annotationId);
      await refreshAnnotations(meta, pageNumber, wrap, state);
    },
    meta,
  );
  const textLayer = wrap.querySelector(".text-layer");
  if (textLayer) {
    wrap.insertBefore(svg, textLayer);
  } else {
    wrap.appendChild(svg);
  }
  state.annotationLayer = svg;
}

function wireHighlightOnSelection(
  meta: DocumentMeta,
  pageNumber: number,
  wrap: HTMLElement,
  state: PageState,
): void {
  wrap.addEventListener("mouseup", () => {
    // Defer so the selection settles after browser's own mouseup processing.
    setTimeout(() => maybeAutoSaveHighlight(meta, pageNumber, wrap, state), 0);
  });
}

async function maybeAutoSaveHighlight(
  meta: DocumentMeta,
  pageNumber: number,
  wrap: HTMLElement,
  state: PageState,
): Promise<void> {
  // Explain takes precedence if somehow both are on (they're mutually
  // exclusive). An explain highlight triggers an AI explanation; a plain
  // highlight from the standard tool does not.
  const explainMode = getExplainMode();
  const hlMode = getHighlightMode();
  const mode = explainMode.active
    ? { color: explainMode.color, explain: true }
    : hlMode.active
      ? { color: hlMode.color, explain: false }
      : null;
  if (!mode) return;
  if (!state.geom) return;

  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  if (!wrap.contains(range.startContainer) || !wrap.contains(range.endContainer)) {
    return;
  }

  const containerRect = wrap.getBoundingClientRect();
  const viewportRects = clientRectsRelativeTo(
    range.getClientRects(),
    containerRect,
  );
  if (viewportRects.length === 0) return;
  const merged = mergeAdjacentLineRects(viewportRects);
  const pageRects: Rect[] = rectsToPageSpace(merged, state.geom);

  // Capture the selection text BEFORE we clear it — needed for AI
  // explanations on explanation highlights.
  const selectedText = sel.toString().trim();

  let saved;
  try {
    saved = await createHighlight(
      meta.id,
      pageNumber,
      mode.color,
      pageRects,
      selectedText || undefined,
      mode.explain,
    );
  } catch (e) {
    // Surface the per-document highlight cap (and only that) to the reader;
    // other transient save errors stay silent as before.
    if ((e as { status?: number }).status === 429) {
      showToast((e as Error).message);
    }
    return;
  }
  sel.removeAllRanges();
  await refreshAnnotations(meta, pageNumber, wrap, state);

  // Explanation highlights eagerly generate an AI definition/explanation so
  // that by the time the user hovers, the response is partially or fully ready.
  if (saved && mode.explain && selectedText) {
    startExplanation(meta.id, saved.id, selectedText);
  }
}

/** (Re)draw the figure-detection outline layer from whatever is in
 * state.figures right now. Cheap and safe to call with an empty list — the
 * outlines simply disappear, which is itself useful signal ("detected 0
 * figures on this page"). */
function renderFigureLayer(wrap: HTMLElement, state: PageState): void {
  if (state.figureLayer) {
    state.figureLayer.remove();
    state.figureLayer = null;
  }
  if (!state.geom) return;
  const svg = buildFigureLayer(state.figures, state.geom);
  const textLayer = wrap.querySelector(".text-layer");
  if (textLayer) {
    wrap.insertBefore(svg, textLayer);
  } else {
    wrap.appendChild(svg);
  }
  state.figureLayer = svg;
}

async function loadFigures(
  meta: DocumentMeta,
  pageNumber: number,
  wrap: HTMLElement,
  state: PageState,
): Promise<void> {
  try {
    const resp = await fetchPageFigures(meta.id, pageNumber);
    state.figures = resp.figures;
    // Seed the store so re-opening doesn't re-stream.
    for (const f of resp.figures) {
      if (f.explanation) seedFigure(meta.id, f.figure_id, f.explanation.content);
    }
  } catch {
    state.figures = [];
  }
  renderFigureLayer(wrap, state);
}

/** The detected figure (if any) whose display-space bbox contains the given
 * client point. Shared by the dblclick handler and the hover highlight so
 * both agree on exactly the same target. */
function figureAtClientPoint(
  state: PageState,
  wrapRect: DOMRect,
  clientX: number,
  clientY: number,
): PageFigure | null {
  if (!state.geom) return null;
  const xInWrap = clientX - wrapRect.left;
  const yInWrap = clientY - wrapRect.top;
  for (const fig of state.figures) {
    const v = pageBBoxToViewport(fig.bbox, state.geom);
    if (xInWrap >= v.x0 && xInWrap <= v.x1 && yInWrap >= v.y0 && yInWrap <= v.y1) {
      return fig;
    }
  }
  return null;
}

/**
 * Double-click-to-explain plus a hover affordance on detected figures, wired
 * at the page-wrap level (the text-column layer above owns pointer events
 * across its whole bounding box — including a figure's whitespace gap — so a
 * plain CSS :hover on the outline itself would never fire).
 *
 * Text double-click — i.e. the event target is a .text-run inside a column —
 * is left alone for native word-select.
 */
function wireFigureInteractions(
  meta: DocumentMeta,
  wrap: HTMLElement,
  state: PageState,
): void {
  wrap.addEventListener("dblclick", (e) => {
    if (state.figures.length === 0) return;
    const target = e.target as Element | null;
    if (target && target.closest(".text-run")) return;

    const wrapRect = wrap.getBoundingClientRect();
    const fig = figureAtClientPoint(state, wrapRect, e.clientX, e.clientY);
    if (!fig || !state.geom) return;

    e.preventDefault();
    const v = pageBBoxToViewport(fig.bbox, state.geom);
    // Convert back to a viewport-anchored rect for card positioning.
    const figRect = new DOMRect(
      wrapRect.left + v.x0,
      wrapRect.top + v.y0,
      v.x1 - v.x0,
      v.y1 - v.y0,
    );
    showFigureCard(meta.id, fig, figRect);
  });

  wrap.addEventListener("mousemove", (e) => {
    if (state.figures.length === 0) return;
    const wrapRect = wrap.getBoundingClientRect();
    const fig = figureAtClientPoint(state, wrapRect, e.clientX, e.clientY);
    const nextId = fig?.figure_id ?? null;
    if (nextId === state.hoveredFigureId) return;

    if (state.hoveredFigureId && state.figureLayer) {
      state.figureLayer
        .querySelector(`[data-figure-id="${state.hoveredFigureId}"]`)
        ?.classList.remove("is-hover");
    }
    if (nextId && state.figureLayer) {
      state.figureLayer
        .querySelector(`[data-figure-id="${nextId}"]`)
        ?.classList.add("is-hover");
    }
    state.hoveredFigureId = nextId;
    wrap.classList.toggle("is-over-figure", nextId != null);
  });

  wrap.addEventListener("mouseleave", () => {
    if (state.hoveredFigureId && state.figureLayer) {
      state.figureLayer
        .querySelector(`[data-figure-id="${state.hoveredFigureId}"]`)
        ?.classList.remove("is-hover");
    }
    state.hoveredFigureId = null;
    wrap.classList.remove("is-over-figure");
  });
}
