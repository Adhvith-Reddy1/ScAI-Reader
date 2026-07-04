import { describe, expect, it } from "vitest";
import {
  rotatedFootprint,
  screenPointToContent,
  screenRectToContent,
} from "./rotate.ts";

describe("rotatedFootprint", () => {
  it("keeps dimensions for 0 and 180", () => {
    expect(rotatedFootprint(100, 200, 0)).toEqual({ width: 100, height: 200 });
    expect(rotatedFootprint(100, 200, 180)).toEqual({ width: 100, height: 200 });
  });
  it("swaps dimensions for 90 and 270", () => {
    expect(rotatedFootprint(100, 200, 90)).toEqual({ width: 200, height: 100 });
    expect(rotatedFootprint(100, 200, 270)).toEqual({ width: 200, height: 100 });
  });
});

describe("screenPointToContent", () => {
  // Content is 100 wide × 200 tall. At 0° the outer box equals the content.
  const outer0 = { left: 0, top: 0, width: 100, height: 200 };
  // At 90°/270° the outer footprint is swapped: 200 × 100.
  const outerQuarter = { left: 0, top: 0, width: 200, height: 100 };

  it("is a plain offset at 0° (identity vs the box top-left)", () => {
    expect(screenPointToContent(0, 0, outer0, 100, 200, 0)).toEqual({ x: 0, y: 0 });
    expect(screenPointToContent(30, 40, outer0, 100, 200, 0)).toEqual({
      x: 30,
      y: 40,
    });
    expect(screenPointToContent(100, 200, outer0, 100, 200, 0)).toEqual({
      x: 100,
      y: 200,
    });
  });

  it("inverts a 90° clockwise rotation", () => {
    // Forward (CSS rotate(90deg), y-down): content (x,y) → screen (200−y, x).
    // So content corners map from screen: (200,0)→(0,0); (0,100)→(100,200).
    expect(screenPointToContent(200, 0, outerQuarter, 100, 200, 90)).toEqual({
      x: 0,
      y: 0,
    });
    expect(screenPointToContent(0, 100, outerQuarter, 100, 200, 90)).toEqual({
      x: 100,
      y: 200,
    });
    expect(screenPointToContent(0, 0, outerQuarter, 100, 200, 90)).toEqual({
      x: 0,
      y: 200,
    });
  });

  it("inverts a 180° rotation", () => {
    const outer = { left: 0, top: 0, width: 100, height: 200 };
    expect(screenPointToContent(100, 200, outer, 100, 200, 180)).toEqual({
      x: 0,
      y: 0,
    });
    expect(screenPointToContent(0, 0, outer, 100, 200, 180)).toEqual({
      x: 100,
      y: 200,
    });
  });

  it("inverts a 270° rotation", () => {
    // Forward at 270° (i.e. −90°): content (x,y) → screen (y, 100−x).
    expect(screenPointToContent(0, 100, outerQuarter, 100, 200, 270)).toEqual({
      x: 0,
      y: 0,
    });
    expect(screenPointToContent(200, 0, outerQuarter, 100, 200, 270)).toEqual({
      x: 100,
      y: 200,
    });
  });

  it("respects a non-zero outer origin (scroll offset)", () => {
    const outer = { left: 500, top: 300, width: 100, height: 200 };
    expect(screenPointToContent(500, 300, outer, 100, 200, 0)).toEqual({
      x: 0,
      y: 0,
    });
    expect(screenPointToContent(530, 340, outer, 100, 200, 0)).toEqual({
      x: 30,
      y: 40,
    });
  });
});

describe("screenRectToContent", () => {
  it("maps a screen rect to an axis-aligned content bbox at 0°", () => {
    const outer = { left: 0, top: 0, width: 100, height: 200 };
    const r = { left: 10, top: 20, right: 60, bottom: 30 };
    expect(screenRectToContent(r, outer, 100, 200, 0)).toEqual({
      x0: 10,
      y0: 20,
      x1: 60,
      y1: 30,
    });
  });

  it("maps a screen rect through a 90° rotation to the right content bbox", () => {
    const outer = { left: 0, top: 0, width: 200, height: 100 };
    // A horizontal screen strip near the top of the rotated view.
    const r = { left: 0, top: 0, right: 100, bottom: 20 };
    // Corners → content: (0,0)→(0,200); (100,0)→(0,100); (100,20)→(20,100);
    // (0,20)→(20,200). Bounding box: x0=0,x1=20,y0=100,y1=200.
    expect(screenRectToContent(r, outer, 100, 200, 90)).toEqual({
      x0: 0,
      y0: 100,
      x1: 20,
      y1: 200,
    });
  });
});
