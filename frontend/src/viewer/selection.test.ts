import { describe, it, expect } from "vitest";
import {
  clientRectsRelativeTo,
  rectsToPageSpace,
  mergeAdjacentLineRects,
} from "./selection.ts";
import type { PageGeometry } from "./coords.ts";

const geom: PageGeometry = {
  pageWidthPt: 612,
  pageHeightPt: 792,
  displayWidthPx: 900,
  displayHeightPx: 1164.7,
  rotation: 0,
};

function dr(left: number, top: number, right: number, bottom: number): DOMRect {
  return new DOMRect(left, top, right - left, bottom - top);
}

describe("clientRectsRelativeTo", () => {
  it("subtracts container origin", () => {
    const container = dr(100, 200, 1000, 1400);
    const rects = [dr(150, 250, 300, 270)];
    const out = clientRectsRelativeTo(rects, container);
    expect(out).toEqual([{ x0: 50, y0: 50, x1: 200, y1: 70 }]);
  });

  it("filters out zero-size rects", () => {
    const container = dr(0, 0, 1000, 1000);
    const rects = [dr(10, 10, 10, 10), dr(20, 20, 50, 30)];
    const out = clientRectsRelativeTo(rects, container);
    expect(out.length).toBe(1);
  });
});

describe("rectsToPageSpace", () => {
  it("scales by display→page ratio", () => {
    const out = rectsToPageSpace(
      [{ x0: 0, y0: 0, x1: 900, y1: 1164.7 }],
      geom,
    );
    expect(out[0].x0).toBeCloseTo(0, 6);
    expect(out[0].x1).toBeCloseTo(612, 4);
    expect(out[0].y1).toBeCloseTo(792, 0);
  });
});

describe("mergeAdjacentLineRects", () => {
  it("merges two touching rects on the same line", () => {
    const merged = mergeAdjacentLineRects([
      { x0: 0, y0: 10, x1: 50, y1: 22 },
      { x0: 50, y0: 10, x1: 120, y1: 22 },
    ]);
    expect(merged).toEqual([{ x0: 0, y0: 10, x1: 120, y1: 22 }]);
  });

  it("merges word-rects with big x gaps on the same line", () => {
    // Regression: selection returns one rect per span with multi-pixel gaps
    // between words. We must still merge into one line rect.
    const merged = mergeAdjacentLineRects([
      { x0: 0, y0: 10, x1: 50, y1: 22 },
      { x0: 70, y0: 10, x1: 120, y1: 22 },
      { x0: 150, y0: 10, x1: 200, y1: 22 },
    ]);
    expect(merged).toEqual([{ x0: 0, y0: 10, x1: 200, y1: 22 }]);
  });

  it("keeps rects on different lines separate", () => {
    const merged = mergeAdjacentLineRects([
      { x0: 0, y0: 10, x1: 100, y1: 22 },
      { x0: 0, y0: 30, x1: 100, y1: 42 },
    ]);
    expect(merged.length).toBe(2);
  });

  it("treats rects within 3px of each other as the same line", () => {
    const merged = mergeAdjacentLineRects([
      { x0: 0, y0: 10, x1: 100, y1: 22 },
      { x0: 110, y0: 11.5, x1: 200, y1: 23 },
    ]);
    expect(merged.length).toBe(1);
  });
});
