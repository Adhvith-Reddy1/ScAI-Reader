/**
 * Clickable overlay for in-text citation markers.
 *
 * One transparent `<button>` per detected marker, positioned over the bracket
 * in the rasterized page. The brackets are already legible in the page image;
 * this layer just makes them clickable (a subtle hover tint signals it). On
 * click we open the citation card with the marker's reference number(s).
 *
 * The layer sits above the text layer so clicks land on markers, but it only
 * covers the small bracket hotspots, leaving the rest of the page selectable.
 */

import type { CitationMarker } from "../api.ts";
import { pageBBoxToViewport, type PageGeometry } from "./coords.ts";
import { showCitationCard } from "./CitationCard.ts";

export function buildCitationLayer(
  docId: string,
  markers: CitationMarker[],
  geom: PageGeometry,
): HTMLDivElement {
  const root = document.createElement("div");
  root.className = "citation-layer";
  root.style.width = `${geom.displayWidthPx}px`;
  root.style.height = `${geom.displayHeightPx}px`;

  for (const marker of markers) {
    const v = pageBBoxToViewport(marker.bbox, geom);
    const hot = document.createElement("button");
    hot.type = "button";
    hot.className = "citation-marker";
    hot.style.left = `${v.x0}px`;
    hot.style.top = `${v.y0}px`;
    hot.style.width = `${Math.max(1, v.x1 - v.x0)}px`;
    hot.style.height = `${Math.max(1, v.y1 - v.y0)}px`;
    hot.setAttribute(
      "aria-label",
      `Citation ${marker.raw} — show reference details`,
    );

    hot.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showCitationCard(docId, marker, hot.getBoundingClientRect());
    });

    root.appendChild(hot);
  }
  return root;
}
