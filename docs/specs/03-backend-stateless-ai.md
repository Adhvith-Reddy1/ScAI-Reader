# Spec 03 — Backend: stateless AI endpoints (additive)

**Branch:** `feat/03-backend-stateless-ai` · **Wave:** 1 · **Depends on:**
nothing · **Conflicts with:** nothing if kept ADDITIVE (add new routes; delete
none). Deletion of the old persistence happens later in Spec 07.

## Goal
Add AI endpoints that do **not** require a server-stored annotation and that
**persist nothing**, so the browser can own highlights/explanations. The PDF the
user opened this session is already uploaded (present in the ephemeral
cache/`data` dir), so the server can still extract page text and render figure
crops by `doc_id` — it just won't read/write the `annotations`/`explanations`
tables.

## Context (reuse, don't rewrite)
`backend/app/routes/explanations.py` already has everything you need to factor
from: `classify()`, the `SYSTEM_*` prompts, `_page_text()`, `_page_context()`,
`_build_chat_messages()`, `_stream_explanation()`, the SSE helpers
(`_sse_event`, `_error_sse`), and `llm.stream_completion()`. `figures.py` has the
figure-explain stream. Phase 1 added `ai.error_code()` and friendly rate-limit
handling — keep using `_error_sse`.

## Scope (ADDITIVE — see Shared Contract B in README)
**In:** new endpoints (new router or added to existing files; do not remove old
ones):
- `POST /documents/{doc_id}/ai/explain` — body `{ text, kind? }`. Resolve
  `kind` via `classify(text)` when absent. Extract page text **from the request
  context**: accept an optional `page` index (preferred) so the server can call
  `_page_text(settings, doc_id, page)`; if the PDF isn't in the cache, fall back
  to an empty page context (model still answers). Stream meta/delta/done/error.
  **No DB reads or writes.**
- `POST /documents/{doc_id}/ai/chat` — body `{ text, kind, content, page, messages[] }`.
  Reuse `_build_chat_messages`. Stream. No persistence.
- `POST /documents/{doc_id}/ai/refine` — body `{ text, kind, content, page, messages[] }`.
  Same as today's refine **but do not call `_save_refined`** — just stream the
  rewritten text; the client caches it.
- `POST /documents/{doc_id}/figures/{figure_id}/ai-explain` — body `{ page, label }`.
  Same figure-image flow as the existing figure explain, **minus** any
  `explanations`/cache persistence.
- Factor the shared prompt/stream logic so the new and old endpoints don't
  duplicate prompt text (e.g. move `classify`, `SYSTEM_*`, `_stream_explanation`
  into a small helper module imported by both, OR have the new endpoints import
  from `explanations.py`). Keep the change reviewable.

**Out:** deleting old endpoints/tables (Spec 07); any frontend change; touching
render/text/search/outline routes (they already work statelessly enough).

## Tests
Add `backend/tests/integration/test_stateless_ai.py`:
- The new endpoints return SSE frames and **never touch the DB** (e.g. assert no
  rows are written to `explanations` after a call — use a monkeypatched/fake LLM
  stream like the existing AI tests do; see `test_explanation_chat.py` and
  `test_ai.py` for the patterns).
- `kind` defaults via `classify` when omitted.
- Missing/unconfigured provider yields the `ai_not_configured` coded error frame.
- Rate-limit path surfaces the friendly message (you can reuse the Phase 1
  approach by simulating a provider `RateLimitError`).

## Acceptance criteria
- [ ] All four new endpoints exist, stream SSE, and write nothing to the DB.
- [ ] Old annotation-scoped endpoints still present and unchanged in behavior.
- [ ] Prompt/stream logic is shared, not copy-pasted.
- [ ] New integration tests pass; full `pytest` suite stays green.
- [ ] No frontend changes.
