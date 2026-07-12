import {
  fetchPageFigures,
  fetchPageText,
  flattenPageText,
  pageImageUrl,
  type DocumentMeta,
  type PageDimension,
  type PageFigure,
  type PageText,
  type Rect,
} from "../api.ts";
import {
  deleteAnnotation,
  listAnnotations,
  putAnnotation,
  type LocalAnnotation,
} from "../storage/localStore.ts";
import { makeHighlight } from "./highlightModel.ts";
import { seedFigure } from "../figureStore.ts";
import { getExplanation as getCachedExplanation } from "../storage/localStore.ts";
import { showFigureCard } from "./FigureCard.ts";
import { buildFigureLayer } from "./FigureLayer.ts";
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
import { getRotation, subscribeRotation, type Rotation } from "../rotation.ts";
import { rotatedFootprint, screenRectToContent, screenPointToContent } from "./rotate.ts";
import { buildAnnotationLayer } from "./AnnotationLayer.ts";
import {
  dismissExplanationFor,
  showExplanationForNewHighlight,
} from "./ExplanationTooltip.ts";
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
  /** Inner box holding the image + every overlay. It is what gets the CSS
   * rotation transform; all overlays live here in unrotated content space. */
  content: HTMLElement;
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
  /** Rotation the content transform was last written for. Zoom/fit ticks
   * call applyDisplay() far more often than rotation actually changes (every
   * frame of a pinch gesture vs. an explicit rotate click), so re-parsing an
   * unchanged `transform` string on every one of those ticks is pure waste —
   * skip the write when rotation hasn't moved since the last apply. */
  lastRot: Rotation | null;
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

  // The content box holds the image + overlays and is what gets rotated; the
  // outer wrap reserves the rotated footprint and carries the (unrotated) label.
  const content = document.createElement("div");
  content.className = "page-content";

  const img = document.createElement("img");
  img.className = "page";
  img.alt = `Page ${pageNumber}`;
  img.loading = "lazy";

  content.appendChild(img);
  wrap.appendChild(num);
  wrap.appendChild(content);

  const state: PageState = {
    content,
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
    lastRot: null,
  };

  const applyDisplay = (): void => {
    const effectiveScale = getBaseScale() * getZoom();
    const widthPx = pageDim.width_pt * effectiveScale;
    const heightPx = pageDim.height_pt * effectiveScale;
    const rot = getRotation();

    // The content is always sized to the page's natural orientation; the outer
    // wrap takes the rotated footprint so the scroll layout reserves the right
    // space. The CSS transform then spins the content (image + overlays) about
    // its center, which sits at the wrap's center.
    const foot = rotatedFootprint(widthPx, heightPx, rot);
    wrap.style.width = `${foot.width}px`;
    wrap.style.height = `${foot.height}px`;
    content.style.width = `${widthPx}px`;
    content.style.height = `${heightPx}px`;
    if (rot !== state.lastRot) {
      content.style.transform = `translate(-50%, -50%) rotate(${rot}deg)`;
      state.lastRot = rot;
    }
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

    state.content
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
    state.content.appendChild(liveSelectionLayer);
    state.content.appendChild(buildTextLayer(text, geom));
    // Live-selection preview draws into the content box; register it there so
    // its center-based rotation math uses the content's (centered) rect.
    registerLiveSelection(state.content, liveSelectionLayer);
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
  // Rotation only changes the CSS transform + reserved footprint; the overlays
  // are already built in content space and spin with it, so no relayout needed.
  const unsubRotation = subscribeRotation(() => {
    applyDisplay();
  });

  return {
    element: wrap,
    dispose: () => {
      unsubZoom();
      unsubFit();
      unsubFind();
      unsubRotation();
      unregisterPage(pageNumber);
    },
  };
}

function refreshFindMatches(
  pageNumber: number,
  _wrap: HTMLElement,
  state: PageState,
): void {
  const textLayer = state.content.querySelector<HTMLElement>(".text-layer");
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

function makeAnnotationDeleteHandler(
  meta: DocumentMeta,
  pageNumber: number,
  wrap: HTMLElement,
  state: PageState,
): (annotationId: string) => Promise<void> {
  return async (annotationId) => {
    try {
      await deleteAnnotation(meta.id, annotationId);
    } catch {
      return;
    }
    // Close any explanation panel pinned to the highlight we just removed.
    dismissExplanationFor(annotationId);
    await refreshAnnotations(meta, pageNumber, wrap, state);
  };
}

async function refreshAnnotations(
  meta: DocumentMeta,
  pageNumber: number,
  wrap: HTMLElement,
  state: PageState,
): Promise<void> {
  if (!state.geom) return;
  let annotations: LocalAnnotation[];
  try {
    annotations = await listAnnotations(meta.id, pageNumber);
  } catch {
    annotations = [];
  }

  // Prime the explanation store from the browser cache (Spec 02/06) for these
  // highlights. On a cache hit, hovering won't hit the network — the tooltip
  // pops straight to the ready state.
  for (const ann of annotations) {
    if (!ann.explain) continue;
    try {
      const cached = await getCachedExplanation(meta.id, ann.id);
      if (cached && cached.status === "complete" && cached.content) {
        seedExplanation(ann.id, cached.kind, cached.content);
      }
    } catch {
      /* cache unavailable — first hover will stream instead */
    }
  }

  if (state.annotationLayer) state.annotationLayer.remove();
  const svg = buildAnnotationLayer(
    annotations,
    state.geom,
    makeAnnotationDeleteHandler(meta, pageNumber, wrap, state),
    meta,
    state.text ? flattenPageText(state.text) : null,
  );
  const textLayer = state.content.querySelector(".text-layer");
  if (textLayer) {
    state.content.insertBefore(svg, textLayer);
  } else {
    state.content.appendChild(svg);
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

  const rot = getRotation();
  const clientRects = Array.from(range.getClientRects()).filter(
    (r) => r.width > 0 && r.height > 0,
  );
  let viewportRects: Rect[];
  if (rot === 0) {
    viewportRects = clientRectsRelativeTo(clientRects, wrap.getBoundingClientRect());
  } else {
    // The content box is rotated; its screen AABB is centered on the rotation
    // center. Map each selection rect back into the content's unrotated space
    // so the usual page-space transform (below) still applies.
    const outer = state.content.getBoundingClientRect();
    viewportRects = clientRects.map((r) =>
      screenRectToContent(
        r,
        outer,
        state.geom!.displayWidthPx,
        state.geom!.displayHeightPx,
        rot,
      ),
    );
  }
  if (viewportRects.length === 0) return;
  const merged = mergeAdjacentLineRects(viewportRects);
  const pageRects: Rect[] = rectsToPageSpace(merged, state.geom);

  // Capture the selection text BEFORE we clear it — needed for AI
  // explanations on explanation highlights.
  const selectedText = sel.toString().trim();

  // Highlights live in the browser now: the client mints the id/created_at and
  // persists to IndexedDB. No network call.
  const saved = makeHighlight({
    docId: meta.id,
    page: pageNumber,
    color: mode.color,
    rects: pageRects,
    text: selectedText || null,
    explain: mode.explain,
  });
  try {
    await putAnnotation(saved);
  } catch {
    return;
  }
  sel.removeAllRanges();
  await refreshAnnotations(meta, pageNumber, wrap, state);

  // Explanation highlights eagerly generate an AI definition/explanation, and
  // the panel opens right away, pinned — so the reader sees it stream in
  // without having to hover the highlight (and keep hovering) while it
  // loads. The page text was already fetched to build this page's text
  // layer, so we send it directly rather than making the server re-derive it
  // from its own (possibly-evicted, since we run with no disk) copy of the
  // PDF.
  if (mode.explain && selectedText) {
    const pageText = state.text ? flattenPageText(state.text) : null;
    const group = state.annotationLayer?.querySelector<SVGGElement>(
      `[data-annotation-id="${saved.id}"]`,
    );
    if (group) {
      showExplanationForNewHighlight(
        group,
        meta,
        saved.id,
        pageNumber,
        selectedText,
        makeAnnotationDeleteHandler(meta, pageNumber, wrap, state),
        pageText,
      );
    } else {
      // Fallback: couldn't find the group to anchor the panel to — still
      // kick off the explanation so it's ready for the next hover.
      void startExplanation(meta.id, saved.id, selectedText, pageNumber, pageText ?? undefined);
    }
  }
}

/** (Re)draw the figure-detection outline layer from whatever is in
 * state.figures right now. Cheap and safe to call with an empty list — the
 * outlines simply disappear, which is itself useful signal ("detected 0
 * figures on this page"). */
function renderFigureLayer(_wrap: HTMLElement, state: PageState): void {
  if (state.figureLayer) {
    state.figureLayer.remove();
    state.figureLayer = null;
  }
  if (!state.geom) return;
  const svg = buildFigureLayer(state.figures, state.geom);
  const textLayer = state.content.querySelector(".text-layer");
  if (textLayer) {
    state.content.insertBefore(svg, textLayer);
  } else {
    state.content.appendChild(svg);
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
    // Seed the store from the browser cache so re-opening doesn't re-stream.
    for (const f of resp.figures) {
      try {
        const cached = await getCachedExplanation(meta.id, f.figure_id);
        if (cached && cached.status === "complete" && cached.content) {
          seedFigure(meta.id, f.figure_id, cached.content);
        }
      } catch {
        /* cache unavailable — hovering the figure will stream instead */
      }
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
  // Map the cursor from screen space into the content's unrotated space so
  // hit-testing works at any rotation (identity at 0°). The outer wrap rect is
  // axis-aligned and centered on the rotation center.
  const p = screenPointToContent(
    clientX,
    clientY,
    wrapRect,
    state.geom.displayWidthPx,
    state.geom.displayHeightPx,
    getRotation(),
  );
  for (const fig of state.figures) {
    const v = pageBBoxToViewport(fig.bbox, state.geom);
    if (p.x >= v.x0 && p.x <= v.x1 && p.y >= v.y0 && p.y <= v.y1) {
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
    // A double-click landing inside a figure's bounds routinely lands near
    // *some* real text run too (dense scientific figures are full of small
    // embedded labels/gene names) — the browser's native double-click word
    // selection can pick one up even though it's not what `target.closest`
    // resolved to. Left alone, that stray selection would be picked up by
    // wireHighlightOnSelection's deferred mouseup handler (still queued at
    // this point — it defers via setTimeout) and turned into a bogus
    // explanation highlight alongside the figure card. Clearing it here runs
    // before that deferred check does.
    window.getSelection()?.removeAllRanges();
    // Anchor the card to the figure's actual rendered outline, which already
    // reflects the current rotation, rather than recomputing a screen rect.
    const figEl = state.figureLayer?.querySelector<SVGGElement>(
      `[data-figure-id="${CSS.escape(fig.figure_id)}"]`,
    );
    let figRect: DOMRect;
    if (figEl) {
      figRect = figEl.getBoundingClientRect();
    } else {
      const v = pageBBoxToViewport(fig.bbox, state.geom);
      figRect = new DOMRect(
        wrapRect.left + v.x0,
        wrapRect.top + v.y0,
        v.x1 - v.x0,
        v.y1 - v.y0,
      );
    }
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
