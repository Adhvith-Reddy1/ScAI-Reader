/**
 * SVG overlay that draws persisted highlights and handles click-to-delete.
 *
 * The layer sits between the rendered page image and the invisible text
 * layer. It owns the SVG element; the caller (PageView) reattaches when
 * annotations change, rather than mutating in place.
 */

import type { Annotation, DocumentMeta } from "../api.ts";
import { getEraseMode } from "../eraseMode.ts";
import { pageBBoxToViewport, type PageGeometry } from "./coords.ts";
import { mergeAdjacentLineRects } from "./selection.ts";
import { bindBlueAnnotation } from "./ExplanationTooltip.ts";
import { bindHighlightActions } from "./HighlightHoverActions.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

const HIGHLIGHT_ALPHA = 0.4;

// Legacy named colors (highlights saved before palettes) keep their original,
// individually-tuned alphas.
const LEGACY_COLOR_RGBA: Record<string, string> = {
  yellow: "rgba(255, 235, 59, 0.42)",
  blue: "rgba(33, 150, 243, 0.32)",
  red: "rgba(244, 67, 54, 0.28)",
  green: "rgba(76, 175, 80, 0.36)",
  pink: "rgba(233, 30, 99, 0.30)",
};

/** Resolve a stored color (legacy name or "#RRGGBB" hex) to an rgba fill. */
function fillFor(color: string): string {
  const legacy = LEGACY_COLOR_RGBA[color];
  if (legacy) return legacy;
  const m = /^#([0-9a-fA-F]{6})$/.exec(color);
  if (m) {
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${HIGHLIGHT_ALPHA})`;
  }
  return color; // already an rgba()/other string
}

/** A highlight is an "explain" highlight via the flag, or (legacy) by blue. */
function isExplainHighlight(ann: Annotation): boolean {
  return ann.explain === true || ann.color === "blue";
}

export function buildAnnotationLayer(
  annotations: Annotation[],
  geom: PageGeometry,
  onDelete: (annotationId: string) => void,
  doc?: DocumentMeta,
): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "annotation-layer");
  svg.setAttribute("width", String(geom.displayWidthPx));
  svg.setAttribute("height", String(geom.displayHeightPx));
  svg.setAttribute("viewBox", `0 0 ${geom.displayWidthPx} ${geom.displayHeightPx}`);

  for (const ann of annotations) {
    const group = document.createElementNS(SVG_NS, "g");
    group.setAttribute("class", "annotation");
    group.setAttribute("data-annotation-id", ann.id);
    group.setAttribute("data-color", ann.color);

    // Merge per-line on render so legacy highlights (saved before this fix
    // landed) still display as clean blocks rather than rows of scraps.
    const merged = mergeAdjacentLineRects(ann.rects);
    for (const rect of merged) {
      const viewport = pageBBoxToViewport(rect, geom);
      const r = document.createElementNS(SVG_NS, "rect");
      r.setAttribute("x", String(viewport.x0));
      r.setAttribute("y", String(viewport.y0));
      r.setAttribute("width", String(Math.max(0, viewport.x1 - viewport.x0)));
      r.setAttribute("height", String(Math.max(0, viewport.y1 - viewport.y0)));
      r.setAttribute("fill", fillFor(ann.color));
      group.appendChild(r);
    }

    group.addEventListener("click", (e) => {
      e.stopPropagation();
      // Erase mode (Edge-style): one click anywhere on the highlight deletes
      // immediately. Outside erase mode, deletion is done via the hover
      // "Delete" button (see bindHighlightActions below).
      if (getEraseMode().active) {
        onDelete(ann.id);
      }
    });
    svg.appendChild(group);

    // Explain highlights get the AI-explanation tooltip, which carries its own
    // bottom-left Delete button. Every cosmetic highlight gets the standalone
    // hover Delete pill anchored at the highlight's bottom-left.
    if (isExplainHighlight(ann) && doc) {
      bindBlueAnnotation(group, doc, ann.id, ann.text ?? null, onDelete);
    } else {
      bindHighlightActions(group, ann.id, onDelete);
    }
  }
  return svg;
}
