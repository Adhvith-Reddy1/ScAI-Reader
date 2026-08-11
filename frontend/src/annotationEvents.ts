/**
 * Tiny pub/sub for "the annotations for this document changed" — fired after
 * every `putAnnotation`/`deleteAnnotation` in PageView so panels that mirror
 * IndexedDB (e.g. the Highlights sidebar tab) can refresh without polling.
 */

const subs = new Set<(docId: string) => void>();

export function notifyAnnotationsChanged(docId: string): void {
  for (const cb of subs) cb(docId);
}

export function subscribeAnnotationsChanged(
  cb: (docId: string) => void,
): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}

/** For tests. */
export function _resetForTest(): void {
  subs.clear();
}
