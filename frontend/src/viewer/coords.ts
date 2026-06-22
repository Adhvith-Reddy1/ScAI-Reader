/**
 * Coordinate transforms between PDF page-space (points, origin top-left) and
 * viewport-space (CSS pixels, origin top-left of the rendered page <img>).
 *
 * Layers (text, annotations, citations) are rendered into an inner "canvas"
 * element sized to the *unrotated* page and then CSS-rotated as a unit. So the
 * forward, display-time transform (`pageBBoxToViewport`) stays a plain scale —
 * the CSS rotation does the rest, keeping every layer aligned for free.
 *
 * The reverse path is different: a text selection's rectangles come back from
 * the browser already in the rotated frame, so converting them to page-space
 * (`viewportRectToPageRect`) must undo both the scale and the rotation. That's
 * the only place the rotation math lives.
 */

export interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Point {
  x: number;
  y: number;
}

export interface PageGeometry {
  pageWidthPt: number;
  pageHeightPt: number;
  /** Inner (unrotated) display size in CSS px. */
  displayWidthPx: number;
  displayHeightPx: number;
  /** Clockwise rotation applied to the inner canvas: 0 | 90 | 180 | 270. */
  rotation: number;
}

export function scale(geom: PageGeometry): { sx: number; sy: number } {
  return {
    sx: geom.displayWidthPx / geom.pageWidthPt,
    sy: geom.displayHeightPx / geom.pageHeightPt,
  };
}

/**
 * Convert a page-space bbox to inner-canvas (viewport) pixels. Unrotated on
 * purpose — the inner canvas carries the CSS rotation, so layers built with
 * this transform rotate along with the page image.
 */
export function pageBBoxToViewport(b: BBox, geom: PageGeometry): BBox {
  const { sx, sy } = scale(geom);
  return {
    x0: b.x0 * sx,
    y0: b.y0 * sy,
    x1: b.x1 * sx,
    y1: b.y1 * sy,
  };
}

/** The rotated (on-screen) footprint of the page in CSS px. */
export function visualSize(geom: PageGeometry): { w: number; h: number } {
  const swap = geom.rotation === 90 || geom.rotation === 270;
  return swap
    ? { w: geom.displayHeightPx, h: geom.displayWidthPx }
    : { w: geom.displayWidthPx, h: geom.displayHeightPx };
}

function rotateVec(x: number, y: number, deg: number): [number, number] {
  switch (((deg % 360) + 360) % 360) {
    case 90:
      return [-y, x];
    case 180:
      return [-x, -y];
    case 270:
      return [y, -x];
    default:
      return [x, y];
  }
}

function innerOffset(geom: PageGeometry): [number, number] {
  const { w, h } = visualSize(geom);
  return [(w - geom.displayWidthPx) / 2, (h - geom.displayHeightPx) / 2];
}

/** Page-space point → on-screen (visual-box) pixel point. */
export function pagePointToVisual(pt: Point, geom: PageGeometry): Point {
  const { sx, sy } = scale(geom);
  const cx = geom.displayWidthPx / 2;
  const cy = geom.displayHeightPx / 2;
  const [ox, oy] = innerOffset(geom);
  const [rx, ry] = rotateVec(pt.x * sx - cx, pt.y * sy - cy, geom.rotation);
  return { x: rx + cx + ox, y: ry + cy + oy };
}

/** On-screen (visual-box) pixel point → page-space point. Inverse of above. */
export function visualPointToPage(pt: Point, geom: PageGeometry): Point {
  const { sx, sy } = scale(geom);
  const cx = geom.displayWidthPx / 2;
  const cy = geom.displayHeightPx / 2;
  const [ox, oy] = innerOffset(geom);
  // Undo the rotation by spinning back the same amount.
  const [ix, iy] = rotateVec(pt.x - cx - ox, pt.y - cy - oy, 360 - geom.rotation);
  return { x: (ix + cx) / sx, y: (iy + cy) / sy };
}

/**
 * Convert a rect expressed in the page's *visual* box (i.e. relative to the
 * rotated outer wrap) into page-space. Transforms all four corners and takes
 * the axis-aligned bounds — exact for 90° multiples.
 */
export function viewportRectToPageRect(b: BBox, geom: PageGeometry): BBox {
  const corners: Point[] = [
    { x: b.x0, y: b.y0 },
    { x: b.x1, y: b.y0 },
    { x: b.x1, y: b.y1 },
    { x: b.x0, y: b.y1 },
  ].map((p) => visualPointToPage(p, geom));
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  return {
    x0: Math.min(...xs),
    y0: Math.min(...ys),
    x1: Math.max(...xs),
    y1: Math.max(...ys),
  };
}

/** Page-space bbox → on-screen visual rect (axis-aligned bounds). */
export function pageBBoxToVisualRect(b: BBox, geom: PageGeometry): BBox {
  const corners: Point[] = [
    { x: b.x0, y: b.y0 },
    { x: b.x1, y: b.y0 },
    { x: b.x1, y: b.y1 },
    { x: b.x0, y: b.y1 },
  ].map((p) => pagePointToVisual(p, geom));
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  return {
    x0: Math.min(...xs),
    y0: Math.min(...ys),
    x1: Math.max(...xs),
    y1: Math.max(...ys),
  };
}

/** Back-compat name used by the selection path; rotation-aware. */
export function viewportBBoxToPage(b: BBox, geom: PageGeometry): BBox {
  return viewportRectToPageRect(b, geom);
}

export function bboxWidth(b: BBox): number {
  return b.x1 - b.x0;
}
export function bboxHeight(b: BBox): number {
  return b.y1 - b.y0;
}
