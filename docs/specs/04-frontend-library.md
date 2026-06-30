# Spec 04 — Frontend: library in the browser

**Branch:** `feat/04-frontend-library` · **Wave:** 2 · **Depends on:** Spec 02
(merged) · **Shared files:** `frontend/src/api.ts`, `frontend/src/main.ts`,
`frontend/src/Library.ts` (see Conflict map). **Land before 05/06 if possible.**

## Goal
Make the **library live in the browser**. Uploaded PDFs (bytes + metadata) are
stored in IndexedDB via Spec 02's `localStore`. On open, the PDF is
(re-)uploaded to the stateless server purely to render; the server keeps no
durable library. Remove dependence on the server's `GET /documents` list.

## Current behavior to replace
- `main.ts` lists the library via `listDocuments()` (`GET /documents`) and opens
  a doc by id. Upload uses `uploadDocument(file)` (`POST /documents`) which
  returns `DocumentMeta` (incl. `id` = sha-256, `page_count`, title/author).
- `Library.ts` renders the library UI and "No documents yet" empty state.

## Scope
**In:**
1. **Upload flow:** when the user picks a PDF:
   - Compute/obtain the document id. `uploadDocument` already returns the
     server's sha-256 `id` + metadata — keep calling it to render, but **also**
     persist the file to IndexedDB: `putDocument({ id, filename, page_count,
     title, author, size_bytes: file.size, added_at, blob: file })`.
   - Before persisting, check `estimateUsage()`; if near quota, warn the user
     (non-blocking) that older PDFs may need removing.
2. **Library listing:** render the library from `localStore.listDocuments()`
   (meta only), **not** from the server. Remove/stop calling `listDocuments()`
   in `api.ts` for the library view.
3. **Open flow:** opening a library item must ensure the server can render it:
   - `getDocument(id)` from IndexedDB → if the server doesn't have it this
     session (first open after a fresh server / new browser session), re-`POST`
     the stored `blob` to `/documents` so `/pages`, `/text`, etc. work. (Upload
     is idempotent by sha-256.) A simple, robust approach: **always re-upload
     the blob on open** before rendering (cheap correctness; we accepted
     re-render latency).
4. **Delete flow:** deleting a library item calls `localStore.deleteDocument(id)`
   (cascades highlights/explanations/viewState). No server call needed.
5. **View state:** restore `lastPage`/`zoom`/`sidebarOpen` from
   `getViewState(docId)` on open, and persist on change (debounced).

**Out:** highlight persistence (Spec 05) and explanation caching (Spec 06) —
don't implement those stores here, but leave clean seams (e.g. the open flow
should `await` whatever 05/06 need to load).

## api.ts changes (your ownership)
- Add a helper to re-upload a stored `Blob`/`File` (wrap `uploadDocument` to
  accept a `Blob` + filename), or reuse `uploadDocument` by reconstructing a
  `File`. Keep `pageImageUrl`, `fetchDocumentDimensions`, `fetchPageText`,
  `fetchOutline`, `fetchSearchResults`, `fetchPageFigures` as-is.
- Mark `listDocuments()` as no longer used by the library (leave it for Spec 07
  to delete, or delete its call sites only).

## Testing
- **Vitest:** library list/empty-state logic, the near-quota warning trigger,
  view-state save/restore (mock `localStore`).
- **Playwright (required):** upload a PDF → it appears in the library → reload
  the page → it's **still there** (proves IndexedDB persistence) → open it →
  pages render → delete it → it's gone after reload. Use the bundled
  `Animal_farm.pdf` fixture.

## Acceptance criteria
- [ ] Uploading stores the PDF in IndexedDB and it survives a reload.
- [ ] The library renders from the browser, not the server.
- [ ] Opening re-supplies the PDF so rendering works on a fresh server/session.
- [ ] Delete cascades and persists across reload.
- [ ] View state (page/zoom/sidebar) restores on reopen.
- [ ] Playwright persistence test passes; app builds; smoke test passes.
