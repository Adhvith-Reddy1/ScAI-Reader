import { describe, it, expect } from "vitest";
import {
  pageBBoxToViewport,
  pageBBoxToVisualRect,
  pagePointToVisual,
  viewportBBoxToPage,
  viewportRectToPageRect,
  visualPointToPage,
  visualSize,
  scale,
  type PageGeometry,
} from "./coords.ts";

const lettersize: PageGeometry = {
  pageWidthPt: 612,
  pageHeightPt: 792,
  displayWidthPx: 900,
  displayHeightPx: 1164.7058823529412, // 900 * 792/612
  rotation: 0,
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
        rotation: 0,
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

describe("rotation transforms", () => {
  // Scale 1 (display px == page pt) keeps the arithmetic legible.
  const geomAt = (rotation: number): PageGeometry => ({
    pageWidthPt: 612,
    pageHeightPt: 792,
    displayWidthPx: 612,
    displayHeightPx: 792,
    rotation,
  });

  it("swaps the visual footprint at 90° and 270°", () => {
    expect(visualSize(geomAt(0))).toEqual({ w: 612, h: 792 });
    expect(visualSize(geomAt(180))).toEqual({ w: 612, h: 792 });
    expect(visualSize(geomAt(90))).toEqual({ w: 792, h: 612 });
    expect(visualSize(geomAt(270))).toEqual({ w: 792, h: 612 });
  });

  it("maps the page top-left to the expected on-screen corner", () => {
    // Clockwise: page top-left lands at the visual top-right at 90°.
    const at90 = pagePointToVisual({ x: 0, y: 0 }, geomAt(90));
    expect(at90.x).toBeCloseTo(792, 6);
    expect(at90.y).toBeCloseTo(0, 6);
    // 180° sends it to the bottom-right.
    const at180 = pagePointToVisual({ x: 0, y: 0 }, geomAt(180));
    expect(at180.x).toBeCloseTo(612, 6);
    expect(at180.y).toBeCloseTo(792, 6);
    // 270° sends it to the bottom-left.
    const at270 = pagePointToVisual({ x: 0, y: 0 }, geomAt(270));
    expect(at270.x).toBeCloseTo(0, 6);
    expect(at270.y).toBeCloseTo(612, 6);
  });

  it("round-trips page → visual → page at every rotation", () => {
    for (const rotation of [0, 90, 180, 270]) {
      const geom = geomAt(rotation);
      for (const pt of [
        { x: 0, y: 0 },
        { x: 153, y: 400 },
        { x: 612, y: 792 },
      ]) {
        const back = visualPointToPage(pagePointToVisual(pt, geom), geom);
        expect(back.x).toBeCloseTo(pt.x, 5);
        expect(back.y).toBeCloseTo(pt.y, 5);
      }
    }
  });

  it("round-trips a bbox through the visual rect at every rotation", () => {
    const box = { x0: 100, y0: 150, x1: 260, y1: 180 };
    for (const rotation of [0, 90, 180, 270]) {
      const geom = geomAt(rotation);
      const back = viewportRectToPageRect(pageBBoxToVisualRect(box, geom), geom);
      expect(back.x0).toBeCloseTo(box.x0, 4);
      expect(back.y0).toBeCloseTo(box.y0, 4);
      expect(back.x1).toBeCloseTo(box.x1, 4);
      expect(back.y1).toBeCloseTo(box.y1, 4);
    }
  });

  it("keeps scale-only behavior at rotation 0 (no regression)", () => {
    const box = { x0: 72, y0: 100, x1: 300, y1: 120 };
    const viaRotation = viewportRectToPageRect(
      pageBBoxToViewport(box, geomAt(0)),
      geomAt(0),
    );
    expect(viaRotation.x0).toBeCloseTo(72, 6);
    expect(viaRotation.y1).toBeCloseTo(120, 6);
  });
});
