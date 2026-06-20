/**
 * Erase-mode state, shared across all PageViews.
 *
 * Edge-style: toggle erase mode on, then clicking any highlight on the page
 * deletes it immediately (no confirm dialog).
 *
 * Mutually exclusive with highlight mode — turning on erase turns off
 * highlight (and vice versa). Two coexisting "click-mode" cursors over the
 * page would be confusing.
 */

import {
  _setEraseDisabler,
  getHighlightMode,
  setHighlightMode,
} from "./highlightMode.ts";

export interface EraseModeState {
  active: boolean;
}

let state: EraseModeState = { active: false };
const subscribers = new Set<(s: EraseModeState) => void>();

export function getEraseMode(): EraseModeState {
  return state;
}

export function setEraseMode(next: Partial<EraseModeState>): void {
  state = { ...state, ...next };
  // Mutual exclusion: turning on erase turns off highlight.
  if (state.active && getHighlightMode().active) {
    setHighlightMode({ active: false });
  }
  for (const cb of subscribers) cb(state);
}

// Register a disabler so highlightMode can turn erase off without importing
// this module (would be circular). Runs once at module load.
_setEraseDisabler(() => {
  if (state.active) {
    state = { ...state, active: false };
    for (const cb of subscribers) cb(state);
  }
});

export function toggleEraseMode(): void {
  setEraseMode({ active: !state.active });
}

export function subscribeEraseMode(
  cb: (s: EraseModeState) => void,
): () => void {
  subscribers.add(cb);
  cb(state);
  return () => subscribers.delete(cb);
}

/** For tests. */
export function _resetForTest(): void {
  state = { active: false };
  subscribers.clear();
  _setEraseDisabler(() => {
    if (state.active) {
      state = { ...state, active: false };
      for (const cb of subscribers) cb(state);
    }
  });
}
