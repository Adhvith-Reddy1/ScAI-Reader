import { describe, it, expect } from "vitest";
import { buildTextLayer } from "./TextLayer.ts";
import type { PageText } from "../api.ts";
import type { PageGeometry } from "./coords.ts";

const geom: PageGeometry = {
  pageWidthPt: 612,
  pageHeightPt: 792,
  displayWidthPx: 900,
  displayHeightPx: 1164.7,
};

function fakeText(): PageText {
  return {
    page_index: 0,
    page_width_pt: 612,
    page_height_pt: 792,
    columns: [
      {
        bbox: { x0: 72, y0: 100, x1: 260, y1: 180 },
        runs: [
          { text: "Left A", bbox: { x0: 72, y0: 100, x1: 130, y1: 112 }, font_size: 10 },
          { text: "Left B", bbox: { x0: 72, y0: 120, x1: 130, y1: 132 }, font_size: 10 },
        ],
      },
      {
        bbox: { x0: 320, y0: 100, x1: 540, y1: 180 },
        runs: [
          { text: "Right A", bbox: { x0: 320, y0: 100, x1: 380, y1: 112 }, font_size: 10 },
        ],
      },
    ],
  };
}

describe("buildTextLayer", () => {
  it("creates one .text-column per detected column", () => {
    const root = buildTextLayer(fakeText(), geom);
    const cols = root.querySelectorAll(".text-column");
    expect(cols.length).toBe(2);
  });

  it("creates one .text-run span per run with correct text", () => {
    const root = buildTextLayer(fakeText(), geom);
    const runs = root.querySelectorAll(".text-run");
    const texts = Array.from(runs).map((n) => n.textContent);
    expect(texts).toEqual(["Left A", "Left B", "Right A"]);
  });

  it("places runs in the correct column (no cross-bleed in DOM)", () => {
    const root = buildTextLayer(fakeText(), geom);
    const cols = root.querySelectorAll(".text-column");
    const leftRuns = Array.from(cols[0].querySelectorAll(".text-run")).map(
      (n) => n.textContent,
    );
    const rightRuns = Array.from(cols[1].querySelectorAll(".text-run")).map(
      (n) => n.textContent,
    );
    expect(leftRuns).toEqual(["Left A", "Left B"]);
    expect(rightRuns).toEqual(["Right A"]);
    expect(leftRuns).not.toContain("Right A");
  });

  it("sizes the text-layer root to displayed pixel dimensions", () => {
    const root = buildTextLayer(fakeText(), geom);
    expect(root.style.width).toBe("900px");
    expect(root.style.height).toBe("1164.7px");
  });

  it("scales column position from page-space to viewport-space", () => {
    const root = buildTextLayer(fakeText(), geom);
    const firstCol = root.querySelector(".text-column") as HTMLDivElement;
    // page x0=72, displayWidthPx/pageWidthPt = 900/612 ≈ 1.4706
    // expected left ≈ 72 * 1.4706 ≈ 105.88
    expect(parseFloat(firstCol.style.left)).toBeCloseTo(72 * (900 / 612), 1);
  });
});
