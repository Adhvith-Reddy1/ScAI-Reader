/**
 * Explain-mode state, shared across all PageViews.
 *
 * A separate tool from the standard Highlight: when active, a drag-select
 * saves an *explanation* highlight (which triggers an AI definition/
 * explanation) in the chosen color. The color is the reader's choice — it's no
 * longer hard-coded to blue.
 *
 * Mutually exclusive with the other page tools (Highlight, Erase) via the
 * shared toolExclusion registry.
 */

import type { HighlightColor } from "./api.ts";
import { deactivateOthers, registerTool } from "./toolExclusion.ts";

export interface ExplainModeState {
  active: boolean;
  color: HighlightColor;
}

// Blue stays the default so the feature looks familiar to existing users.
let state: ExplainModeState = { active: false, color: "blue" };
const subscribers = new Set<(s: ExplainModeState) => void>();

function deactivate(): void {
  if (state.active) {
    state = { ...state, active: false };
    for (const cb of subscribers) cb(state);
  }
}
registerTool("explain", deactivate);

export function getExplainMode(): ExplainModeState {
  return state;
}

export function setExplainMode(next: Partial<ExplainModeState>): void {
  state = { ...state, ...next };
  if (state.active) deactivateOthers("explain");
  for (const cb of subscribers) cb(state);
}

export function toggleExplainMode(): void {
  setExplainMode({ active: !state.active });
}

export function subscribeExplainMode(
  cb: (s: ExplainModeState) => void,
): () => void {
  subscribers.add(cb);
  cb(state);
  return () => subscribers.delete(cb);
}

/** For tests. */
export function _resetForTest(): void {
  state = { active: false, color: "blue" };
  subscribers.clear();
  registerTool("explain", deactivate);
}
