import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildAnnotationLayer } from "./AnnotationLayer.ts";
import type { PageGeometry } from "./coords.ts";
import type { Annotation } from "../api.ts";
import {
  setEraseMode,
  _resetForTest as _resetEraseForTest,
} from "../eraseMode.ts";

const geom: PageGeometry = {
  pageWidthPt: 612,
  pageHeightPt: 792,
  displayWidthPx: 900,
  displayHeightPx: 1164.7,
};

function ann(
  id: string,
  color: Annotation["color"],
  rects: Annotation["rects"],
  explain = false,
): Annotation {
  return {
    id,
    page: 1,
    kind: "highlight",
    color,
    rects,
    text: null,
    explain,
    created_at: "2026-06-18T00:00:00Z",
  };
}

describe("buildAnnotationLayer", () => {
  beforeEach(() => {
    _resetEraseForTest();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    _resetEraseForTest();
  });

  it("renders one <g> per annotation, with rects inside", () => {
    const svg = buildAnnotationLayer(
      [
        ann("a1", "yellow", [{ x0: 0, y0: 0, x1: 100, y1: 12 }]),
        ann("a2", "blue", [
          { x0: 0, y0: 30, x1: 100, y1: 42 },
          { x0: 0, y0: 50, x1: 100, y1: 62 },
        ]),
      ],
      geom,
      () => {},
    );
    const groups = svg.querySelectorAll("g.annotation");
    expect(groups.length).toBe(2);
    expect(groups[0].querySelectorAll("rect").length).toBe(1);
    expect(groups[1].querySelectorAll("rect").length).toBe(2);
  });

  it("uses the right fill per color", () => {
    const svg = buildAnnotationLayer(
      [ann("a", "red", [{ x0: 0, y0: 0, x1: 50, y1: 12 }])],
      geom,
      () => {},
    );
    const rect = svg.querySelector("rect") as SVGRectElement;
    expect(rect.getAttribute("fill")).toContain("244, 67, 54");
  });

  it("scales page-space rects to viewport pixels", () => {
    const svg = buildAnnotationLayer(
      [ann("a", "yellow", [{ x0: 0, y0: 0, x1: 612, y1: 792 }])],
      geom,
      () => {},
    );
    const rect = svg.querySelector("rect") as SVGRectElement;
    expect(parseFloat(rect.getAttribute("width")!)).toBeCloseTo(900, 1);
    expect(parseFloat(rect.getAttribute("height")!)).toBeCloseTo(1164.7, 1);
  });

  it("a plain click no longer deletes — deletion moved to the hover button", () => {
    // Outside erase mode, clicking a highlight must NOT delete it; the
    // delete affordance is the hover "Delete" button instead. If the old
    // confirm path were still wired, confirm() would be consulted here.
    vi.stubGlobal("confirm", () => {
      throw new Error("confirm should not be called on a plain click");
    });
    const onDelete = vi.fn();
    const svg = buildAnnotationLayer(
      [ann("the-id", "yellow", [{ x0: 0, y0: 0, x1: 50, y1: 12 }])],
      geom,
      onDelete,
    );
    const g = svg.querySelector("g.annotation") as SVGGElement;
    g.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("in erase mode, clicking deletes immediately without confirm", () => {
    // If we hit the confirm path by accident, this would throw — proves
    // erase mode short-circuits before window.confirm is consulted.
    vi.stubGlobal("confirm", () => {
      throw new Error("confirm should not be called in erase mode");
    });
    setEraseMode({ active: true });
    const onDelete = vi.fn();
    const svg = buildAnnotationLayer(
      [ann("the-id", "yellow", [{ x0: 0, y0: 0, x1: 50, y1: 12 }])],
      geom,
      onDelete,
    );
    const g = svg.querySelector("g.annotation") as SVGGElement;
    g.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onDelete).toHaveBeenCalledWith("the-id");
  });
});
