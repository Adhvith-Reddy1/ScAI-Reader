/**
 * Highlight-mode state, shared across all PageViews.
 *
 * Edge-style: there's a toolbar button + color popover. When mode is active,
 * any drag-select on a page auto-saves a plain highlight in the active color
 * and clears the selection — no per-selection confirmation popover.
 *
 * State is a simple module-level value with a subscriber list. Tiny enough
 * to not need a framework.
 *
 * Mutually exclusive with the other page tools (Explain, Erase) via the shared
 * toolExclusion registry — activating one switches the others off.
 */

import type { HighlightColor } from "./api.ts";
import { deactivateOthers, registerTool } from "./toolExclusion.ts";

export interface HighlightModeState {
  active: boolean;
  color: HighlightColor;
}

let state: HighlightModeState = { active: false, color: "yellow" };
const subscribers = new Set<(s: HighlightModeState) => void>();

function deactivate(): void {
  if (state.active) {
    state = { ...state, active: false };
    for (const cb of subscribers) cb(state);
  }
}
registerTool("highlight", deactivate);

export function getHighlightMode(): HighlightModeState {
  return state;
}

export function setHighlightMode(next: Partial<HighlightModeState>): void {
  state = { ...state, ...next };
  if (state.active) deactivateOthers("highlight");
  for (const cb of subscribers) cb(state);
}

export function toggleHighlightMode(): void {
  setHighlightMode({ active: !state.active });
}

export function subscribeHighlightMode(
  cb: (s: HighlightModeState) => void,
): () => void {
  subscribers.add(cb);
  cb(state);
  return () => subscribers.delete(cb);
}

/** For tests. */
export function _resetForTest(): void {
  state = { active: false, color: "yellow" };
  subscribers.clear();
  registerTool("highlight", deactivate);
}
