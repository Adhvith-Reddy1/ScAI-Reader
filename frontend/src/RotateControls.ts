/**
 * Toolbar widget: [⟲] [⟳] — rotate the document 90° counter-/clockwise.
 *
 * Rotation is a per-document view setting (persisted), shared via [[rotation]].
 * Clicking either button steps the active document's rotation; the buttons are
 * disabled until a document is open.
 */

import { getRotation, rotateCCW, rotateCW, subscribeRotation } from "./rotation.ts";

export function buildRotateControls(): HTMLElement {
  const root = document.createElement("div");
  root.className = "rotate-controls";

  const ccw = document.createElement("button");
  ccw.type = "button";
  ccw.className = "rotate-btn";
  ccw.textContent = "⟲";
  ccw.title = "Rotate left (R with Shift)";
  ccw.setAttribute("aria-label", "Rotate page counter-clockwise");
  ccw.addEventListener("click", () => rotateCCW());

  const cw = document.createElement("button");
  cw.type = "button";
  cw.className = "rotate-btn";
  cw.textContent = "⟳";
  cw.title = "Rotate right (R)";
  cw.setAttribute("aria-label", "Rotate page clockwise");
  cw.addEventListener("click", () => rotateCW());

  root.append(ccw, cw);

  // Surface the current angle for assistive tech / debugging without taking up
  // toolbar space — title reflects it.
  const render = (deg: number) => {
    const label = deg === 0 ? "" : ` (${deg}°)`;
    root.title = `Page rotation${label}`;
  };
  render(getRotation());
  subscribeRotation(render);

  return root;
}
