/**
 * Page-rotation state, shared across all PageViews like [[zoom]].
 *
 * Rotation is a per-document view setting in 90° steps. Internally it's a
 * single "current" value (the active document's), so components subscribe the
 * same way they do for zoom; the per-document value is persisted to
 * localStorage and reloaded when a document is opened via `setActiveDoc`.
 *
 * The value is always one of 0 | 90 | 180 | 270, measured clockwise.
 */

export type Rotation = 0 | 90 | 180 | 270;

let currentDocId: string | null = null;
let current: Rotation = 0;
const subscribers = new Set<(deg: Rotation) => void>();

function storageKey(docId: string): string {
  return `scai-reader:rotation:${docId}`;
}

function normalize(deg: number): Rotation {
  const d = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  return d as Rotation;
}

function load(docId: string): Rotation {
  try {
    return normalize(Number(localStorage.getItem(storageKey(docId)) ?? 0));
  } catch {
    return 0;
  }
}

function persist(): void {
  if (!currentDocId) return;
  try {
    localStorage.setItem(storageKey(currentDocId), String(current));
  } catch {
    /* private mode / quota — rotation just won't persist */
  }
}

export function getRotation(): Rotation {
  return current;
}

export function subscribeRotation(cb: (deg: Rotation) => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

function emit(): void {
  for (const cb of subscribers) cb(current);
}

/** Switch the active document; loads its saved rotation (default 0). */
export function setActiveDoc(docId: string | null): void {
  currentDocId = docId;
  const next = docId ? load(docId) : 0;
  if (next === current) {
    // Still emit so listeners re-apply for the freshly mounted document.
    emit();
    return;
  }
  current = next;
  emit();
}

function set(deg: Rotation): void {
  if (deg === current) return;
  current = deg;
  persist();
  emit();
}

export function rotateCW(): void {
  set(normalize(current + 90));
}

export function rotateCCW(): void {
  set(normalize(current + 270));
}

export function resetRotation(): void {
  set(0);
}

/** For tests. */
export function _resetForTest(): void {
  currentDocId = null;
  current = 0;
  subscribers.clear();
}
