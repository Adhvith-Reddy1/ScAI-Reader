/**
 * Pure geometry for view rotation.
 *
 * A rotated page is drawn by rotating its *content box* (the page image plus
 * every overlay, as one unit) with a CSS transform, while the outer page box
 * reserves the rotated footprint in the scroll layout. Rendering overlays needs
 * no rotation math — they're positioned in the content's own unrotated space
 * and carried along by the CSS transform.
 *
 * Only *pointer* input needs to go the other way: a click / text-selection rect
 * arrives in screen space (already visually rotated), and we must map it back
 * into the content's unrotated coordinate space before the usual page-space
 * transforms apply. That inverse is exact for 90° multiples (a right-angle
 * rotation maps an axis-aligned rect to an axis-aligned rect), which is all we
 * support.
 */

import type { Rotation } from "../rotation.ts";

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OuterBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The layout footprint (CSS px) a page occupies after rotation: width and
 * height swap for the quarter turns, unchanged for 0° / 180°. */
export function rotatedFootprint(
  widthPx: number,
  heightPx: number,
  deg: Rotation,
): { width: number; height: number } {
  return deg === 90 || deg === 270
    ? { width: heightPx, height: widthPx }
    : { width: widthPx, height: heightPx };
}

/**
 * Map a screen point into the page content's own unrotated coordinate space.
 *
 * `outer` is the axis-aligned screen rect of the outer page box (the rotated
 * footprint). The content, sized `contentW × contentH` unrotated, is centered
 * inside `outer` and visually rotated by `deg`. This applies the inverse
 * rotation. At `deg === 0` it reduces to a plain offset from the box's top-left.
 */
export function screenPointToContent(
  px: number,
  py: number,
  outer: OuterBox,
  contentW: number,
  contentH: number,
  deg: Rotation,
): { x: number; y: number } {
  const cx = outer.left + outer.width / 2;
  const cy = outer.top + outer.height / 2;
  const vx = px - cx;
  const vy = py - cy;
  // Inverse-rotate the vector from the center by -deg. Rounding cos/sin makes
  // the 90° multiples exact (cos 90° computes as ~6e-17 otherwise).
  const rad = (-deg * Math.PI) / 180;
  const cos = Math.round(Math.cos(rad));
  const sin = Math.round(Math.sin(rad));
  const rx = vx * cos - vy * sin;
  const ry = vx * sin + vy * cos;
  return { x: rx + contentW / 2, y: ry + contentH / 2 };
}

/**
 * Map a screen-space rect into the content's unrotated coordinate space,
 * returning an axis-aligned bbox. Exact for 90° multiples. Zero-area rects are
 * still mapped (callers filter those out upstream).
 */
export function screenRectToContent(
  r: { left: number; top: number; right: number; bottom: number },
  outer: OuterBox,
  contentW: number,
  contentH: number,
  deg: Rotation,
): Rect {
  const corners = [
    [r.left, r.top],
    [r.right, r.top],
    [r.right, r.bottom],
    [r.left, r.bottom],
  ].map(([x, y]) =>
    screenPointToContent(x, y, outer, contentW, contentH, deg),
  );
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  return {
    x0: Math.min(...xs),
    y0: Math.min(...ys),
    x1: Math.max(...xs),
    y1: Math.max(...ys),
  };
}
