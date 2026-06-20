import {
  createHighlight,
  deleteAnnotation,
  fetchPageText,
  listAnnotations,
  pageImageUrl,
  type Annotation,
  type DocumentMeta,
  type PageText,
  type Rect,
} from "../api.ts";
import { getHighlightMode } from "../highlightMode.ts";
import { startExplanation } from "../explanationStore.ts";
import { getZoom, subscribeZoom } from "../zoom.ts";
import { buildAnnotationLayer } from "./AnnotationLayer.ts";
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

const BASE_DISPLAY_WIDTH = 900;
const BASE_DPI = 150;
const MAX_DPI = 300;

interface PageState {
  geom: PageGeometry | null;
  text: PageText | null;
  annotationLayer: SVGSVGElement | null;
  mouseupWired: boolean;
  currentDpi: number;
}

export function buildPageView(meta: DocumentMeta, pageNumber: number): HTMLElement {
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
  };

  const applyZoom = (zoom: number) => {
    const width = BASE_DISPLAY_WIDTH * zoom;
    wrap.style.width = `${width}px`;
    wrap.style.maxWidth = `${width}px`;
    img.style.width = `${width}px`;

    // Bump DPI when zoomed in so the raster stays sharp under upscaling.
    // We snap to integer DPI and only re-request when the bucket changes —
    // this lets the browser/disk cache do the heavy lifting on zoom-in/out.
    const desired = Math.ceil(BASE_DPI * Math.max(1.0, zoom));
    const dpi = Math.min(MAX_DPI, Math.max(BASE_DPI, desired));
    if (dpi !== state.currentDpi) {
      state.currentDpi = dpi;
      img.src = pageImageUrl(meta.id, pageNumber, dpi);
    }
  };

  const layout = (): void => {
    if (!state.text) return;
    const text = state.text;
    const widthCss = BASE_DISPLAY_WIDTH * getZoom();
    const heightCss = widthCss * (text.page_height_pt / text.page_width_pt);

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

  applyZoom(getZoom());

  if (img.complete && img.naturalWidth > 0) {
    void init();
  } else {
    img.addEventListener("load", () => void init(), { once: true });
  }

  subscribeZoom((zoom) => {
    applyZoom(zoom);
    if (state.text) layout();
  });

  return wrap;
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
