/**
 * Viewer-aware zoom: applies a zoom while keeping a document point anchored
 * to a viewport position. The plain [[zoom]] module is pure state — it
 * doesn't know about the scroll container. This module owns the bridge.
 *
 * Three call sites, all anchored:
 *   - Trackpad pinch / Cmd+wheel → anchored at the cursor (the gesture's
 *     center). Locked at gesture start so finger drift on the trackpad
 *     doesn't drag the scroll position around.
 *   - Toolbar +/− buttons       → anchored at the viewer center.
 *   - Cmd+± / Cmd+0 keyboard    → anchored at the viewer center.
 *
 * Without anchoring, the page sizes change but scrollTop doesn't — on a
 * 5M-pixel-tall textbook a single zoom step shifts the visible content by
 * hundreds of pages.
 */

import {
  getZoom,
  setZoom,
  ZOOM_STEPS_FOR_NEXT_PREV,
  type ZoomStep,
} from "./zoom.ts";

let viewer: HTMLElement | null = null;

export function initViewerZoom(el: HTMLElement): void {
  viewer = el;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function zoomAroundClientPoint(
  clientX: number,
  clientY: number,
  newZoom: number,
): void {
  if (!viewer) {
    setZoom(newZoom);
    return;
  }
  const oldZoom = getZoom();
  const rect = viewer.getBoundingClientRect();

  // If the cursor is OUTSIDE the viewer (over the toolbar, the page-jump
  // input, the browser chrome, an empty area to the side, etc.) the cursor
  // is not a meaningful anchor — clamping to the nearest viewer edge would
  // anchor to top/bottom/left/right of the viewer, which on a fit-width doc
  // produces the "zoom into bottom-left of the page" effect. Fall back to
  // the viewer center so the visible content stays roughly put.
  const rawOffsetX = clientX - rect.left;
  const rawOffsetY = clientY - rect.top;
  const insideX = rawOffsetX >= 0 && rawOffsetX <= viewer.clientWidth;
  const insideY = rawOffsetY >= 0 && rawOffsetY <= viewer.clientHeight;
  const offsetX = insideX && insideY ? rawOffsetX : viewer.clientWidth / 2;
  const offsetY = insideX && insideY ? rawOffsetY : viewer.clientHeight / 2;
  const contentX = viewer.scrollLeft + offsetX;
  const contentY = viewer.scrollTop + offsetY;

  setZoom(newZoom);
  const ratio = oldZoom === 0 ? 1 : getZoom() / oldZoom;

  // Read scrollHeight/scrollWidth — this forces a layout flush so the
  // dimensions reflect the just-zoomed page sizes, AND gives us precise
  // max scroll values to clamp against.
  const maxScrollLeft = Math.max(0, viewer.scrollWidth - viewer.clientWidth);
  const maxScrollTop = Math.max(0, viewer.scrollHeight - viewer.clientHeight);
  viewer.scrollLeft = clamp(contentX * ratio - offsetX, 0, maxScrollLeft);
  viewer.scrollTop = clamp(contentY * ratio - offsetY, 0, maxScrollTop);
}

export function zoomAroundViewerCenter(newZoom: number): void {
  if (!viewer) {
    setZoom(newZoom);
    return;
  }
  const rect = viewer.getBoundingClientRect();
  zoomAroundClientPoint(
    rect.left + rect.width / 2,
    rect.top + rect.height / 2,
    newZoom,
  );
}

export function zoomInAtViewerCenter(): void {
  const next = nextStep();
  if (next != null) zoomAroundViewerCenter(next);
}

export function zoomOutAtViewerCenter(): void {
  const prev = prevStep();
  if (prev != null) zoomAroundViewerCenter(prev);
}

export function resetZoomAtViewerCenter(): void {
  zoomAroundViewerCenter(1.0);
}

function nextStep(): ZoomStep | null {
  const current = getZoom();
  return ZOOM_STEPS_FOR_NEXT_PREV.find((s) => s > current + 1e-4) ?? null;
}

function prevStep(): ZoomStep | null {
  const current = getZoom();
  let prev: ZoomStep | null = null;
  for (const s of ZOOM_STEPS_FOR_NEXT_PREV) {
    if (s < current - 1e-4) prev = s;
  }
  return prev;
}
