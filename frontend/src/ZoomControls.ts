/**
 * Toolbar widget: [−]  [100%]  [+]
 *
 * Edge-style: minus/plus step along the zoom ladder; clicking the percentage
 * label resets to 100%. State lives in [[zoom]].
 */

import {
  resetZoomAtViewerCenter,
  zoomInAtViewerCenter,
  zoomOutAtViewerCenter,
} from "./viewerZoom.ts";
import { getZoom, subscribeZoom } from "./zoom.ts";

export function buildZoomControls(): HTMLElement {
  const root = document.createElement("div");
  root.className = "zoom-controls";

  const minus = document.createElement("button");
  minus.type = "button";
  minus.className = "zoom-btn";
  minus.textContent = "−";
  minus.title = "Zoom out (Ctrl/Cmd −)";
  minus.setAttribute("aria-label", "Zoom out");
  minus.addEventListener("click", () => zoomOutAtViewerCenter());

  const label = document.createElement("button");
  label.type = "button";
  label.className = "zoom-label";
  label.title = "Reset zoom (Ctrl/Cmd 0)";
  label.setAttribute("aria-label", "Reset zoom");
  label.addEventListener("click", () => resetZoomAtViewerCenter());

  const plus = document.createElement("button");
  plus.type = "button";
  plus.className = "zoom-btn";
  plus.textContent = "+";
  plus.title = "Zoom in (Ctrl/Cmd +)";
  plus.setAttribute("aria-label", "Zoom in");
  plus.addEventListener("click", () => zoomInAtViewerCenter());

  root.append(minus, label, plus);

  const render = (z: number) => {
    label.textContent = `${Math.round(z * 100)}%`;
  };
  render(getZoom());
  subscribeZoom(render);

  return root;
}
