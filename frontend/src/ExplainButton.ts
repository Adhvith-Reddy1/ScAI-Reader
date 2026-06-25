/**
 * Nav-bar "Explain" button + color popover — a separate tool from Highlight.
 *
 *   click button →  popover opens with 5 swatches + "Off"
 *   click swatch →  explain mode ON with that color; drags now create AI
 *                   explanation highlights in that color
 *   click "Off" / button while ON → explain mode OFF
 *
 * Mirrors HighlightButton, but drives explainMode. The button reflects state
 * via `data-active` / `data-color` for styling.
 */

import { HIGHLIGHT_COLORS, type HighlightColor } from "./api.ts";
import {
  getExplainMode,
  setExplainMode,
  subscribeExplainMode,
} from "./explainMode.ts";

const SWATCH_FILL: Record<HighlightColor, string> = {
  yellow: "#FFEB3B",
  blue: "#2196F3",
  red: "#F44336",
  green: "#4CAF50",
  pink: "#E91E63",
};

export function buildExplainButton(): HTMLElement {
  const root = document.createElement("div");
  root.className = "explain-button-root";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "explain-button";
  button.setAttribute("aria-label", "Explain");
  button.setAttribute("aria-haspopup", "true");

  const indicator = document.createElement("span");
  indicator.className = "explain-indicator";
  const label = document.createElement("span");
  label.className = "explain-label";
  label.textContent = "Explain";
  button.append(indicator, label);

  const popover = buildPopover(() => {
    popover.hidden = true;
  });
  popover.hidden = true;
  root.append(button, popover);

  button.addEventListener("click", (e) => {
    e.stopPropagation();
    if (getExplainMode().active) {
      setExplainMode({ active: false });
      popover.hidden = true;
    } else {
      popover.hidden = !popover.hidden;
    }
  });

  document.addEventListener("click", (e) => {
    if (!root.contains(e.target as Node)) popover.hidden = true;
  });

  subscribeExplainMode((s) => {
    button.dataset.active = String(s.active);
    button.dataset.color = s.color;
    indicator.style.background = SWATCH_FILL[s.color];
  });

  return root;
}

function buildPopover(onPick: () => void): HTMLDivElement {
  const pop = document.createElement("div");
  pop.className = "explain-popover";
  pop.setAttribute("role", "menu");

  const hint = document.createElement("div");
  hint.className = "explain-popover-hint";
  hint.textContent = "Highlight color for AI explanations";
  pop.appendChild(hint);

  const swatches = document.createElement("div");
  swatches.className = "explain-popover-swatches";
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
      setExplainMode({ active: true, color });
      onPick();
    });
    swatches.appendChild(sw);
  }
  pop.appendChild(swatches);

  const off = document.createElement("button");
  off.type = "button";
  off.className = "explain-off";
  off.textContent = "Off";
  off.addEventListener("click", (e) => {
    e.stopPropagation();
    setExplainMode({ active: false });
    onPick();
  });
  pop.appendChild(off);

  return pop;
}
