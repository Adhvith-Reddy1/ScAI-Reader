# Spec 05 — Frontend: highlights in the browser

**Branch:** `feat/05-frontend-highlights` · **Wave:** 2 · **Depends on:** Spec 02
(merged) · **Shared files:** `frontend/src/main.ts`, `frontend/src/api.ts`
(removing highlight network calls), `frontend/src/viewer/*` for the annotation
layer. Coordinate `main.ts` edits with Specs 04/06.

## Goal
Highlights become **purely client-side**: created, listed, and deleted in
IndexedDB via Spec 02's `localStore`. Highlighting no longer touches the network.

## Current behavior to replace
- `api.ts`: `createHighlight()` (`POST …/annotations`), `listAnnotations()`
  (`GET …/annotations`), `deleteAnnotation()` (`DELETE …/annotations/{id}`).
- `viewer/PageView.ts` (`maybeAutoSaveHighlight`) creates highlights;
  `viewer/AnnotationLayer.ts` renders them; the erase tool deletes them.
- The server assigned annotation `id` and `created_at`; now the client does.

## Scope
**In:**
1. **Create:** on highlight commit, build a `LocalAnnotation` with
   `id = crypto.randomUUID()`, `created_at = new Date().toISOString()`, and the
   page/color/rects/text/explain fields, then `putAnnotation(a)`. Return the new
   annotation to the caller exactly where `createHighlight` did so the explain
   trigger (Spec 06) can fire with the new `id`.
2. **List/render:** load a page's highlights with
   `listAnnotations(docId, page)` from `localStore` and render via the existing
   annotation layer. Replace all `listAnnotations()` network calls.
3. **Delete (erase tool):** `deleteAnnotation(docId, id)` against `localStore`.
4. Remove the highlight network functions' **call sites**; leave the dead
   `api.ts` exports for Spec 07 to delete (or delete them if no other caller).
5. Preserve the `explain` flag semantics (explanation highlights) so Spec 06 can
   hook in — but do **not** implement explanation fetching/caching here.

**Out:** explanation generation/caching (Spec 06); library (Spec 04).

## Notes
- Keep rect/coord types identical (`Rect` from `api.ts`); the viewer math is
  unchanged — only the persistence source changes.
- Nothing here needs the server, so it works with no AI key and even if the
  server is briefly unreachable after the page has loaded.

## Testing
- **Vitest:** highlight create→list→delete against a mocked/`fake-indexeddb`
  `localStore`; assert the annotation shape and that ids are client-generated.
- **Playwright (required):** open a PDF, drag-create a highlight, **reload**,
  confirm the highlight is still rendered on the page; erase it, reload, confirm
  it's gone. (Drag selection in a real browser is exactly what Playwright is
  for.)

## Acceptance criteria
- [ ] Creating/erasing highlights writes only to IndexedDB (no network).
- [ ] Highlights persist across reload and render on the correct page.
- [ ] `explain` flag still set so Spec 06 can trigger explanations.
- [ ] Vitest + Playwright highlight tests pass; build + smoke test pass.
