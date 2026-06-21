import {
  createHighlight,
  deleteAnnotation,
  fetchPageCitations,
  fetchPageFigures,
  fetchPageText,
  listAnnotations,
  pageImageUrl,
  type Annotation,
  type CitationMarker,
  type DocumentMeta,
  type PageDimension,
  type PageFigure,
  type PageText,
  type Rect,
} from "../api.ts";
import { seedFigure } from "../figureStore.ts";
import { loadReferences } from "../referenceStore.ts";
import { buildCitationLayer } from "./CitationLayer.ts";
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
import { seedExplanation, startExplanation } from "../explanationStore.ts";
import { getZoom, subscribeZoom } from "../zoom.ts";
import { buildAnnotationLayer } from "./AnnotationLayer.ts";
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
  mouseupWired: boolean;
  figuresWired: boolean;
  figures: PageFigure[];
  citations: CitationMarker[];
  citationsLoaded: boolean;
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
    mouseupWired: false,
    figuresWired: false,
    figures: [],
    citations: [],
    citationsLoaded: false,
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
      .querySelectorAll(".live-selection-layer, .text-layer, .citation-layer")
      .forEach((el) => el.remove());
    if (state.annotationLayer) {
      state.annotationLayer.remove();
      state.annotationLayer = null;
    }

    const liveSelectionLayer = buildLiveSelectionLayer();
    liveSelectionLayer.setAttribute("width", String(widthCss));
    liveSelectionLayer.setAttribute("height", String(heightCss));
    wrap.appendChild(liveSelectionLayer);
    wrap.appendChild(buildTextLayer(text, geom));
    // Citation markers sit above the text layer so their small hotspots get
    // the click; the rest of the page stays selectable.
    if (state.citations.length > 0) {
      wrap.appendChild(buildCitationLayer(meta.id, state.citations, geom));
    }
    registerLiveSelection(wrap, liveSelectionLayer);
    void refreshAnnotations(meta, pageNumber, wrap, state);

    if (!state.mouseupWired) {
      wireHighlightOnSelection(meta, pageNumber, wrap, state);
      state.mouseupWired = true;
    }

    if (!state.figuresWired) {
      wireFigureDoubleClick(meta, wrap, state);
      state.figuresWired = true;
      void loadFigures(meta, pageNumber, state);
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
    void loadCitations(meta, pageNumber, state, layout);
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
  const mode = getHighlightMode();
  if (!mode.active) return;
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
  // explanations on blue highlights.
  const selectedText = sel.toString().trim();

  let saved;
  try {
    saved = await createHighlight(
      meta.id,
      pageNumber,
      mode.color,
      pageRects,
      selectedText || undefined,
    );
  } catch {
    return;
  }
  sel.removeAllRanges();
  await refreshAnnotations(meta, pageNumber, wrap, state);

  // Blue highlights eagerly generate an AI definition/explanation so that
  // by the time the user hovers, the response is partially or fully ready.
  if (saved && mode.color === "blue" && selectedText) {
    startExplanation(meta.id, saved.id, selectedText);
  }
}

async function loadCitations(
  meta: DocumentMeta,
  pageNumber: number,
  state: PageState,
  redraw: () => void,
): Promise<void> {
  if (state.citationsLoaded) return;
  state.citationsLoaded = true;
  try {
    const resp = await fetchPageCitations(meta.id, pageNumber);
    state.citations = resp.citations;
  } catch {
    state.citations = [];
    return;
  }
  if (state.citations.length === 0) return;
  // Start parsing the bibliography now so the reference list is ready (or
  // close to it) by the time the reader clicks a marker.
  loadReferences(meta.id);
  // Re-run layout so the citation layer is drawn over the current geometry.
  redraw();
}

async function loadFigures(
  meta: DocumentMeta,
  pageNumber: number,
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
}

/**
 * Double-click handler at the page-wrap level. We hit-test the cursor
 * against the detected figure bboxes (in page-space, scaled to the
 * current display). Text double-click — i.e. when the event target is
 * a .text-run inside a column — is left alone for native word-select.
 */
function wireFigureDoubleClick(
  meta: DocumentMeta,
  wrap: HTMLElement,
  state: PageState,
): void {
  wrap.addEventListener("dblclick", (e) => {
    if (!state.geom) return;
    if (state.figures.length === 0) return;

    // Skip if the double-click hit text — native word-select is more useful.
    const target = e.target as Element | null;
    if (target && target.closest(".text-run")) return;

    const wrapRect = wrap.getBoundingClientRect();
    const xInWrap = e.clientX - wrapRect.left;
    const yInWrap = e.clientY - wrapRect.top;

    // Match against the (display-space) bbox of every figure on this page.
    for (const fig of state.figures) {
      const v = pageBBoxToViewport(fig.bbox, state.geom);
      if (
        xInWrap >= v.x0 &&
        xInWrap <= v.x1 &&
        yInWrap >= v.y0 &&
        yInWrap <= v.y1
      ) {
        e.preventDefault();
        // Convert back to a viewport-anchored rect for card positioning.
        const figRect = new DOMRect(
          wrapRect.left + v.x0,
          wrapRect.top + v.y0,
          v.x1 - v.x0,
          v.y1 - v.y0,
        );
        showFigureCard(meta.id, fig, figRect);
        return;
      }
    }
  });
}
