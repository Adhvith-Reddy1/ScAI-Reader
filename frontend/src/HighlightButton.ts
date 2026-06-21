/**
 * Nav-bar Highlight button + color popover (cosmetic highlights only).
 *
 *   click button → popover with the current palette's swatches + "Off"
 *   ⋮ (far left) → palette menu pops up; pick one to switch palettes
 *   click a swatch → highlight mode ON in that color (persisted default)
 *   "Off" / click button while ON → highlight mode OFF
 *
 * The AI explanation feature lives on a separate Explain button — this button
 * only makes cosmetic highlights (explain = false).
 */

import {
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

  const { popover, refresh } = buildPopover(() => {
    popover.hidden = true;
  });
  popover.hidden = true;
  root.append(button, popover);

  button.addEventListener("click", (e) => {
    e.stopPropagation();
    if (getHighlightMode().active && !getHighlightMode().explain) {
      setHighlightMode({ active: false });
      popover.hidden = true;
    } else {
      refresh(); // re-read the current palette before showing
      popover.hidden = !popover.hidden;
    }
  });

  document.addEventListener("click", (e) => {
    if (!root.contains(e.target as Node)) popover.hidden = true;
  });

  subscribeHighlightMode((s) => {
    const isCosmetic = s.active && !s.explain;
    button.dataset.active = String(isCosmetic);
    button.dataset.color = s.color;
    if (isCosmetic) indicator.style.background = s.color;
  });

  return root;
}

function buildPopover(onPick: () => void): {
  popover: HTMLDivElement;
  refresh: () => void;
} {
  const pop = document.createElement("div");
  pop.className = "hl-popover";
  pop.setAttribute("role", "menu");

  // ⋮ palette menu (far left).
  const menuWrap = document.createElement("div");
  menuWrap.className = "hl-palette-menu-wrap";
  const menuBtn = document.createElement("button");
  menuBtn.type = "button";
  menuBtn.className = "hl-palette-menu";
  menuBtn.setAttribute("aria-label", "Choose palette");
  menuBtn.textContent = "⋮";
  const dropdown = document.createElement("div");
  dropdown.className = "hl-palette-dropdown";
  dropdown.hidden = true;
  menuWrap.append(menuBtn, dropdown);

  const swatchRow = document.createElement("div");
  swatchRow.className = "hl-swatches";

  const off = document.createElement("button");
  off.type = "button";
  off.className = "hl-off";
  off.textContent = "Off";
  off.addEventListener("click", (e) => {
    e.stopPropagation();
    setHighlightMode({ active: false });
    onPick();
  });

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
        setHighlightMode({ active: true, explain: false, color });
        saveHighlightPrefs({ color });
        onPick();
      });
      swatchRow.appendChild(sw);
    }
  };

  const renderDropdown = (): void => {
    dropdown.replaceChildren();
    const current = loadHighlightPrefs().paletteId;
    for (const p of PALETTES) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "hl-palette-item";
      item.dataset.palette = p.id;
      item.dataset.selected = String(p.id === current);
      const dots = document.createElement("span");
      dots.className = "hl-palette-item-swatches";
      for (const c of p.colors) {
        const dot = document.createElement("span");
        dot.className = "hl-palette-dot";
        dot.style.background = c;
        dots.appendChild(dot);
      }
      const name = document.createElement("span");
      name.textContent = p.name;
      item.append(name, dots);
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        saveHighlightPrefs({ paletteId: p.id });
        dropdown.hidden = true;
        renderSwatches();
      });
      dropdown.appendChild(item);
    }
  };

  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    renderDropdown();
    dropdown.hidden = !dropdown.hidden;
  });

  pop.append(menuWrap, swatchRow, off);

  return {
    popover: pop,
    refresh: () => {
      dropdown.hidden = true;
      renderSwatches();
    },
  };
}
