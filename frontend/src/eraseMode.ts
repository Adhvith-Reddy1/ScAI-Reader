/**
 * Erase-mode state, shared across all PageViews.
 *
 * Edge-style: toggle erase mode on, then clicking any highlight on the page
 * deletes it immediately (no confirm dialog).
 *
 * Mutually exclusive with the other page tools (Highlight, Explain) via the
 * shared toolExclusion registry — turning on erase switches them off.
 */

import { deactivateOthers, registerTool } from "./toolExclusion.ts";

export interface EraseModeState {
  active: boolean;
}

let state: EraseModeState = { active: false };
const subscribers = new Set<(s: EraseModeState) => void>();

function deactivate(): void {
  if (state.active) {
    state = { ...state, active: false };
    for (const cb of subscribers) cb(state);
  }
}
registerTool("erase", deactivate);

export function getEraseMode(): EraseModeState {
  return state;
}

export function setEraseMode(next: Partial<EraseModeState>): void {
  state = { ...state, ...next };
  if (state.active) deactivateOthers("erase");
  for (const cb of subscribers) cb(state);
}

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
  registerTool("erase", deactivate);
}
