/**
 * Nav-bar Highlight button + color popover.
 *
 *   click button → popover opens
 *   pick a palette → swatches switch to that palette (persisted)
 *   click a swatch → highlight mode ON in that cosmetic color (persisted default)
 *   click "Explain ✨" → highlight mode ON as an AI "Explain" highlight
 *   click "Off" → highlight mode OFF
 *   click button while ON → quick toggle OFF
 *
 * Cosmetic colors are purely visual; the AI explanation feature is triggered
 * only by the dedicated Explain highlight (see highlightMode `explain`).
 */

import {
  EXPLAIN_COLOR,
  PALETTES,
  loadHighlightPrefs,
  paletteById,
  saveHighlightPrefs,
} from "./palettes.ts";
import {
  getHighlightMode,
  setHighlightMode,
  subscribeHighlightMode,
} from "./highlightMode.ts";

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
    if (getHighlightMode().active) {
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
    button.dataset.explain = String(s.explain);
    button.dataset.color = s.color;
    indicator.style.background = s.explain ? EXPLAIN_COLOR : s.color;
    label.textContent = s.active && s.explain ? "Explain" : "Highlight";
  });

  return root;
}

function buildPopover(onPick: () => void): HTMLDivElement {
  const pop = document.createElement("div");
  pop.className = "hl-popover";
  pop.setAttribute("role", "menu");

  let paletteId = loadHighlightPrefs().paletteId;

  // Palette switcher row.
  const tabs = document.createElement("div");
  tabs.className = "hl-palette-tabs";
  const swatchRow = document.createElement("div");
  swatchRow.className = "hl-swatches";

  const renderSwatches = (): void => {
    swatchRow.replaceChildren();
    for (const color of paletteById(paletteId).colors) {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.className = "swatch";
      sw.setAttribute("aria-label", color);
      sw.setAttribute("data-color", color);
      sw.style.background = color;
      sw.addEventListener("mousedown", (e) => e.preventDefault());
      sw.addEventListener("click", (e) => {
        e.stopPropagation();
        setHighlightMode({ active: true, explain: false, color });
        saveHighlightPrefs({ paletteId, color });
        onPick();
      });
      swatchRow.appendChild(sw);
    }
  };

  const renderTabs = (): void => {
    tabs.replaceChildren();
    for (const p of PALETTES) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "hl-palette-tab";
      tab.textContent = p.name;
      tab.dataset.palette = p.id;
      tab.dataset.selected = String(p.id === paletteId);
      tab.addEventListener("click", (e) => {
        e.stopPropagation();
        paletteId = p.id;
        saveHighlightPrefs({ paletteId, color: loadHighlightPrefs().color });
        renderTabs();
        renderSwatches();
      });
      tabs.appendChild(tab);
    }
  };

  renderTabs();
  renderSwatches();
  pop.append(tabs, swatchRow);

  // Dedicated AI "Explain" highlight.
  const explain = document.createElement("button");
  explain.type = "button";
  explain.className = "hl-explain";
  explain.textContent = "Explain ✨";
  explain.addEventListener("click", (e) => {
    e.stopPropagation();
    setHighlightMode({ active: true, explain: true, color: EXPLAIN_COLOR });
    onPick();
  });
  pop.appendChild(explain);

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
