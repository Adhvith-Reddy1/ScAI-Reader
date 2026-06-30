# Spec 02 — Browser storage foundation (IndexedDB)

**Branch:** `feat/02-browser-storage` · **Wave:** 1 · **Depends on:** nothing ·
**Conflicts with:** nothing (new files only). **This is the foundation Specs
04/05/06 import — land it early and freeze its API.**

## Goal
Create a typed IndexedDB layer that is the **source of truth for personal data**
(PDFs, highlights, explanations, view state), implementing **Shared Contract A**
from `README.md` exactly. No UI wiring in this spec — just the module + tests.

## Scope
**In:**
- Add dependency `idb` (small, well-maintained IndexedDB wrapper) to
  `frontend/package.json`, and `fake-indexeddb` as a dev dependency for tests.
- `frontend/src/storage/localStore.ts` — implement every function in Shared
  Contract A. One database (e.g. `scai-reader`), object stores:
  - `documents` (keyPath `id`)
  - `annotations` (keyPath `id`, index `by_doc` on `docId`, index `by_doc_page`
    on `[docId, page]`)
  - `explanations` (keyPath `[docId, annotationId]`)
  - `viewState` (keyPath `docId`)
  - Versioned `upgrade` that creates all stores/indexes.
- `deleteDocument(id)` must **cascade**: delete the document plus all its
  annotations, explanations, and its viewState in one transaction.
- `estimateUsage()` wraps `navigator.storage.estimate()` (return `null` if
  unavailable).
- `frontend/src/storage/localStore.test.ts` — Vitest tests using
  `fake-indexeddb` covering: put/get/list/delete for each store, the
  cascade delete, the `by_doc`/page index queries, and `estimateUsage` null-safety.

**Out:** importing this anywhere in `main.ts` or the stores (that's 04/05/06);
the `api.ts` types stay where they are (import `Rect`, `HighlightColor`,
`ExplanationKind` from `api.ts`).

## Implementation notes
- Use `crypto.randomUUID()` for annotation ids in callers — the store just
  persists whatever id it's given.
- Keep it framework-free and synchronous-looking via async/await; no global
  singletons beyond a lazily-opened DB promise.
- Guard for SSR/no-`indexedDB` gracefully (throw a clear error or no-op) so unit
  tests and Playwright both work.
- Add `fake-indexeddb/auto` import in the test setup (or per-file) so
  `indexedDB` exists under jsdom.

## Testing
- `cd frontend && npm test` — all new tests green.
- Tests must prove **persistence semantics** (write, re-open DB, read back) and
  the **cascade delete**.

## Acceptance criteria
- [ ] `localStore.ts` implements Shared Contract A signatures verbatim.
- [ ] Cascade delete removes annotations + explanations + viewState for a doc.
- [ ] Index-based `listAnnotations(docId, page?)` works.
- [ ] Vitest suite covers all stores + edge cases and passes.
- [ ] No edits to `main.ts`, the stores, or backend.
