/**
 * Nav-bar Highlight button + color popover. Edge-style behavior:
 *
 *   click button →  popover opens with 5 swatches + "Off"
 *   click swatch →  highlight mode ON with that color; button shows the color
 *   click "Off"  →  highlight mode OFF
 *   click button while ON → also turns OFF (quick toggle)
 *
 * The button reflects current state via `data-active` and `data-color`,
 * which the stylesheet uses for the active visual treatment.
 */

import {
  HIGHLIGHT_COLORS,
  type HighlightColor,
} from "./api.ts";
import {
  getHighlightMode,
  setHighlightMode,
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

  const button = document.createElement("button");
  button.type = "button";
  button.className = "hl-button";
  button.setAttribute("aria-label", "Highlight");
  button.setAttribute("aria-haspopup", "true");

  const indicator = document.createElement("span");
  indicator.className = "hl-indicator";
  const label = document.createElement("span");
  label.className = "hl-label";
  label.textContent = "Highlight";
  button.append(indicator, label);

  const popover = buildPopover(() => {
    popover.hidden = true;
  });
  popover.hidden = true;
  root.append(button, popover);

  button.addEventListener("click", (e) => {
    e.stopPropagation();
    const state = getHighlightMode();
    if (state.active) {
      // Quick toggle off
      setHighlightMode({ active: false });
      popover.hidden = true;
    } else {
      popover.hidden = !popover.hidden;
    }
  });

  document.addEventListener("click", (e) => {
    if (!root.contains(e.target as Node)) popover.hidden = true;
  });

  subscribeHighlightMode((s) => {
    button.dataset.active = String(s.active);
    button.dataset.color = s.color;
    indicator.style.background = SWATCH_FILL[s.color];
  });

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
      setHighlightMode({ active: true, color });
      onPick();
    });
    pop.appendChild(sw);
  }

  const off = document.createElement("button");
  off.type = "button";
  off.className = "hl-off";
  off.textContent = "Off";
  off.addEventListener("click", (e) => {
    e.stopPropagation();
    setHighlightMode({ active: false });
    onPick();
  });
  pop.appendChild(off);

  return pop;
}
