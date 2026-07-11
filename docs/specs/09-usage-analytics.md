# Spec 09 — Usage analytics (event tracking)

**Branch:** `feat/09-usage-analytics` · **Wave:** 1 (Phase 2) · **Depends
on:** the AI-quota/BYO-key work merged to `main` (reuses the anonymous
`X-Client-Id` convention). **Independent of Spec 08** — analytics is keyed by
anonymous `client_id` and works whether or not the reader ever signs in.
**Conflicts with:** touches a handful of existing call sites to fire events
(see Conflict map addendum in `README.md`) — keep each touch to one line.

## Goal
Capture just enough anonymous, aggregate signal to answer real product
questions — highlights per doc, definition-vs-explanation ratio, how often
people come back — for Spec 10's dashboard to read. Nothing here reads back
the data; that's Spec 10.

## Privacy boundary — read this before writing any code
The whole app's pitch rests on "the server holds nothing personal." This
spec adds a **new, distinct category** of server-side data — usage
*metadata* — and must not blur into personal *content*:

- **Send:** event type, `doc_id` (already a content hash, not identifying),
  `client_id` (the existing anonymous id), an explanation `kind` when
  relevant, and a timestamp.
- **Never send:** highlighted text, explanation content, page text, or
  anything else a reader typed or read. If a future event type would need
  content to be useful, that's a sign it doesn't belong in this table —
  raise it as a separate decision, don't just add the field.

## Scope
**In:**
- **`backend/app/storage/db.py`**:
  ```sql
  CREATE TABLE IF NOT EXISTS usage_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id    TEXT NOT NULL,
      doc_id       TEXT,               -- nullable: not every event is doc-scoped
      event_type   TEXT NOT NULL,
      kind         TEXT,               -- 'definition' | 'explanation', explanation_viewed only
      occurred_at  TEXT NOT NULL       -- ISO-8601 UTC
  );
  CREATE INDEX IF NOT EXISTS idx_usage_events_client ON usage_events(client_id);
  CREATE INDEX IF NOT EXISTS idx_usage_events_type_time ON usage_events(event_type, occurred_at);
  ```
- **`backend/app/analytics.py`** — `record_event(settings, client_id,
  event_type, *, doc_id=None, kind=None) -> None`. Validate `event_type`
  against a fixed allowlist (`highlight_created`, `explanation_viewed`,
  `session_start`) — reject anything else with 400. This table must never
  become a free-text event dumping ground.
- **`backend/app/routes/analytics.py`** — `POST /analytics/event`, body
  `{event_type, doc_id?, kind?}`, reads `client_id` from `X-Client-Id`
  (validate format the same way `quota.py` does; store the raw id here, not
  quota's `id:`/`ip:`-prefixed bucket key — analytics wants the real
  anonymous id). Always returns 204 quickly; this must never become a
  perceptible delay in the reader's flow.
- **Frontend `frontend/src/api.ts`** — `trackEvent(type, {docId?, kind?})`:
  fire-and-forget, use `navigator.sendBeacon` when available (survives page
  unload) falling back to `fetch(..., {keepalive: true})`. Swallow all
  errors — a tracking failure must never surface to the reader or block
  anything.
- Wire exactly three call sites (keep this spec small; resist the urge to
  instrument everything at once):
  1. `highlight_created` — at the point a new annotation is written to
     IndexedDB (find the actual `putAnnotation` call site in
     `highlightMode.ts`/`HighlightButton.ts`).
  2. `explanation_viewed` with `kind` — once an explanation is actually
     shown to the reader (fires whether it came from cache or a fresh
     stream) in `explanationStore.ts`.
  3. `session_start` — once per app load in `main.ts`, debounced to at most
     once per rolling 30 minutes via a `scai.lastSessionPing` localStorage
     timestamp, so reopening tabs doesn't spam events.

**Out:** any UI reading this data back (Spec 10); attributing events to a
signed-in user (a light follow-up once Spec 08 lands — `client_id` alone is
enough for Spec 10's first version, same as everything else in this app).

## Testing
- Backend: unit tests for `record_event` (writes the expected row; rejects
  an unlisted `event_type`). Integration test for `POST /analytics/event`
  end-to-end.
- Frontend: a `trackEvent` unit test asserting the request shape sent and
  that a simulated network failure never throws or blocks the caller.

## Acceptance criteria
- [ ] `usage_events` table + `POST /analytics/event` exist; unknown
      `event_type` is rejected.
- [ ] The three call sites fire the right event with the right fields.
- [ ] No highlighted text, explanation content, or page text ever appears
      in a tracked event (grep the payloads in tests to prove it).
- [ ] A tracking failure (simulated network error) never surfaces to the
      reader or blocks the action that triggered it.
