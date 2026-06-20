import { describe, it, expect, beforeEach } from "vitest";
import { groupAndMergeByLine, _resetForTest } from "./LiveSelectionLayer.ts";

function rect(left: number, top: number, right: number, bottom: number): DOMRect {
  return new DOMRect(left, top, right - left, bottom - top);
}

const container = { left: 100, top: 200 };

describe("groupAndMergeByLine", () => {
  beforeEach(() => _resetForTest());

  it("returns empty when no rects", () => {
    expect(groupAndMergeByLine([], container)).toEqual([]);
  });

  it("merges rects with same top into one line rect", () => {
    const r1 = rect(110, 210, 200, 230);
    const r2 = rect(200, 210, 280, 230); // touching to right
    const r3 = rect(285, 210, 350, 230); // small gap to right
    const merged = groupAndMergeByLine([r1, r2, r3], container);
    expect(merged.length).toBe(1);
    expect(merged[0].x0).toBe(10);
    expect(merged[0].x1).toBe(250);
    expect(merged[0].y0).toBe(10);
    expect(merged[0].y1).toBe(30);
  });

  it("separates rects with different tops into different lines", () => {
    const r1 = rect(110, 210, 200, 230);
    const r2 = rect(110, 240, 200, 260);
    const merged = groupAndMergeByLine([r1, r2], container);
    expect(merged.length).toBe(2);
    expect(merged[0].y0).toBe(10);
    expect(merged[1].y0).toBe(40);
  });

  it("groups rects within 3px tolerance as same line", () => {
    const r1 = rect(110, 210, 200, 230);
    const r2 = rect(220, 211.5, 280, 231.5); // 1.5px off top — same line
    const merged = groupAndMergeByLine([r1, r2], container);
    expect(merged.length).toBe(1);
  });

  it("filters zero-size rects", () => {
    const r1 = rect(110, 210, 110, 210);
    const r2 = rect(110, 210, 200, 230);
    const merged = groupAndMergeByLine([r1, r2], container);
    expect(merged.length).toBe(1);
    expect(merged[0].x1).toBe(100); // r2's right - container.left = 200-100 = 100
  });

  it("subtracts container origin from coordinates", () => {
    const r1 = rect(150, 250, 200, 270);
    const merged = groupAndMergeByLine([r1], { left: 100, top: 200 });
    expect(merged[0].x0).toBe(50);
    expect(merged[0].y0).toBe(50);
  });

  it("handles many rects across multiple lines correctly", () => {
    // Three lines of three spans each
    const rects: DOMRect[] = [];
    for (let line = 0; line < 3; line++) {
      const y = 200 + line * 30;
      for (let col = 0; col < 3; col++) {
        const x = 100 + col * 60;
        rects.push(rect(x, y, x + 55, y + 20));
      }
    }
    const merged = groupAndMergeByLine(rects, container);
    expect(merged.length).toBe(3);
    // each merged line spans x=0 to x=175 (relative to container.left=100)
    for (const m of merged) {
      expect(m.x0).toBe(0);
      expect(m.x1).toBe(175);
    }
  });
});
