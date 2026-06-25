/**
 * Nav-bar "Explain" control — a separate tool from Highlight, same Edge-style
 * split-button logic:
 *
 *   click the main button  →  toggle explain mode on/off using the CURRENT
 *                             color (drags then create AI explanation highlights
 *                             in that color)
 *   click the caret (▾)    →  open a small popover of color swatches
 *   click a swatch         →  set that color and turn explain mode on
 */

import { HIGHLIGHT_COLORS, type HighlightColor } from "./api.ts";
import {
  getExplainMode,
  setExplainMode,
  toggleExplainMode,
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

  const group = document.createElement("div");
  group.className = "explain-button-group";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "explain-button";
  button.setAttribute("aria-label", "Explain");

  // Sparkle (AI) icon tinted to the current color — signals "the AI tool" and
  // shows the chosen explanation-highlight color at once.
  const indicator = document.createElement("span");
  indicator.className = "explain-icon";
  indicator.innerHTML =
    '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">' +
    '<path fill="currentColor" d="M12 2l1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9z"/>' +
    '</svg>';
  const label = document.createElement("span");
  label.className = "explain-label";
  label.textContent = "Explain";
  button.append(indicator, label);

  const caret = document.createElement("button");
  caret.type = "button";
  caret.className = "explain-caret";
  caret.setAttribute("aria-label", "Choose explanation color");
  caret.setAttribute("aria-haspopup", "true");
  caret.textContent = "▾";

  group.append(button, caret);

  const popover = buildPopover(() => {
    popover.hidden = true;
  });
  popover.hidden = true;
  root.append(group, popover);

  button.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleExplainMode();
    popover.hidden = true;
  });

  caret.addEventListener("click", (e) => {
    e.stopPropagation();
    popover.hidden = !popover.hidden;
  });

  document.addEventListener("click", (e) => {
    if (!root.contains(e.target as Node)) popover.hidden = true;
  });

  subscribeExplainMode((s) => {
    button.dataset.active = String(s.active);
    button.dataset.color = s.color;
    group.dataset.active = String(s.active);
    indicator.style.color = SWATCH_FILL[s.color];
  });
  const init = getExplainMode();
  indicator.style.color = SWATCH_FILL[init.color];

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

  return pop;
}
