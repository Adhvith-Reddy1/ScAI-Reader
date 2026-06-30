# Spec 01 — Deployment: Docker + Fly.io

**Branch:** `feat/01-deployment` · **Wave:** 1 (fully independent) ·
**Depends on:** nothing · **Conflicts with:** nothing (new files only)

## Goal
Make the app deployable to Fly.io as a **single, stateless machine with no
persistent disk**, serving AI from an OpenRouter key. Produce the packaging and
platform config; do **not** change application code.

## Context
- The single-server app is `uvicorn app.main:app`; `main.py` already serves the
  built frontend from `frontend/dist` at `/` and exposes `GET /healthz`.
- Backend needs Python 3.12+ and the native `pypdfium2` wheel (Linux is fine).
- Frontend builds with `cd frontend && npm run build` → `frontend/dist`.
- AI config via env (Phase 1, already merged): set `OPENROUTER_API_KEY` and
  `OPENROUTER_MODEL=openrouter/free`.
- We deliberately use **no volume** (re-render each session; data lives in the
  browser per the migration).

## Scope
**In:**
- `Dockerfile` (repo root) — multi-stage:
  1. **Node stage** (`node:22-slim`): `npm ci` in `frontend/`, `npm run build`.
  2. **Python stage** (`python:3.12-slim`): install backend (`pip install
     ./backend`), copy the built `frontend/dist` to the path `main.py` expects
     (`<repo>/frontend/dist`), copy `backend/`. Entrypoint:
     `uvicorn app.main:app --host 0.0.0.0 --port 8080`.
- `.dockerignore` — exclude `.venv`, `node_modules`, `frontend/dist` (rebuilt in
  image), `backend/data`, `.git`, test artifacts, `*.pdf` fixtures if large.
- `fly.toml` — app config: internal port 8080, `force_https = true`,
  `auto_stop_machines`/`auto_start_machines` as desired, **`min_machines_running`
  and max pinned to 1** (single instance — there is shared in-process/ephemeral
  state and we never want a second machine), `[checks]` HTTP GET `/healthz`.
- `docs/DEPLOY.md` — plain-language steps: install flyctl, `fly launch --no-deploy`,
  set secrets (`fly secrets set OPENROUTER_API_KEY=… OPENROUTER_MODEL=openrouter/free`),
  `fly deploy`, how to view logs, how to roll back. Note that there is **no
  volume** and why (browser holds the data).
- Confirm `PORT`/bind: the image listens on 8080 and `fly.toml` maps it.

**Out:** any change under `backend/app` or `frontend/src`; auth; volumes;
CI pipeline (separate effort).

## Implementation notes
- Keep the image small: don't install backend `[test]` extras in the runtime
  stage.
- `upload_max_bytes` is 200 MB (see `config.py`); ensure no proxy/body-size
  limit in `fly.toml` blocks large PDFs (Fly default is fine, just don't set a
  smaller limit).
- SSE: do not enable any response buffering; Fly's proxy streams fine by default.
- The data dir defaults to `./data` relative to CWD; in the container set CWD so
  it lands somewhere writable (e.g. `/app/backend`). Ephemeral is intended.

## Testing / verification
- **Build the image locally:** `docker build -t scai .` and run
  `docker run -p 8080:8080 scai`; confirm `curl localhost:8080/healthz` → `{"ok":true}`
  and the SPA loads.
- **Playwright against the container:** run the existing smoke test with
  `E2E_PORT=8080` and `reuseExistingServer` pointed at the container (or add a
  one-off check) to prove the packaged build renders the reader shell.
- Document the exact `fly deploy` output expectations in `docs/DEPLOY.md`.

## Acceptance criteria
- [ ] `docker build` succeeds from a clean checkout.
- [ ] Container serves `/healthz` and the SPA on 8080.
- [ ] `fly.toml` pins a single machine, no volume, https, `/healthz` check.
- [ ] `docs/DEPLOY.md` lets a non-expert deploy by following steps.
- [ ] No files under `backend/app` or `frontend/src` changed.
