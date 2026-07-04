/**
 * Toolbar control: rotate the whole document view 90° left or right. Rotation
 * is a view setting owned by [[rotation]]; these buttons just step it.
 */

import { rotateCcw, rotateCw } from "./rotation.ts";

function button(
  label: string,
  glyph: string,
  onClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "rotate-button";
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.textContent = glyph;
  btn.addEventListener("click", onClick);
  return btn;
}

export function buildRotateControls(): HTMLElement {
  const group = document.createElement("div");
  group.className = "rotate-controls";
  // ⟲ / ⟳ read as "rotate left/right"; the aria-label carries the meaning.
  group.appendChild(button("Rotate left", "⟲", () => rotateCcw()));
  group.appendChild(button("Rotate right", "⟳", () => rotateCw()));
  return group;
}
