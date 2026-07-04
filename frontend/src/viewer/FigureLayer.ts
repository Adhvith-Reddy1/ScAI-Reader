/**
 * SVG overlay drawing a thin outline over every detected figure/table region
 * on a page — the visible proof that figure detection found (or didn't find)
 * something, and the affordance that tells the reader "double-click here".
 *
 * Purely decorative: `pointer-events: none` throughout, so it never competes
 * with text selection or the wrap-level dblclick hit-test in PageView (which
 * hit-tests the same PageFigure bboxes independently). If the detector is
 * wrong — missing a figure, or drawing a box in the wrong place — this layer
 * makes that immediately visible instead of a silent no-op on double-click.
 */

import type { PageFigure } from "../api.ts";
import { pageBBoxToViewport, type PageGeometry } from "./coords.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

export function buildFigureLayer(
  figures: PageFigure[],
  geom: PageGeometry,
): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "figure-layer");
  svg.setAttribute("width", String(geom.displayWidthPx));
  svg.setAttribute("height", String(geom.displayHeightPx));
  svg.setAttribute(
    "viewBox",
    `0 0 ${geom.displayWidthPx} ${geom.displayHeightPx}`,
  );

  for (const fig of figures) {
    const v = pageBBoxToViewport(fig.bbox, geom);
    const width = Math.max(0, v.x1 - v.x0);
    const height = Math.max(0, v.y1 - v.y0);
    if (width === 0 || height === 0) continue;

    const group = document.createElementNS(SVG_NS, "g");
    group.setAttribute("class", "figure-region");
    group.setAttribute("data-figure-id", fig.figure_id);

    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", String(v.x0));
    rect.setAttribute("y", String(v.y0));
    rect.setAttribute("width", String(width));
    rect.setAttribute("height", String(height));
    rect.setAttribute("rx", "3");
    group.appendChild(rect);

    // Label chip inset in the box's top-left corner — lets you confirm at a
    // glance which caption a box was matched to, not just that a box exists.
    // Inset rather than pinned above the box: the detected region's top edge
    // sits exactly where the preceding text ends (by construction, see
    // detect_figures' MIN_FIGURE_GAP_PT), often with near-zero margin, so a
    // chip floating above it would frequently overlap that text instead.
    const chipText = fig.label;
    const chipPadX = 5;
    const chipHeight = 15;
    const chipWidth = 6.2 * chipText.length + chipPadX * 2;
    const chip = document.createElementNS(SVG_NS, "g");
    chip.setAttribute("class", "figure-region-chip");
    const chipInset = 3;
    chip.setAttribute(
      "transform",
      `translate(${v.x0 + chipInset}, ${v.y0 + chipInset})`,
    );
    const chipBg = document.createElementNS(SVG_NS, "rect");
    chipBg.setAttribute("width", String(chipWidth));
    chipBg.setAttribute("height", String(chipHeight));
    chipBg.setAttribute("rx", "3");
    chip.appendChild(chipBg);
    const chipLabel = document.createElementNS(SVG_NS, "text");
    chipLabel.setAttribute("x", String(chipPadX));
    chipLabel.setAttribute("y", "11");
    chipLabel.textContent = chipText;
    chip.appendChild(chipLabel);
    group.appendChild(chip);

    svg.appendChild(group);
  }

  return svg;
}
