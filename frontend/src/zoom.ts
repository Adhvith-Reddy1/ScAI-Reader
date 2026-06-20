/**
 * Zoom state shared across all PageViews. Edge-style: a discrete ladder of
 * zoom levels with keyboard / button / wheel triggers stepping along it, and
 * an arbitrary `setZoom` for wheel-pinch style continuous changes.
 *
 * The state is a single module-level value with a subscriber list — same
 * shape as [[highlight-mode]].
 */

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 4.0;

const ZOOM_STEPS = [
  0.5, 0.67, 0.75, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0,
] as const;

// Re-exported for [[viewerZoom]] so it can step the ladder while still
// routing the apply through anchored zoom. Keeps the ladder definition in
// one place.
export const ZOOM_STEPS_FOR_NEXT_PREV = ZOOM_STEPS;
export type ZoomStep = (typeof ZOOM_STEPS)[number];

let current = 1.0;
const subscribers = new Set<(zoom: number) => void>();

export function getZoom(): number {
  return current;
}

export function setZoom(z: number): void {
  const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
  if (Math.abs(clamped - current) < 1e-4) return;
  current = clamped;
  for (const cb of subscribers) cb(current);
}

export function subscribeZoom(cb: (zoom: number) => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

export function zoomIn(): void {
  const next = ZOOM_STEPS.find((s) => s > current + 1e-4);
  if (next != null) setZoom(next);
}

export function zoomOut(): void {
  let prev: number | null = null;
  for (const s of ZOOM_STEPS) {
    if (s < current - 1e-4) prev = s;
  }
  if (prev != null) setZoom(prev);
}

export function resetZoom(): void {
  setZoom(1.0);
}

/** For tests. */
export function _resetForTest(): void {
  current = 1.0;
  subscribers.clear();
}
