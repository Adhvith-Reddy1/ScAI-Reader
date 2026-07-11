# Spec 10 — Usage dashboard

**Branch:** `feat/10-usage-dashboard` · **Wave:** 2 (Phase 2) · **Depends
on:** Spec 09 merged (reads `usage_events`; also reads the existing
`ai_usage` table from the quota work). **Conflicts with:** nothing — new
route file only.

## Goal
A simple, owner-only page showing: highlights per doc, definition-vs-
explanation ratio, active-client counts over time, and AI-quota pressure
(how many clients hit their daily limit). Self-built, matching the app's
"we don't ship your data to a third party" posture — no PostHog/GA, just a
SQL aggregation and a plain HTML page.

## Scope
**In:**
- **Access control:** there's no admin-role concept yet (that's a bigger
  feature than this spec needs). Gate behind a shared secret:
  `ADMIN_DASHBOARD_TOKEN` env var, checked against a `?token=` query param
  or `Authorization: Bearer` header. Return **404** (not 401) on a
  missing/wrong token — don't reveal the route exists. Document in
  `.env.example` and `docs/DEPLOY.md`. If the env var is unset, the whole
  route 404s unconditionally (fail closed, not open).
- **`backend/app/routes/dashboard.py`**:
  - `GET /dashboard/stats?days=30` — JSON aggregates:
    - distinct `client_id` count, and active-in-last-24h/7d/30d (via
      `occurred_at` recency on `usage_events`)
    - `highlight_created` count grouped by `doc_id`, top 20
    - `explanation_viewed` count grouped by `kind` (the definition:explanation
      ratio the user asked for)
    - from `ai_usage` (already exists, Phase 1): total AI calls in range,
      distinct clients who hit their daily limit at least once
  - `GET /dashboard` — a single dependency-free HTML/JS string served
    directly from the route (no Vite build involvement, no new frontend
    package). It fetches `/dashboard/stats` and renders a few numbers plus
    a small table. Deliberately plain — this is an internal tool.
- Reasonable default range (`days=30`) with the query override; validate
  `days` is a small positive int to avoid a pathological scan.

**Out:** any per-client drill-down. Keep this aggregate-only — the point is
trends, not being able to look up what one anonymous browser did. Don't add
a "search by client_id" feature here even if it seems convenient.

## Testing
- Backend: seed `usage_events`/`ai_usage` rows directly in a test DB and
  assert `GET /dashboard/stats`'s JSON shape and numbers; assert `GET
  /dashboard*` 404s with no/wrong token and with `ADMIN_DASHBOARD_TOKEN`
  unset.
- No Playwright needed (internal tool, no build pipeline to verify).

## Acceptance criteria
- [ ] `/dashboard` and `/dashboard/stats` 404 without a valid token, and
      404 unconditionally when `ADMIN_DASHBOARD_TOKEN` is unset.
- [ ] Aggregates match hand-seeded fixture data exactly.
- [ ] Nothing in this spec writes to the database (read-only route).
- [ ] No per-client_id lookup surface exists in the UI or API.
