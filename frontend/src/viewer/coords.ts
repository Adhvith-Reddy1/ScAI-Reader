/**
 * Coordinate transforms between PDF page-space (points, origin top-left) and
 * viewport-space (CSS pixels, origin top-left of the rendered page <img>).
 *
 * The text layer overlays the page image at exactly the image's displayed
 * size, so positioning is just a uniform scale.
 */

export interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PageGeometry {
  pageWidthPt: number;
  pageHeightPt: number;
  displayWidthPx: number;
  displayHeightPx: number;
}

export function scale(geom: PageGeometry): { sx: number; sy: number } {
  return {
    sx: geom.displayWidthPx / geom.pageWidthPt,
    sy: geom.displayHeightPx / geom.pageHeightPt,
  };
}

/** Convert a page-space bbox to viewport-space pixel rect. */
export function pageBBoxToViewport(b: BBox, geom: PageGeometry): BBox {
  const { sx, sy } = scale(geom);
  return {
    x0: b.x0 * sx,
    y0: b.y0 * sy,
    x1: b.x1 * sx,
    y1: b.y1 * sy,
  };
}

/** Convert a viewport-space pixel rect to page-space. */
export function viewportBBoxToPage(b: BBox, geom: PageGeometry): BBox {
  const { sx, sy } = scale(geom);
  return {
    x0: b.x0 / sx,
    y0: b.y0 / sy,
    x1: b.x1 / sx,
    y1: b.y1 / sy,
  };
}

export function bboxWidth(b: BBox): number {
  return b.x1 - b.x0;
}
export function bboxHeight(b: BBox): number {
  return b.y1 - b.y0;
}
