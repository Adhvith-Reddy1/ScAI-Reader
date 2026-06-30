/**
 * Build a client-side highlight annotation.
 *
 * Highlights are now owned by the browser (Spec 05): the client mints the `id`
 * and `created_at` that the server used to assign, and the result is persisted
 * to IndexedDB via `localStore.putAnnotation`. Kept as a tiny pure factory so
 * the shape — and the "ids are client-generated" guarantee — is unit-testable
 * without the DOM/selection machinery in `PageView`.
 */
import type { HighlightColor, Rect } from "../api.ts";
import type { LocalAnnotation } from "../storage/localStore.ts";

export interface NewHighlight {
  docId: string;
  page: number;
  color: HighlightColor;
  rects: Rect[];
  text: string | null;
  explain: boolean;
}

export function makeHighlight(input: NewHighlight): LocalAnnotation {
  return {
    id: crypto.randomUUID(),
    docId: input.docId,
    page: input.page,
    kind: "highlight",
    color: input.color,
    rects: input.rects,
    text: input.text,
    explain: input.explain,
    created_at: new Date().toISOString(),
  };
}
