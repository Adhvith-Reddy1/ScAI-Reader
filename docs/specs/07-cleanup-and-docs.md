# Spec 07 — Cleanup, dead-code removal & docs

**Branch:** `feat/07-cleanup` · **Wave:** 3 · **Depends on:** Specs 03, 04, 05,
06 all merged. Do this **last** — it deletes the now-unused server persistence.

## Goal
Remove the server-side personal-data storage that the browser model made
obsolete, tidy the API surface, and update documentation so the codebase
honestly reflects the stateless + browser-storage architecture.

## Scope
**In:**
1. **Backend deletions** (only after confirming nothing calls them):
   - The annotation-scoped explanation endpoints superseded by `/ai/*`
     (`/annotations/{id}/explain|chat|refine|explanation`) in
     `explanations.py`, and the old figure explain endpoint superseded by
     `…/figures/{id}/ai-explain`.
   - The `annotations` CRUD routes (`routes/annotations.py`) and the
     `annotations` / `explanations` tables + related code in
     `storage/db.py`, plus the inline `explanation` seeding on
     `GET …/figures` and any `documents`-library listing (`GET /documents`)
     no longer used by the client.
   - Decide the fate of the `documents` table: rendering only needs the PDF on
     disk for the session; if the table is now unused, remove it and key the
     ephemeral PDF/render cache by sha-256 on the filesystem alone.
   - Update/trim integration tests that covered the removed routes; keep
     coverage for what remains (render/text/search/outline/`ai/*`/settings).
2. **Frontend deletions:** remove the now-dead `api.ts` exports
   (`createHighlight`, `listAnnotations`, `deleteAnnotation`, `getExplanation`,
   `listDocuments`, old stream URLs, inline `explanation` fields on `Annotation`
   /`PageFigure`) and any unused imports.
3. **CORS / config:** the dev CORS allowlist in `main.py` can stay (it's only
   for the Vite dev server); confirm nothing else referenced removed state.
4. **Docs:**
   - Rewrite the **Architecture** section of `README.md` for the new model
     (browser = source of truth; server = stateless worker; Fly, no disk;
     OpenRouter free models). Update the data-store diagram.
   - Update `HANDOFF.md` / any architecture notes that describe SQLite as the
     store of record.
   - Cross-link `docs/DEPLOY.md` (Spec 01).

**Out:** new features.

## Testing
- Full backend suite green after deletions (`pytest`, incl. visual goldens with
  `-m "not slow"` for the quick pass, then the full run).
- `cd frontend && npm test` green; `npm run build` clean (no unused-export TS
  errors).
- **Playwright full E2E**: the end-to-end browser-storage journey
  (upload → highlight → explain → reload → everything persists, explanation
  served from cache) passes against the built single-server app.

## Acceptance criteria
- [ ] No dead routes/tables/exports remain; grep shows no callers of removed code.
- [ ] All suites (pytest, vitest, Playwright) green.
- [ ] README architecture + diagram reflect reality; DEPLOY linked.
- [ ] App builds and the full E2E journey passes.
