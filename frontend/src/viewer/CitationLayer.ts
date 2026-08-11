/**
 * SVG overlay drawing each detected in-text citation marker as a blue,
 * underlined, clickable "link" over its position on the page — the
 * superscript or bracketed number the reader can click to see the
 * reference. The rasterized page image beneath still shows the original
 * (black) glyph, so this layer works the same way TextLayer's selectable
 * spans do: an approximately-positioned overlay rather than a pixel edit —
 * good enough to read as "this number is blue" without needing to touch
 * the render pipeline.
 *
 * Unlike FigureLayer (purely decorative, pointer-events: none, hit-tested
 * separately at the page-wrap level) this layer IS the click target: each
 * marker gets its own pointer-events and click/keydown handlers, so no
 * separate bbox hit-testing is needed in PageView. It must be painted
 * (appended) AFTER the text layer in the DOM so its clickable hit-targets
 * aren't shadowed by the text layer's own pointer-events:auto spans.
 *
 * CitationMention only carries a bbox (not the original marker text — see
 * app.pdf.citations), so the label shown is reconstructed from the key(s)
 * that share one bbox (a compound marker like "[3, 7]" produces two
 * mentions at the SAME bbox, one per key) — "3,7" rather than the exact
 * "[3, 7]" source text. Close enough to read as a citation marker; getting
 * the exact original punctuation back isn't worth threading through the
 * mention data model for.
 */

import type { CitationMention } from "../api.ts";
import { pageBBoxToViewport, type PageGeometry } from "./coords.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

export interface CitationMarker {
  keys: string[];
  bbox: CitationMention["bbox"];
}

/** Group a page's mentions by bbox — compound markers share one bbox (one
 * mention per key) and should render/click as a single marker. */
export function groupMentionsByBBox(mentions: CitationMention[]): CitationMarker[] {
  const groups = new Map<string, CitationMarker>();
  for (const m of mentions) {
    const bboxKey = `${m.bbox.x0},${m.bbox.y0},${m.bbox.x1},${m.bbox.y1}`;
    let group = groups.get(bboxKey);
    if (!group) {
      group = { keys: [], bbox: m.bbox };
      groups.set(bboxKey, group);
    }
    group.keys.push(m.key);
  }
  return [...groups.values()];
}

export function buildCitationLayer(
  mentions: CitationMention[],
  geom: PageGeometry,
  onActivate: (keys: string[], target: SVGGElement) => void,
): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "citation-layer");
  svg.setAttribute("width", String(geom.displayWidthPx));
  svg.setAttribute("height", String(geom.displayHeightPx));
  svg.setAttribute("viewBox", `0 0 ${geom.displayWidthPx} ${geom.displayHeightPx}`);

  for (const marker of groupMentionsByBBox(mentions)) {
    const v = pageBBoxToViewport(marker.bbox, geom);
    const width = Math.max(0, v.x1 - v.x0);
    const height = Math.max(0, v.y1 - v.y0);
    if (width === 0 || height === 0) continue;

    const group = document.createElementNS(SVG_NS, "g");
    group.setAttribute("class", "citation-marker");
    group.setAttribute("data-citation-keys", marker.keys.join(","));
    group.setAttribute("tabindex", "0");
    group.setAttribute("role", "button");
    group.setAttribute("aria-label", `Citation ${marker.keys.join(", ")}`);

    // A generous invisible hit-target: superscript markers are tiny, so the
    // clickable area is padded well beyond the visible glyph.
    const padX = Math.max(3, width * 0.6);
    const padY = Math.max(3, height * 0.6);
    const hit = document.createElementNS(SVG_NS, "rect");
    hit.setAttribute("class", "citation-marker-hit");
    hit.setAttribute("x", String(v.x0 - padX));
    hit.setAttribute("y", String(v.y0 - padY));
    hit.setAttribute("width", String(width + padX * 2));
    hit.setAttribute("height", String(height + padY * 2));
    group.appendChild(hit);

    // Visible label — colored + underlined, the recolor-in-place technique
    // TextLayer already uses for selection, just made visible/blue instead
    // of transparent. Baseline sits at the bbox's bottom edge so it lines up
    // with the rasterized glyph it's covering.
    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("class", "citation-marker-text");
    label.setAttribute("x", String(v.x0));
    label.setAttribute("y", String(v.y1));
    label.setAttribute("font-size", String(Math.max(6, height * 1.1)));
    label.textContent = marker.keys.join(",");
    group.appendChild(label);

    const activate = (): void => onActivate(marker.keys, group);
    group.addEventListener("click", (e) => {
      e.stopPropagation();
      activate();
    });
    group.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate();
      }
    });

    svg.appendChild(group);
  }

  return svg;
}
