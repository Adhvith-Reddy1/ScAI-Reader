import type { PageColumn, PageText } from "../api.ts";
import { pageBBoxToViewport, type PageGeometry } from "./coords.ts";

/**
 * Build the invisible, selectable text overlay for one page.
 *
 * One `<div class="text-column">` per detected column → browser-native
 * selection's DOM-order traversal stays inside a single column, which kills
 * the column-bleed bug that vanilla PDF.js suffers from.
 *
 * Each text run becomes a transparent `<span>` whose position and size match
 * the rasterized glyphs underneath it, so selection visually tracks the page.
 */
export function buildTextLayer(text: PageText, geom: PageGeometry): HTMLDivElement {
  const root = document.createElement("div");
  root.className = "text-layer";
  root.style.width = `${geom.displayWidthPx}px`;
  root.style.height = `${geom.displayHeightPx}px`;

  for (const col of text.columns) {
    root.appendChild(buildColumn(col, geom));
  }
  return root;
}

function buildColumn(col: PageColumn, geom: PageGeometry): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "text-column";

  const colBox = pageBBoxToViewport(col.bbox, geom);
  div.style.left = `${colBox.x0}px`;
  div.style.top = `${colBox.y0}px`;
  div.style.width = `${colBox.x1 - colBox.x0}px`;
  div.style.height = `${colBox.y1 - colBox.y0}px`;

  for (const run of col.runs) {
    const runBox = pageBBoxToViewport(run.bbox, geom);
    const span = document.createElement("span");
    span.className = "text-run";
    // Position relative to the column container.
    span.style.left = `${runBox.x0 - colBox.x0}px`;
    span.style.top = `${runBox.y0 - colBox.y0}px`;
    span.style.width = `${runBox.x1 - runBox.x0}px`;
    span.style.height = `${runBox.y1 - runBox.y0}px`;
    // Font sizing — we want the glyph metrics to roughly match the rasterized
    // image so selection rectangles line up visually. font-size in CSS pixels
    // = font_size in PDF points * scale.
    const fontSizePx = run.font_size * (geom.displayWidthPx / geom.pageWidthPt);
    span.style.fontSize = `${fontSizePx}px`;
    span.textContent = run.text;
    div.appendChild(span);
  }
  return div;
}
