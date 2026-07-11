# Spec 11 — Cross-device sync (opt-in, signed-in only)

**Branch:** `feat/11-cross-device-sync` · **Wave:** 2 (Phase 2) · **Depends
on:** Spec 08 merged (needs `auth.get_current_user_id`). **Conflicts with:**
this is the largest architecture change in this batch — read the trade-off
below before starting. Touches `frontend/src/storage/localStore.ts` call
sites (additively) and adds new backend persistence.

## Goal
The actual reason to sign up: a signed-in reader's highlights and
explanations follow them to a second device. For anyone who never signs in,
behavior stays **exactly** as it is today — local-first, IndexedDB as the
sole source of truth, nothing server-side. This spec turns on server-side
sync **only** for accounts that opt in by signing in.

## Read this before starting — the trade-off
Today's entire privacy pitch is "the server keeps nothing personal, ever"
(`docs/specs/README.md`). This spec deliberately breaks that invariant, but
narrowly: only for signed-in users, and only for the annotation data they
created an account specifically to sync. Implement this as strictly
additive and opt-in:

- An anonymous reader's requests and data must be byte-for-byte unaffected.
- A signed-in reader who never lets their annotations sync (e.g. they just
  wanted the higher AI quota some future spec might grant, or just haven't
  opened a second device) should see no behavior change either — sync only
  activates on the actual push/pull calls below, not on sign-in alone.
- Make this explicit in whatever UI copy accompanies sign-in (Spec 08/12):
  don't let a reader discover after the fact that signing in changed where
  their data lives.

## Scope
**In:**
- **`backend/app/storage/db.py`** — mirrors Shared Contract A's
  `LocalAnnotation`/`ViewState` shapes exactly, scoped to `user_id`:
  ```sql
  CREATE TABLE IF NOT EXISTS synced_annotations (
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      doc_id      TEXT NOT NULL,
      id          TEXT NOT NULL,        -- the client-generated annotation id
      kind        TEXT NOT NULL,
      color       TEXT NOT NULL,
      rects       TEXT NOT NULL,        -- JSON
      text        TEXT,
      explain     INTEGER NOT NULL,
      created_at  TEXT NOT NULL,
      PRIMARY KEY (user_id, doc_id, id)
  );
  CREATE TABLE IF NOT EXISTS synced_view_state (
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      doc_id        TEXT NOT NULL,
      last_page     INTEGER NOT NULL,
      zoom          REAL NOT NULL,
      sidebar_open  INTEGER NOT NULL,
      PRIMARY KEY (user_id, doc_id)
  );
  ```
- Routes (all 401 if signed out — use `auth.get_current_user_id`):
  - `PUT /sync/annotations/{docId}` — bulk upsert; body is the full current
    local set for that doc. The client stays the source of truth; the
    server is a mirror, not a CRDT. Simplest correct model for v1.
  - `GET /sync/annotations/{docId}` — the server's current set for merge.
  - `DELETE /sync/annotations/{docId}/{id}`.
  - Same three for `view_state` if time allows; annotations are the
    priority (view state is a nice-to-have, not the "why I signed up" one).
- **Frontend:** on sign-in, and on annotation change (debounced, e.g.
  2s after the last edit) while signed in, push the local set for the
  currently-open doc via `PUT`. On opening a doc while signed in, `GET` the
  server copy and merge with the local IndexedDB set by **last-write-wins**
  on `created_at` — document this explicitly as a known v1 limitation
  (concurrent edits to the *same* annotation on two devices at the same
  moment aren't meaningfully resolved), not a promise of real-time sync.
- The PDF file itself is **not** synced — only the reader's own annotation
  metadata (`LocalAnnotation`/`ViewState` shapes). Re-opening a synced doc
  on a new device still re-uploads the PDF bytes from that device's own
  copy/re-fetch, same as today.

**Out:** real-time/multi-tab conflict resolution beyond last-write-wins;
syncing PDF bytes; any sync behavior for anonymous readers (explicitly
never — signing in is the only trigger for any of this).

## Testing
- Backend: CRUD tests plus an explicit **isolation** test — user A can never
  read or write user B's rows, even by guessing IDs.
- Frontend: merge-policy tests with fake timestamps proving last-write-wins
  resolves correctly in both directions.
- Playwright: using the same fake-Google-token override pattern from Spec
  08's tests, simulate two "sessions" against one backend signed into the
  same account and prove an annotation created in one appears after opening
  the doc in the other.

## Acceptance criteria
- [ ] Anonymous behavior is unchanged (existing Playwright suite still
      green with zero sign-in involved).
- [ ] Signed-in sync round-trips across two simulated clients on the same
      account.
- [ ] Cross-account isolation is proven by a test, not just assumed.
- [ ] PDF bytes are never uploaded for sync purposes — only annotations.
