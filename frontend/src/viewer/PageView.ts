import {
  createHighlight,
  deleteAnnotation,
  fetchPageText,
  listAnnotations,
  pageImageUrl,
  type Annotation,
  type DocumentMeta,
  type PageDimension,
  type PageText,
  type Rect,
} from "../api.ts";
import {
  getQuery as getFindQuery,
  registerPageAdapter,
  subscribeQuery as subscribeFindQuery,
  unregisterPage,
} from "../findState.ts";
import { getBaseScale, subscribeFit } from "../fit.ts";
import { getHighlightMode } from "../highlightMode.ts";
import { startExplanation } from "../explanationStore.ts";
import { getZoom, subscribeZoom } from "../zoom.ts";
import { buildAnnotationLayer } from "./AnnotationLayer.ts";
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

    const liveSelectionLayer = buildLiveSelectionLayer();
    liveSelectionLayer.setAttribute("width", String(widthCss));
    liveSelectionLayer.setAttribute("height", String(heightCss));
    wrap.appendChild(liveSelectionLayer);
    wrap.appendChild(buildTextLayer(text, geom));
    registerLiveSelection(wrap, liveSelectionLayer);
    void refreshAnnotations(meta, pageNumber, wrap, state);

    if (!state.mouseupWired) {
      wireHighlightOnSelection(meta, pageNumber, wrap, state);
      state.mouseupWired = true;
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
