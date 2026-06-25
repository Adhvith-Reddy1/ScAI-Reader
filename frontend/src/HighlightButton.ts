/**
 * Nav-bar Highlight control — Edge-style split button:
 *
 *   click the main button  →  toggle highlight mode on/off using the CURRENT
 *                             color (no need to re-pick a color each time)
 *   click the caret (▾)    →  open a small popover of color swatches
 *   click a swatch         →  set that color and turn highlighting on
 *
 * The main button reflects state via `data-active` / `data-color`, which the
 * stylesheet uses for the active treatment and the color indicator.
 */

import { HIGHLIGHT_COLORS, type HighlightColor } from "./api.ts";
import {
  getHighlightMode,
  setHighlightMode,
  toggleHighlightMode,
  subscribeHighlightMode,
} from "./highlightMode.ts";

const SWATCH_FILL: Record<HighlightColor, string> = {
  yellow: "#FFEB3B",
  blue: "#2196F3",
  red: "#F44336",
  green: "#4CAF50",
  pink: "#E91E63",
};

export function buildHighlightButton(): HTMLElement {
  const root = document.createElement("div");
  root.className = "hl-button-root";

  const group = document.createElement("div");
  group.className = "hl-button-group";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "hl-button";
  button.setAttribute("aria-label", "Highlight");

  const indicator = document.createElement("span");
  indicator.className = "hl-indicator";
  const label = document.createElement("span");
  label.className = "hl-label";
  label.textContent = "Highlight";
  button.append(indicator, label);

  const caret = document.createElement("button");
  caret.type = "button";
  caret.className = "hl-caret";
  caret.setAttribute("aria-label", "Choose highlight color");
  caret.setAttribute("aria-haspopup", "true");
  caret.textContent = "▾";

  group.append(button, caret);

  const popover = buildPopover(() => {
    popover.hidden = true;
  });
  popover.hidden = true;
  root.append(group, popover);

  // Main button: toggle highlighting with whatever color is current.
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleHighlightMode();
    popover.hidden = true;
  });

  // Caret: reveal/hide the color choices.
  caret.addEventListener("click", (e) => {
    e.stopPropagation();
    popover.hidden = !popover.hidden;
  });

  document.addEventListener("click", (e) => {
    if (!root.contains(e.target as Node)) popover.hidden = true;
  });

  subscribeHighlightMode((s) => {
    button.dataset.active = String(s.active);
    button.dataset.color = s.color;
    group.dataset.active = String(s.active);
    indicator.style.background = SWATCH_FILL[s.color];
  });
  // Seed initial visuals.
  const init = getHighlightMode();
  indicator.style.background = SWATCH_FILL[init.color];

  return root;
}

function buildPopover(onPick: () => void): HTMLDivElement {
  const pop = document.createElement("div");
  pop.className = "hl-popover";
  pop.setAttribute("role", "menu");

  for (const color of HIGHLIGHT_COLORS) {
    const sw = document.createElement("button");
    sw.type = "button";
    sw.className = "swatch";
    sw.setAttribute("aria-label", color);
    sw.setAttribute("data-color", color);
    sw.style.background = SWATCH_FILL[color];
    sw.addEventListener("mousedown", (e) => e.preventDefault());
    sw.addEventListener("click", (e) => {
      e.stopPropagation();
      // Picking a color also turns highlighting on (Edge behavior).
      setHighlightMode({ active: true, color });
      onPick();
    });
    pop.appendChild(sw);
  }

  return pop;
}
