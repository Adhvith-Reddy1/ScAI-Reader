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

  // Anchor by preserving the cursor's FRACTION through the scrollable area
  // rather than its absolute content position. This is exact across zoom
  // in/out cycles regardless of how much of the scrollHeight is taken up
  // by non-scaling content (32px page gaps, 24px viewer padding) — they
  // make up ~3% of scrollHeight on a long doc, and the absolute-position
  // formula treats them as scaling, drifting the anchor by 0.6+ pages
  // per zoom step.
  //
  // scrollHeight and scrollWidth must be read BEFORE setZoom (for the old
  // fraction) and AFTER (for the new target position).
  const oldScrollHeight = viewer.scrollHeight;
  const oldScrollWidth = viewer.scrollWidth;
  const fracY = oldScrollHeight > 0
    ? (viewer.scrollTop + offsetY) / oldScrollHeight
    : 0;
  const fracX = oldScrollWidth > 0
    ? (viewer.scrollLeft + offsetX) / oldScrollWidth
    : 0;

  setZoom(newZoom);

  // Touch scrollHeight to force layout, then clamp the assignment ourselves
  // (the browser's clamp can be off by a few px on long docs when scrollTop
  // is written before layout settles).
  const newScrollHeight = viewer.scrollHeight;
  const newScrollWidth = viewer.scrollWidth;
  const maxScrollLeft = Math.max(0, newScrollWidth - viewer.clientWidth);
  const maxScrollTop = Math.max(0, newScrollHeight - viewer.clientHeight);
  viewer.scrollLeft = clamp(fracX * newScrollWidth - offsetX, 0, maxScrollLeft);
  viewer.scrollTop = clamp(fracY * newScrollHeight - offsetY, 0, maxScrollTop);

  // oldZoom is read just to allow callers to detect a no-op zoom; setZoom
  // already clamped to [MIN, MAX], so if newZoom was out of range we still
  // adjusted scroll for whatever zoom actually applied.
  void oldZoom;
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
