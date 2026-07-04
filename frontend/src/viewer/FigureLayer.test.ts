import { describe, it, expect } from "vitest";
import { buildFigureLayer } from "./FigureLayer.ts";
import type { PageGeometry } from "./coords.ts";
import type { PageFigure } from "../api.ts";

const geom: PageGeometry = {
  pageWidthPt: 612,
  pageHeightPt: 792,
  displayWidthPx: 900,
  displayHeightPx: 1164.7,
};

function fig(id: string, label: string, bbox: PageFigure["bbox"]): PageFigure {
  return {
    figure_id: id,
    label,
    page: 1,
    bbox,
    caption_bbox: { x0: bbox.x0, y0: bbox.y1, x1: bbox.x1, y1: bbox.y1 + 10 },
  };
}

describe("buildFigureLayer", () => {
  it("renders one <g class='figure-region'> per detected figure", () => {
    const svg = buildFigureLayer(
      [
        fig("p0_Figure_1", "Figure 1", { x0: 40, y0: 100, x1: 290, y1: 300 }),
        fig("p0_Table_1", "Table 1", { x0: 40, y0: 400, x1: 290, y1: 500 }),
      ],
      geom,
    );
    const groups = svg.querySelectorAll("g.figure-region");
    expect(groups.length).toBe(2);
  });

  it("tags each group with its figure_id for hover lookups", () => {
    const svg = buildFigureLayer(
      [fig("p3_Figure_2", "Figure 2", { x0: 40, y0: 100, x1: 290, y1: 300 })],
      geom,
    );
    const group = svg.querySelector("g.figure-region")!;
    expect(group.getAttribute("data-figure-id")).toBe("p3_Figure_2");
  });

  it("scales the page-space bbox into viewport pixels", () => {
    const svg = buildFigureLayer(
      [fig("p0_Figure_1", "Figure 1", { x0: 0, y0: 0, x1: 612, y1: 792 })],
      geom,
    );
    const rect = svg.querySelector("g.figure-region > rect") as SVGRectElement;
    expect(parseFloat(rect.getAttribute("width")!)).toBeCloseTo(900, 1);
    expect(parseFloat(rect.getAttribute("height")!)).toBeCloseTo(1164.7, 1);
    expect(parseFloat(rect.getAttribute("x")!)).toBeCloseTo(0, 1);
    expect(parseFloat(rect.getAttribute("y")!)).toBeCloseTo(0, 1);
  });

  it("draws a label chip carrying the figure's caption label", () => {
    const svg = buildFigureLayer(
      [fig("p0_Figure_7", "Figure 7", { x0: 40, y0: 100, x1: 290, y1: 300 })],
      geom,
    );
    const chip = svg.querySelector(".figure-region-chip text");
    expect(chip?.textContent).toBe("Figure 7");
  });

  it("renders an empty (but valid) layer when nothing was detected", () => {
    const svg = buildFigureLayer([], geom);
    expect(svg.querySelectorAll("g.figure-region").length).toBe(0);
    expect(svg.getAttribute("width")).toBe("900");
  });

  it("skips a degenerate zero-area bbox rather than drawing an invisible box", () => {
    const svg = buildFigureLayer(
      [fig("p0_Figure_1", "Figure 1", { x0: 40, y0: 100, x1: 40, y1: 300 })],
      geom,
    );
    expect(svg.querySelectorAll("g.figure-region").length).toBe(0);
  });
});
