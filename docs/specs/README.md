# ScAI-Reader — Hosting & Browser-Storage Migration Specs

This directory contains **implementation specs designed to be worked on in
parallel**, each on its own branch / session. Read this overview first — it
defines the target architecture, the **shared contracts** every spec depends
on, the dependency order, and the conventions all branches must follow.

> Phase 1 (OpenRouter env config + graceful rate-limit handling) is **already
> merged**. These specs are everything else.

---

## Target architecture (what we're building toward)

A **stateless server** that renders PDFs, extracts text, searches, and proxies
AI — but **persists nothing personal**. Each user's personal data (their PDFs,
highlights, and AI explanations) lives in **their own browser** (IndexedDB).

- **No auth, no per-user identity.** Privacy is *structural*: each browser only
  ever holds its own data, and the server keeps nothing, so there is nothing to
  leak between users.
- **Hosting:** Fly.io, **single machine, no persistent disk.** The server's
  on-disk state (uploaded PDF + render cache) is ephemeral and may vanish on
  restart — that's fine, because the browser re-supplies the PDF each session.
- **Re-render every session** (we accepted the latency; no shared cache).
- **AI:** the server holds one OpenRouter key and serves free models
  (`OPENROUTER_MODEL=openrouter/free`) to everyone, unmetered for now.

```
 Browser (IndexedDB = source of truth)        Fly machine (stateless worker)
 ├─ documents (PDF bytes + meta)   ──upload──► render pages / extract text /
 ├─ annotations (highlights)                   search / figure detect / AI proxy
 ├─ explanations (AI cache)        ◄──stream── (keeps nothing personal;
 └─ viewState (page/zoom)                       PDF held only ephemerally)
```

### Why this shape
The server must exist for rendering (native `pypdfium2`), search, and to hold
the AI key (a key can never ship to the browser). The browser holds the
durable personal data. See the conversation/architecture notes if you need the
fuller rationale.

---

## Dependency graph & waves

```
WAVE 1 (start in parallel — no shared files):
  01-deployment-fly          (new files only: Dockerfile, fly.toml, …)
  02-browser-storage-foundation  (new files only: frontend/src/storage/*)
  03-backend-stateless-ai    (backend only; ADDITIVE, non-breaking)

WAVE 2 (start once 02 is merged; 06 also needs 03):
  04-frontend-library        (consumes storage contract)
  05-frontend-highlights     (consumes storage contract)
  06-frontend-explanations   (consumes storage contract + backend AI contract)

WAVE 3 (after 03–06 merged):
  07-cleanup-and-docs        (delete dead server persistence, update README, full E2E)
```

**Why this split is parallel-safe:** 01/02/03 touch disjoint file sets. 03 is
*additive* (adds new endpoints, deletes nothing) so it never breaks `main`
while frontend work is in flight. 04/05/06 each own a different store/UI area;
their only shared touch-points are `frontend/src/main.ts` and
`frontend/src/api.ts` — see **Conflict map** below.

---

## Shared contract A — the local store (owned by Spec 02)

Spec 02 creates `frontend/src/storage/localStore.ts` exporting this interface.
**Specs 04/05/06 import it; they do not redefine it.** Freeze these signatures.

```ts
// frontend/src/storage/localStore.ts
export interface LocalDocument {
  id: string;            // sha-256 of the file bytes (same id the server uses)
  filename: string;
  page_count: number;
  title: string | null;
  author: string | null;
  size_bytes: number;
  added_at: string;      // ISO
  blob: Blob;            // the PDF bytes
}
export interface LocalAnnotation {
  id: string;            // client-generated (crypto.randomUUID)
  docId: string;
  page: number;
  kind: "highlight";
  color: HighlightColor;
  rects: Rect[];
  text: string | null;
  explain: boolean;
  created_at: string;
}
export interface LocalExplanation {
  docId: string;
  annotationId: string;
  kind: ExplanationKind;
  text: string;          // the highlighted text it was generated for
  content: string;
  status: "complete";
  updated_at: string;
}
export interface ViewState {
  docId: string;
  lastPage: number;
  zoom: number;
  sidebarOpen: boolean;
}

// Documents
export function putDocument(doc: LocalDocument): Promise<void>;
export function getDocument(id: string): Promise<LocalDocument | null>;
export function listDocuments(): Promise<Omit<LocalDocument, "blob">[]>; // meta only, no blobs
export function deleteDocument(id: string): Promise<void>;               // cascades: annotations + explanations + viewState

// Annotations
export function putAnnotation(a: LocalAnnotation): Promise<void>;
export function listAnnotations(docId: string, page?: number): Promise<LocalAnnotation[]>;
export function deleteAnnotation(docId: string, id: string): Promise<void>;

// Explanations (keyed by [docId, annotationId])
export function putExplanation(e: LocalExplanation): Promise<void>;
export function getExplanation(docId: string, annotationId: string): Promise<LocalExplanation | null>;

// View state
export function getViewState(docId: string): Promise<ViewState | null>;
export function putViewState(vs: ViewState): Promise<void>;

// Storage health (used by Spec 04 to warn near quota)
export function estimateUsage(): Promise<{ usageBytes: number; quotaBytes: number } | null>;
```

`Rect`, `HighlightColor`, `ExplanationKind` are already exported from
`frontend/src/api.ts` — import them, don't duplicate.

## Shared contract B — stateless AI endpoints (owned by Spec 03)

Spec 03 ADDS these. They take the highlighted text + page reference and stream
the same SSE wire format the current endpoints use
(`{type:"meta"|"delta"|"done"|"error", ...}`), but **persist nothing**. The
server extracts page text itself from the PDF that this session already
uploaded (present in the ephemeral cache), so the client need not send page
text.

```
POST /documents/{doc_id}/ai/explain      body: { text, kind? }            → SSE
POST /documents/{doc_id}/ai/chat         body: { text, kind, content, messages[] }  → SSE
POST /documents/{doc_id}/ai/refine       body: { text, kind, content, messages[] }  → SSE
POST /documents/{doc_id}/figures/{figure_id}/ai-explain  body: { page, label }      → SSE
```

The existing annotation-scoped endpoints stay until Spec 07 deletes them.

---

## Conflict map (read before editing shared files)

| File | Touched by | Rule |
|---|---|---|
| `frontend/src/api.ts` | 04, 05, 06 | Each adds/edits only the functions it owns (04: document/library calls; 05: nothing — highlights leave the network entirely; 06: AI stream functions → new endpoints). Add new functions; avoid reordering existing ones. |
| `frontend/src/main.ts` | 04, 05, 06 | The wiring file. Keep edits localized to your feature's init block; expect a small manual merge. Land 04 first if possible. |
| `backend/app/routes/*` | 03 only | Wave-1/2 frontend specs must not edit backend routes. |

If two specs would fight over the same lines in `main.ts`, prefer landing them
sequentially (04 → 05 → 06) over true-simultaneous.

---

## Conventions (every branch follows these)

- **Branch name:** `feat/<spec-number>-<slug>` (e.g. `feat/02-browser-storage`).
- **Base off** the latest `claude/jolly-ptolemy-j4otxt` (which has Phase 1).
- **Keep `main` green:** the app must build (`cd frontend && npm run build`) and
  the smoke test must pass at the end of every branch.
- **Tests are required, not optional:**
  - Backend: `cd backend && .venv/bin/pytest` (add unit/integration tests for new endpoints).
  - Frontend units: `cd frontend && npm test` (Vitest; use `fake-indexeddb` for storage tests).
  - Browser E2E: `cd frontend && npx playwright test` (Playwright config + smoke test already exist).
- **Browser-stored behavior MUST be verified with Playwright**, not just unit
  tests — persistence across reload can only be proven in a real browser.
- **Don't break the no-AI path:** highlights, outline, find-in-page must keep
  working with no provider configured.
- Setup once per fresh checkout: `./scripts/setup.sh --dev`.

## Definition of done (per spec)
1. Acceptance criteria in the spec all pass.
2. New tests added and the full relevant suite is green.
3. App builds; Playwright smoke test passes.
4. No edits outside the spec's declared scope (except the documented shared files).

---

# Phase 2 — Accounts, analytics, sync

Phase 1 (Specs 01–07 above) made the server stateless with a persistent
content cache, then added a daily AI-usage quota keyed by an anonymous
per-browser `client_id` (`frontend/src/clientId.ts`, `backend/app/quota.py`,
header `X-Client-Id`) with a bring-your-own-key fallback. **Every Phase 2
spec below depends on that quota/BYO-key work being merged to `main` first**
— they all reuse the `client_id` convention rather than reinventing an
anonymous identity.

Phase 2's goal: optional sign-in (never required), aggregate usage
analytics with a dashboard to view them, and the one feature actually worth
signing up for — cross-device sync.

## Dependency graph & waves

```
WAVE 1 (start in parallel — independent, both build on X-Client-Id):
  08-optional-accounts       (Google OAuth, sessions, links client_id -> account)
  09-usage-analytics         (event tracking: highlights, explanation ratio, sessions)

WAVE 2 (each depends on exactly one Wave-1 spec; the two Wave-2 specs are
        independent of EACH OTHER, so 10 can start once 09 merges even if
        08/11 aren't done yet, and vice versa):
  10-usage-dashboard         (depends on 09 — reads usage_events + ai_usage)
  11-cross-device-sync       (depends on 08 — reads auth.get_current_user_id)

WAVE 3 (after both 08 and 11 merged):
  12-signup-nudge            (needs the sign-in entry point AND a real
                               feature — sync — to honestly promise)
```

**Why this split is parallel-safe:** 08 and 09 touch disjoint tables/routes
(`users`/`client_links`/`auth.py` vs. `usage_events`/`analytics.py`) and
only share the read-only `X-Client-Id` header convention already frozen in
Phase 1 — no coordination needed between them. 10 and 11 each depend on
exactly one Wave-1 spec and don't touch each other's files, so once their
respective prerequisite lands they can run concurrently with each other.
12 is intentionally last: it's UI/copy only, but it depends on both an
entry point (08) and a true feature to point to (11).

## Shared Contract D — auth (owned by Spec 08)

```
GET  /auth/me                -> { signedIn: boolean, email: string | null }
GET  /auth/google/start      (redirect to Google)
GET  /auth/google/callback   (redirect back to "/"; sets scai_session cookie)
POST /auth/logout            -> { signedIn: false }
```
Backend: `auth.get_current_user_id(request) -> str | None` — later specs
import this, they don't parse the session cookie themselves. Frontend:
`getAccountStatus(): Promise<{signedIn, email}>` in `api.ts`.

## Shared "contract" — usage events (owned by Spec 09)

Not a frozen API in the same sense (nothing outside Spec 10 calls it), but
Spec 10 depends on this exact shape, so treat it as frozen once 09 merges:

```
POST /analytics/event   body: { event_type, doc_id?, kind? }   -> 204
```
`event_type` ∈ `{highlight_created, explanation_viewed, session_start}`.
Table: `usage_events(id, client_id, doc_id, event_type, kind, occurred_at)`.
**Never** put highlighted text, explanation content, or page text in this
table — see the privacy-boundary note in Spec 09 itself.

## Conflict map addendum (Phase 2)

| File | Touched by | Rule |
|---|---|---|
| `frontend/src/main.ts` | 08, 12 | 08 adds the account nav button; 12 adds the nudge trigger. Land 08 first. |
| `frontend/src/api.ts` | 08, 09, 11 | Each adds only the functions it owns (08: `getAccountStatus`; 09: `trackEvent`; 11: `syncAnnotations*`). Add new functions; avoid reordering. |
| Highlight-creation call site (`highlightMode.ts`/`HighlightButton.ts`) | 09, 12 | 09 adds the `highlight_created` tracking call; 12 piggybacks on the same call site for its counter rather than adding a second hook. Land 09 first. |
| `backend/app/storage/db.py` | 08, 09, 11 | Each spec adds its own new `CREATE TABLE IF NOT EXISTS` block; don't touch another spec's tables. |

## Conventions (Phase 2 additions)
- **Base off** the latest `main` (once the quota/BYO-key work has merged).
- Everything else in the Conventions section above still applies
  (branch naming, green-main requirement, test requirements, Definition of
  done).
