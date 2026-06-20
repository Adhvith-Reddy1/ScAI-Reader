/**
 * Capture text-selection rectangles and convert them to page-space (PDF points).
 *
 * `Range.getClientRects()` returns viewport-space rectangles. We translate
 * them into the page-wrap's local coordinate space (so scroll/zoom don't
 * affect what gets stored), then divide by the scale factor to land in
 * page-space. Page-space coords are what live in SQLite, so highlights stay
 * accurate across zoom levels and rerenders.
 */

import type { Rect } from "../api.ts";
import { viewportBBoxToPage, type PageGeometry } from "./coords.ts";

/** Convert a DOMRectList into viewport-space rects relative to `container`. */
export function clientRectsRelativeTo(
  rects: DOMRectList | DOMRect[],
  container: DOMRect,
): Rect[] {
  const out: Rect[] = [];
  for (const r of Array.from(rects)) {
    if (r.width <= 0 || r.height <= 0) continue;
    out.push({
      x0: r.left - container.left,
      y0: r.top - container.top,
      x1: r.right - container.left,
      y1: r.bottom - container.top,
    });
  }
  return out;
}

/** Map a list of viewport-space rects (relative to page-wrap) into page-space. */
export function rectsToPageSpace(rects: Rect[], geom: PageGeometry): Rect[] {
  return rects.map((r) => viewportBBoxToPage(r, geom));
}

/**
 * Union all rectangles on the same line into one big rect per line.
 *
 * Selection on our text layer returns one rect per text-run span, even when
 * the runs are visually one continuous line. If we save those as-is, each
 * highlight is a row of tiny disconnected scraps. We bucket by baseline y
 * (within `epsilonPx`) and union per bucket. Result: one clean rect per line.
 */
export function mergeAdjacentLineRects(
  rects: Rect[],
  epsilonPx = 3.0,
): Rect[] {
  if (rects.length <= 1) return rects.slice();
  const sorted = [...rects].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const lines: Rect[][] = [];
  for (const r of sorted) {
    const tail = lines[lines.length - 1];
    if (tail && Math.abs(r.y0 - tail[0].y0) < epsilonPx) {
      tail.push(r);
    } else {
      lines.push([r]);
    }
  }
  return lines.map((line) => ({
    x0: Math.min(...line.map((r) => r.x0)),
    y0: Math.min(...line.map((r) => r.y0)),
    x1: Math.max(...line.map((r) => r.x1)),
    y1: Math.max(...line.map((r) => r.y1)),
  }));
}
