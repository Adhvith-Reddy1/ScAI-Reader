import { describe, it, expect } from "vitest";
import {
  pageBBoxToViewport,
  viewportBBoxToPage,
  scale,
  type PageGeometry,
} from "./coords.ts";

const lettersize: PageGeometry = {
  pageWidthPt: 612,
  pageHeightPt: 792,
  displayWidthPx: 900,
  displayHeightPx: 1164.7058823529412, // 900 * 792/612
};

describe("scale", () => {
  it("matches displayed dimensions", () => {
    const { sx, sy } = scale(lettersize);
    expect(sx).toBeCloseTo(900 / 612, 6);
    expect(sy).toBeCloseTo(1164.7 / 792, 4);
  });
});

describe("page <-> viewport round trip", () => {
  it("is identity for arbitrary bbox", () => {
    const original = { x0: 72, y0: 100, x1: 300, y1: 120 };
    const round = viewportBBoxToPage(
      pageBBoxToViewport(original, lettersize),
      lettersize,
    );
    expect(round.x0).toBeCloseTo(72, 6);
    expect(round.y0).toBeCloseTo(100, 6);
    expect(round.x1).toBeCloseTo(300, 6);
    expect(round.y1).toBeCloseTo(120, 6);
  });

  it("is identity at varying displayed widths (zoom)", () => {
    const original = { x0: 50, y0: 50, x1: 200, y1: 70 };
    for (const displayWidthPx of [300, 600, 900, 1800]) {
      const geom: PageGeometry = {
        pageWidthPt: 612,
        pageHeightPt: 792,
        displayWidthPx,
        displayHeightPx: displayWidthPx * (792 / 612),
      };
      const round = viewportBBoxToPage(
        pageBBoxToViewport(original, geom),
        geom,
      );
      expect(round.x0).toBeCloseTo(original.x0, 6);
      expect(round.y1).toBeCloseTo(original.y1, 6);
    }
  });
});

describe("pageBBoxToViewport", () => {
  it("scales linearly", () => {
    const b = pageBBoxToViewport(
      { x0: 0, y0: 0, x1: 612, y1: 792 },
      lettersize,
    );
    expect(b.x0).toBe(0);
    expect(b.y0).toBe(0);
    expect(b.x1).toBeCloseTo(900, 6);
    expect(b.y1).toBeCloseTo(1164.7058823529412, 6);
  });

  it("preserves nesting (a bbox inside another stays inside)", () => {
    const outer = { x0: 0, y0: 0, x1: 612, y1: 792 };
    const inner = { x0: 100, y0: 100, x1: 200, y1: 200 };
    const o = pageBBoxToViewport(outer, lettersize);
    const i = pageBBoxToViewport(inner, lettersize);
    expect(i.x0).toBeGreaterThanOrEqual(o.x0);
    expect(i.y0).toBeGreaterThanOrEqual(o.y0);
    expect(i.x1).toBeLessThanOrEqual(o.x1);
    expect(i.y1).toBeLessThanOrEqual(o.y1);
  });
});
