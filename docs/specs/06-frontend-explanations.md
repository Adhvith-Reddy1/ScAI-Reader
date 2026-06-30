# Spec 06 — Frontend: explanation cache in the browser

**Branch:** `feat/06-frontend-explanations` · **Wave:** 2 · **Depends on:**
Spec 02 (merged) **and** Spec 03 (merged, for the stateless AI endpoints).
**Shared files:** `frontend/src/api.ts` (AI stream functions),
`frontend/src/explanationStore.ts`, `frontend/src/figureStore.ts`,
`frontend/src/main.ts`. Coordinate `main.ts`/`api.ts` edits with 04/05.

## Goal
AI explanations are **generated via the stateless endpoints (Spec 03) and cached
in the browser (Spec 02)**. The client checks its IndexedDB cache first; on a
hit it renders instantly with zero network/LLM calls; on a miss it streams from
the server and writes the result to the cache.

## Current behavior to replace
- `api.ts`: `streamExplanation()` → `POST …/annotations/{id}/explain`,
  `streamChat()` → `…/chat`, `streamRefine()` → `…/refine` (server persists the
  refine), `streamFigureExplanation()` → `…/figures/{id}/explain`,
  `getExplanation()` → `GET …/annotations/{id}/explanation`.
- The server cached explanations and inlined them on `GET /annotations`
  (`Annotation.explanation`) and `GET …/figures` (`PageFigure.explanation`).
  Those inline fields **go away** in the browser model — seed from the local
  cache instead.
- `explanationStore.ts` holds tooltip state; `figureStore.ts` holds figure
  explanation state.

## Scope
**In:**
1. **Point the AI streams at the new endpoints (Spec 03 / Shared Contract B):**
   - `streamExplanation` → `POST …/ai/explain` with `{ text, kind?, page }`.
   - `streamChat` → `…/ai/chat`; `streamRefine` → `…/ai/refine` (server no longer
     persists — that's expected).
   - `streamFigureExplanation` → `…/figures/{figure_id}/ai-explain`.
   - The endpoints take `page` (and `text`/`label`) instead of an
     annotation id; update signatures accordingly. Keep the SSE consumer logic
     (`consumeSSE`) unchanged.
2. **Cache-first reads:** before streaming, call
   `localStore.getExplanation(docId, annotationId)` — on a complete hit, seed the
   tooltip immediately and skip the network. (Figures: cache by `figure_id`; if
   you need a figure explanation store key, reuse `annotationId` slot with the
   `figure_id`, or extend the contract via Spec 02 only if unavoidable —
   prefer not to change the frozen contract.)
3. **Write-through on done:** when a stream completes (`onDone`), persist via
   `putExplanation({ docId, annotationId, kind, text, content, status:
   "complete", updated_at })`. Refine overwrites the same key.
4. **Seed on load:** when highlights load (Spec 05) and on figure detection,
   pre-seed `explanationStore`/`figureStore` from the local cache so the first
   hover is instant — replacing the old server-inlined `explanation` fields.
5. Remove reliance on `getExplanation()` (server) and the inline `explanation`
   fields from `Annotation`/`PageFigure`.

**Out:** library (04); highlight persistence (05) — but you rely on 05's
client-generated annotation `id` as the cache key, so rebase on 05 if it lands
first, else coordinate the `id` source.

## Testing
- **Vitest:** cache-hit path (no stream started when a complete explanation
  exists), write-through on `onDone`, refine overwrite. Mock `localStore` and the
  stream functions.
- **Playwright (required):** create an explanation highlight → tooltip streams
  in → **reload** → hover the same highlight → content shows **instantly with no
  new AI request** (assert by intercepting `/ai/explain` and expecting zero
  calls on the second view).

## Acceptance criteria
- [ ] AI calls hit the stateless `/ai/*` endpoints with page/text (no annotation id).
- [ ] Completed explanations cache in IndexedDB and survive reload.
- [ ] A cached explanation renders with zero network/LLM calls.
- [ ] Figure explanations cache and re-render from cache.
- [ ] Vitest + Playwright tests pass; build + smoke test pass.
