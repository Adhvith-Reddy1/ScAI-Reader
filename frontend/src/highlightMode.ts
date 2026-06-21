/**
 * Highlight-mode state, shared across all PageViews.
 *
 * Edge-style: there's a toolbar button + color popover. When mode is active,
 * any drag-select on a page auto-saves a highlight in the active color and
 * clears the selection — no per-selection confirmation popover.
 *
 * State is a simple module-level value with a subscriber list. Tiny enough
 * to not need a framework.
 *
 * Mutually exclusive with erase mode — turning on highlight turns off erase
 * (and vice versa). Erase wiring is registered at runtime via
 * `_setEraseDisabler` to avoid a circular module import.
 */

import type { HighlightColor } from "./api.ts";
import { loadHighlightPrefs } from "./palettes.ts";

export interface HighlightModeState {
  active: boolean;
  color: HighlightColor;
  /** When true, drag-select creates an AI "Explain" highlight. */
  explain: boolean;
}

function initialState(): HighlightModeState {
  return { active: false, color: loadHighlightPrefs().color, explain: false };
}

let state: HighlightModeState = initialState();
const subscribers = new Set<(s: HighlightModeState) => void>();
let disableErase: (() => void) | null = null;

/**
 * Late-bound hook the erase module calls during init to register its
 * "disable" callback. Keeps highlightMode free of an erase import.
 */
export function _setEraseDisabler(fn: () => void): void {
  disableErase = fn;
}

export function getHighlightMode(): HighlightModeState {
  return state;
}

export function setHighlightMode(next: Partial<HighlightModeState>): void {
  state = { ...state, ...next };
  if (state.active && disableErase) disableErase();
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
  state = { active: false, color: "yellow", explain: false };
  subscribers.clear();
  disableErase = null;
}
