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

  // Clamp the anchor to the viewer's visible area. clientX/Y may be over the
  // toolbar (cursor after pressing Enter in the page-jump input) or below
  // the viewer (cursor near the bottom of the window). Anchoring outside
  // the viewer is mathematically valid but at large scrollTop pulls the
  // view by dozens of px per tick.
  const offsetX = clamp(clientX - rect.left, 0, viewer.clientWidth);
  const offsetY = clamp(clientY - rect.top, 0, viewer.clientHeight);
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
