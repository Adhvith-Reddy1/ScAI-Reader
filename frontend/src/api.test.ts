import { describe, it, expect } from "vitest";
import { flattenPageText, type PageText } from "./api.ts";

function page(columns: PageText["columns"]): PageText {
  return { page_index: 0, page_width_pt: 612, page_height_pt: 792, columns };
}

describe("flattenPageText", () => {
  it("joins run text across columns in order, whitespace-separated", () => {
    const p = page([
      {
        bbox: { x0: 0, y0: 0, x1: 100, y1: 100 },
        runs: [
          { text: "Hello", bbox: { x0: 0, y0: 0, x1: 10, y1: 10 }, font_size: 12 },
          { text: "world.", bbox: { x0: 0, y0: 0, x1: 10, y1: 10 }, font_size: 12 },
        ],
      },
      {
        bbox: { x0: 100, y0: 0, x1: 200, y1: 100 },
        runs: [
          { text: "Second column.", bbox: { x0: 0, y0: 0, x1: 10, y1: 10 }, font_size: 12 },
        ],
      },
    ]);
    expect(flattenPageText(p)).toBe("Hello world. Second column.");
  });

  it("skips empty/whitespace-only runs", () => {
    const p = page([
      {
        bbox: { x0: 0, y0: 0, x1: 100, y1: 100 },
        runs: [
          { text: "  ", bbox: { x0: 0, y0: 0, x1: 10, y1: 10 }, font_size: 12 },
          { text: "Kept", bbox: { x0: 0, y0: 0, x1: 10, y1: 10 }, font_size: 12 },
          { text: "", bbox: { x0: 0, y0: 0, x1: 10, y1: 10 }, font_size: 12 },
        ],
      },
    ]);
    expect(flattenPageText(p)).toBe("Kept");
  });

  it("returns an empty string for a page with no text", () => {
    expect(flattenPageText(page([]))).toBe("");
  });
});
