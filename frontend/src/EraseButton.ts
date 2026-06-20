/**
 * Nav-bar Erase button. Simpler than HighlightButton — just a toggle.
 *
 *   click button → erase mode flips
 *   while ON, clicking any highlight on a page deletes it immediately
 *
 * The button reflects current state via `data-active`, which the stylesheet
 * uses for the active visual treatment.
 */

import {
  getEraseMode,
  subscribeEraseMode,
  toggleEraseMode,
} from "./eraseMode.ts";

export function buildEraseButton(): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "erase-button";
  button.setAttribute("aria-label", "Erase highlights");
  button.setAttribute("aria-pressed", String(getEraseMode().active));

  const icon = document.createElement("span");
  icon.className = "erase-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "⌫"; // erase-to-the-left symbol; a small visual cue
  const label = document.createElement("span");
  label.className = "erase-label";
  label.textContent = "Erase";
  button.append(icon, label);

  button.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleEraseMode();
  });

  subscribeEraseMode((s) => {
    button.dataset.active = String(s.active);
    button.setAttribute("aria-pressed", String(s.active));
  });

  return button;
}
