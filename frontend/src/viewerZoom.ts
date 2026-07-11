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

function clampScroll(el: HTMLElement, left: number, top: number): void {
  const maxScrollLeft = Math.max(0, el.scrollWidth - el.clientWidth);
  const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
  el.scrollLeft = clamp(left, 0, maxScrollLeft);
  el.scrollTop = clamp(top, 0, maxScrollTop);
}

/** Approximate fallback for when the anchor point isn't over any page (e.g.
 * a fast zoom-out shrinks and re-centers the page out from under a cursor
 * that hasn't moved). Preserves the cursor's fraction through the viewer's
 * total scroll extent — not exact (it mixes in non-scaling padding/gaps),
 * but far better than leaving scroll untouched, which is what a bare
 * `setZoom` would do here. */
function zoomByScrollFraction(
  el: HTMLElement,
  anchorX: number,
  anchorY: number,
  newZoom: number,
): void {
  const rect = el.getBoundingClientRect();
  const offsetX = anchorX - rect.left;
  const offsetY = anchorY - rect.top;
  const oldScrollWidth = el.scrollWidth;
  const oldScrollHeight = el.scrollHeight;
  const fracX = oldScrollWidth > 0 ? (el.scrollLeft + offsetX) / oldScrollWidth : 0;
  const fracY = oldScrollHeight > 0 ? (el.scrollTop + offsetY) / oldScrollHeight : 0;

  setZoom(newZoom);

  clampScroll(
    el,
    fracX * el.scrollWidth - offsetX,
    fracY * el.scrollHeight - offsetY,
  );
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
  const rect = viewer.getBoundingClientRect();

  // If the cursor is OUTSIDE the viewer (over the toolbar, the page-jump
  // input, the browser chrome, an empty area to the side, etc.) the cursor
  // is not a meaningful anchor — clamping to the nearest viewer edge would
  // anchor to top/bottom/left/right of the viewer, which on a fit-width doc
  // produces the "zoom into bottom-left of the page" effect. Fall back to
  // the viewer center so the visible content stays roughly put.
  const insideX = clientX >= rect.left && clientX <= rect.right;
  const insideY = clientY >= rect.top && clientY <= rect.bottom;
  const anchorX = insideX && insideY ? clientX : rect.left + viewer.clientWidth / 2;
  const anchorY = insideX && insideY ? clientY : rect.top + viewer.clientHeight / 2;

  // Anchor against the actual page under the cursor, not a fraction of the
  // viewer's total scroll extent. A .page-wrap scales uniformly with zoom —
  // nothing inside its own box is fixed-size — so the cursor's fractional
  // position within it is exact at any zoom level. Anchoring against
  // scrollWidth/scrollHeight instead is NOT exact: they also include
  // non-scaling content (viewer padding, inter-page gaps), so a fraction of
  // the *total* drifts further off the real cursor position with every
  // step — worse the shorter the document, since fixed padding/gaps make up
  // a bigger share of a short doc's scroll extent.
  const pageWrap = document
    .elementFromPoint(anchorX, anchorY)
    ?.closest<HTMLElement>(".page-wrap");

  if (!pageWrap) {
    // Cursor isn't over any page (e.g. the gap between pages, or a fast
    // zoom-out shrank the page out from under a stationary cursor) — fall
    // back to an approximate anchor rather than leaving scroll untouched.
    zoomByScrollFraction(viewer, anchorX, anchorY, newZoom);
    return;
  }

  const before = pageWrap.getBoundingClientRect();
  const fx = before.width > 0 ? (anchorX - before.left) / before.width : 0.5;
  const fy = before.height > 0 ? (anchorY - before.top) / before.height : 0.5;

  setZoom(newZoom);

  // Same element, now resized by the zoom change. Find where the same
  // fractional point landed and shift scroll by exactly that delta to bring
  // it back under the anchor — exact regardless of any non-scaling content
  // elsewhere in the scroll container.
  const after = pageWrap.getBoundingClientRect();
  const nowX = after.left + fx * after.width;
  const nowY = after.top + fy * after.height;
  clampScroll(
    viewer,
    viewer.scrollLeft + (nowX - anchorX),
    viewer.scrollTop + (nowY - anchorY),
  );
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
