# Spec 08 — Optional accounts (Google sign-in)

**Branch:** `feat/08-optional-accounts` · **Wave:** 1 (Phase 2) · **Depends
on:** the AI-quota/BYO-key work merged to `main` (reuses the anonymous
`X-Client-Id` convention from `frontend/src/clientId.ts` and
`backend/app/quota.py`) · **Conflicts with:** nothing new — new files, plus a
small addition to `frontend/src/main.ts`'s nav wiring (see Conflict map in
`README.md`, updated below).

## Goal
Add sign-in that is **entirely optional** — no existing feature may start
requiring it. This spec's only job is the auth mechanism itself: a Google
OAuth flow, a session, and linking the reader's existing anonymous
`clientId` to their new account. It deliberately does nothing useful yet
(no sync, no stats) — Specs 10/11 build on top of the identity this creates.

## Context
The app is explicitly no-auth today (`docs/specs/README.md`: "no auth, no
per-user identity... privacy is structural"). This spec is the first crack in
that invariant, so keep the blast radius small: anonymous use must remain
byte-for-byte identical to today, and nothing here should make a reader's
first-ever visit feel like it's asking for a login.

## Scope
**In:**
- **`backend/app/storage/db.py`** — two new tables:
  ```sql
  CREATE TABLE IF NOT EXISTS users (
      id          TEXT PRIMARY KEY,   -- Google 'sub'
      email       TEXT NOT NULL,
      created_at  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS client_links (
      client_id   TEXT PRIMARY KEY,   -- the anonymous id from X-Client-Id
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      linked_at   TEXT NOT NULL
  );
  ```
  A `client_id` can only ever link to one `user_id` (that's why it's the
  primary key) — re-signing-in from the same browser just refreshes
  `linked_at`. One account can have many linked `client_id`s (a reader who
  used the app anonymously on two browsers before signing in on both).
- **`backend/app/auth.py`** — Google OAuth 2.0 authorization-code flow:
  exchange the code, verify the ID token, upsert the `users` row, link the
  `X-Client-Id` from the request, and issue a signed session cookie
  (`scai_session`, httpOnly, `Secure`, `SameSite=Lax`; sign with
  `itsdangerous.URLSafeTimedSerializer` or an equivalent small HMAC helper —
  no server-side session table needed, the cookie *is* the session).
  `get_current_user_id(request) -> str | None` is the one function later
  specs should import — don't re-implement cookie parsing elsewhere.
- **`backend/app/routes/auth.py`**:
  - `GET /auth/google/start` — redirects to Google's consent screen.
  - `GET /auth/google/callback` — completes the exchange, sets the cookie,
    links the client id, redirects back to `/`.
  - `GET /auth/me` — `{ signedIn: boolean, email: string | null }`.
  - `POST /auth/logout` — clears the cookie.
- **Config:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `GOOGLE_REDIRECT_URI` via env, documented in `.env.example`. When unset,
  `/auth/me` always returns `signedIn: false` and the frontend hides the
  sign-in affordance entirely — mirror how AI Setup degrades gracefully with
  no provider configured, don't show a broken button.
- **Frontend:** `frontend/src/Account.ts` — `buildAccountButton()` (same nav
  pattern as `AiSetup.ts`'s `buildAiSetupButton()`): "Sign in" when signed
  out, email + "Sign out" when signed in. Sign-in is a full-page redirect to
  `/auth/google/start` (simplest, avoids popup-blocker issues). Wire the
  button into `frontend/src/main.ts`'s nav, next to the AI setup button.

**Out:** anything that uses the identity yet — no sync, no stats
attribution, no premium gating. Those are Specs 10 and 11.

## Shared Contract D — auth (owned by this spec)
```
GET  /auth/me                -> { signedIn: boolean, email: string | null }
GET  /auth/google/start      (redirect to Google)
GET  /auth/google/callback   (redirect back to "/"; sets scai_session cookie)
POST /auth/logout            -> { signedIn: false }
```
Backend helper: `auth.get_current_user_id(request: Request) -> str | None`.
Frontend helper: `getAccountStatus(): Promise<{signedIn, email}>` in `api.ts`.

## Testing
- Backend: inject a fake Google-token verifier via dependency override (no
  live network calls in tests) and assert: callback upserts `users`, links
  `client_id` → `user_id`, sets the cookie; `/auth/me` reflects signed-in vs.
  signed-out; `/auth/logout` clears it; everything no-ops cleanly with no
  Google credentials configured.
- Frontend: Vitest for the button's two render states. Skip real OAuth in
  Playwright (can't automate Google's login) — assert only that the button
  renders and the signed-out state doesn't block anything.

## Acceptance criteria
- [ ] Every existing feature works identically with zero sign-in, zero
      Google credentials configured.
- [ ] `/auth/me`, `/auth/google/start`, `/auth/google/callback`,
      `/auth/logout` all behave per Shared Contract D.
- [ ] First sign-in links the current `client_id`; repeat sign-ins from the
      same browser don't create duplicate links.
- [ ] No feature elsewhere in the app reads `get_current_user_id` yet.
