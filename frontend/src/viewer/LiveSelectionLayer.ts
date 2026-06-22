/**
 * Custom rendering of the live (in-progress) selection.
 *
 * Why: our text layer's `<span class="text-run">` elements are absolutely
 * positioned word- or fragment-sized boxes. The browser's default `::selection`
 * paints once per fragment, so a selected line shows a row of tiny rectangles
 * with hairline gaps between them — visibly worse than what Mac Preview and
 * Adobe render. We hide the native paint (transparent `::selection`) and draw
 * our own SVG overlay: one merged rectangle per visual line.
 *
 * `Range.getClientRects()` returns one DOMRect per inline box in the range,
 * which for our layout is one per selected span. We bucket those by `top` to
 * recover the line structure, then union the per-line bucket into a single
 * rectangle. Output is identical to Mac Preview's per-line highlight.
 *
 * The layer is positioned absolutely under the text layer so the user's mouse
 * events still flow to `.text-column`. We listen to `selectionchange` once at
 * the document level and dispatch to every registered page wrap.
 */

import { getRotation } from "../rotation.ts";

const NS = "http://www.w3.org/2000/svg";

const SELECTION_FILL = "rgba(79, 140, 255, 0.4)";
const LINE_BUCKET_TOL_PX = 3;

interface Registration {
  wrap: HTMLElement;
  svg: SVGSVGElement;
}

const registrations = new Set<Registration>();
let listenerInstalled = false;

export interface LineRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function buildLiveSelectionLayer(): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg") as SVGSVGElement;
  svg.setAttribute("class", "live-selection-layer");
  return svg;
}

export function registerLiveSelection(
  wrap: HTMLElement,
  svg: SVGSVGElement,
): void {
  const reg = { wrap, svg };
  registrations.add(reg);
  if (!listenerInstalled) {
    document.addEventListener("selectionchange", onSelectionChange);
    listenerInstalled = true;
  }
}

export function _resetForTest(): void {
  registrations.clear();
}

function onSelectionChange(): void {
  for (const reg of registrations) {
    if (!reg.wrap.isConnected) continue;
    updateLiveSelectionLayer(reg.svg, reg.wrap);
  }
}

export function updateLiveSelectionLayer(
  svg: SVGSVGElement,
  wrap: HTMLElement,
): void {
  clearSvg(svg);
  // When the page is rotated, getClientRects() comes back in the rotated frame
  // and our per-line merge math no longer holds. Fall back to the browser's
  // native ::selection paint (re-enabled via CSS) instead of drawing wrong rects.
  if (getRotation() !== 0) return;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
  if (!sel.anchorNode || !wrap.contains(sel.anchorNode)) return;
  const range = sel.getRangeAt(0);
  if (!wrap.contains(range.startContainer) || !wrap.contains(range.endContainer)) {
    return;
  }

  const containerRect = wrap.getBoundingClientRect();
  const clientRects = Array.from(range.getClientRects());
  const lineRects = groupAndMergeByLine(clientRects, containerRect);

  for (const r of lineRects) {
    const rect = document.createElementNS(NS, "rect");
    rect.setAttribute("x", String(r.x0));
    rect.setAttribute("y", String(r.y0));
    rect.setAttribute("width", String(Math.max(0, r.x1 - r.x0)));
    rect.setAttribute("height", String(Math.max(0, r.y1 - r.y0)));
    rect.setAttribute("fill", SELECTION_FILL);
    svg.appendChild(rect);
  }
}

function clearSvg(svg: SVGSVGElement): void {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
}

export function groupAndMergeByLine(
  rects: DOMRect[],
  containerRect: { left: number; top: number },
): LineRect[] {
  const eligible = rects
    .filter((r) => r.width > 0 && r.height > 0)
    .sort((a, b) => a.top - b.top || a.left - b.left);
  if (eligible.length === 0) return [];

  const lines: DOMRect[][] = [];
  for (const r of eligible) {
    const tail = lines[lines.length - 1];
    if (tail && Math.abs(r.top - tail[0].top) < LINE_BUCKET_TOL_PX) {
      tail.push(r);
    } else {
      lines.push([r]);
    }
  }

  return lines.map((line) => {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const r of line) {
      if (r.left < x0) x0 = r.left;
      if (r.top < y0) y0 = r.top;
      if (r.right > x1) x1 = r.right;
      if (r.bottom > y1) y1 = r.bottom;
    }
    return {
      x0: x0 - containerRect.left,
      y0: y0 - containerRect.top,
      x1: x1 - containerRect.left,
      y1: y1 - containerRect.top,
    };
  });
}
