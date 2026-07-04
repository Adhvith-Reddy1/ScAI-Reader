/**
 * View rotation state, shared across all PageViews — same module-level-value +
 * subscriber shape as [[zoom]]. Rotation is a whole-document view setting (0 /
 * 90 / 180 / 270 degrees clockwise); it's persisted per document in viewState
 * so reopening restores the reader's orientation.
 */

export type Rotation = 0 | 90 | 180 | 270;

let current: Rotation = 0;
const subscribers = new Set<(deg: Rotation) => void>();

/** Normalize any integer degree to the nearest of {0,90,180,270}. */
export function normalizeRotation(deg: number): Rotation {
  const n = (((Math.round(deg / 90) * 90) % 360) + 360) % 360;
  return n as Rotation;
}

export function getRotation(): Rotation {
  return current;
}

export function setRotation(deg: number): void {
  const next = normalizeRotation(deg);
  if (next === current) return;
  current = next;
  for (const cb of subscribers) cb(current);
}

export function rotateCw(): void {
  setRotation(current + 90);
}

export function rotateCcw(): void {
  setRotation(current - 90);
}

/** True for the quarter turns, where the page's width and height swap. */
export function isSideways(deg: Rotation = current): boolean {
  return deg === 90 || deg === 270;
}

export function subscribeRotation(cb: (deg: Rotation) => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/** For tests. */
export function _resetForTest(): void {
  current = 0;
  subscribers.clear();
}
