/**
 * Nav-bar "Explain" button. Makes AI-explanation highlights in any color from
 * the *currently selected palette* (the palette is chosen via the Highlight
 * button's ⋮ menu). Picking a color turns on highlight mode with explain=true;
 * the chosen color persists as the Explain default.
 */

import {
  loadHighlightPrefs,
  paletteById,
  saveHighlightPrefs,
} from "./palettes.ts";
import {
  getHighlightMode,
  setHighlightMode,
  subscribeHighlightMode,
} from "./highlightMode.ts";

export function buildExplainButton(): HTMLElement {
  const root = document.createElement("div");
  root.className = "hl-button-root";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "hl-button explain-button";
  button.setAttribute("aria-label", "Explain");
  button.setAttribute("aria-haspopup", "true");

  const indicator = document.createElement("span");
  indicator.className = "hl-indicator";
  const label = document.createElement("span");
  label.className = "hl-label";
  label.textContent = "Explain";
  button.append(indicator, label);

  const popover = document.createElement("div");
  popover.className = "hl-popover";
  popover.setAttribute("role", "menu");
  popover.hidden = true;

  const swatchRow = document.createElement("div");
  swatchRow.className = "hl-swatches";
  const off = document.createElement("button");
  off.type = "button";
  off.className = "hl-off";
  off.textContent = "Off";
  off.addEventListener("click", (e) => {
    e.stopPropagation();
    setHighlightMode({ active: false });
    popover.hidden = true;
  });
  popover.append(swatchRow, off);
  root.append(button, popover);

  const renderSwatches = (): void => {
    swatchRow.replaceChildren();
    for (const color of paletteById(loadHighlightPrefs().paletteId).colors) {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.className = "swatch";
      sw.setAttribute("aria-label", color);
      sw.dataset.color = color;
      sw.style.background = color;
      sw.addEventListener("mousedown", (e) => e.preventDefault());
      sw.addEventListener("click", (e) => {
        e.stopPropagation();
        setHighlightMode({ active: true, explain: true, color });
        saveHighlightPrefs({ explainColor: color });
        popover.hidden = true;
      });
      swatchRow.appendChild(sw);
    }
  };

  button.addEventListener("click", (e) => {
    e.stopPropagation();
    const m = getHighlightMode();
    if (m.active && m.explain) {
      setHighlightMode({ active: false });
      popover.hidden = true;
    } else {
      renderSwatches(); // re-read current palette before showing
      popover.hidden = !popover.hidden;
    }
  });

  document.addEventListener("click", (e) => {
    if (!root.contains(e.target as Node)) popover.hidden = true;
  });

  subscribeHighlightMode((s) => {
    const isExplain = s.active && s.explain;
    button.dataset.active = String(isExplain);
    indicator.style.background = isExplain
      ? s.color
      : loadHighlightPrefs().explainColor;
  });

  return root;
}
