# Hosting ScAI-Reader as a public demo

This document explains the **self-hosted deployment** feature: running ScAI-Reader
on a machine you control as a public, shareable demo, with AI explanations
served by a local [Ollama](https://ollama.com/) model so there are **no
per-call API costs**.

It covers what the feature does, how it's wired, how to deploy it, and the
trade-offs to be aware of.

---

## What this feature gives you

- **One-command deploy** of the whole app (frontend + backend) in a container.
- **Local AI** via an Ollama sidecar — everyone shares one model the server
  owns; visitors never need (or see) an API key, and you pay nothing per call.
- **Per-visitor isolation** — every visitor gets their own library and
  highlights via an anonymous cookie session. No login, no sign-up.
- **A usage cap** — 50 highlights per document per visitor, to bound load on
  the shared model.

It is deliberately a **zero-friction public demo**, not a full multi-tenant
SaaS — see [Limitations](#limitations--whats-not-included).

---

## Architecture

```
                            ┌─────────────────────────────┐
   Browser ──HTTP(S)──►     │  app  (Docker container)     │
   (cookie: scai_session)   │   FastAPI + built SPA        │
                            │   pypdfium2 render, SQLite   │
                            └──────────────┬──────────────┘
                                           │ OpenAI-compatible API
                                           │ http://ollama:11434/v1
                            ┌──────────────▼──────────────┐
                            │  ollama  (Docker container)  │
                            │   one shared local model     │
                            └─────────────────────────────┘

   Volumes:  scai-data  → /data  (reader.db, uploaded PDFs, render cache)
             ollama-models → pulled model weights
```

- The **app** container serves the API and the built single-page frontend on
  one port (8000), same-origin — no CORS or proxy needed in production.
- The **ollama** container runs the model. The app talks to it over Ollama's
  OpenAI-compatible endpoint, so no Ollama-specific code is required.
- Both containers' state lives in named volumes, so data and model weights
  survive restarts and rebuilds.

Relevant files: [`Dockerfile`](../Dockerfile),
[`docker-compose.yml`](../docker-compose.yml).

---

## Quick start

On a server with Docker + Docker Compose installed:

```bash
git clone https://github.com/Adhvith-Reddy1/ScAI-Reader.git
cd ScAI-Reader

# Build and start the app + Ollama.
docker compose up -d --build

# Pull the model the app is configured to use (default: llama3.1).
docker compose exec ollama ollama pull llama3.1
```

The app is now on **http://<server>:8000**. For a real domain, put a
TLS-terminating reverse proxy in front of port 8000 (see [TLS](#tls--a-real-domain)).

---

## Configuration

Set these as environment variables on the `app` service (e.g. in a `.env` file
next to `docker-compose.yml`, or edit the compose file directly).

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_MODEL` | `llama3.1` | Model the app uses. **Pull the same name** with `ollama pull`. |
| `OPENAI_BASE_URL` | `http://ollama:11434/v1` | Where the AI layer sends requests. Points at the Ollama sidecar. |
| `OPENAI_API_KEY` | `ollama` | Ollama ignores it, but the OpenAI client needs a non-empty value. |
| `PDF_READER_DATA_DIR` | `/data` | On-disk root for `reader.db`, uploaded PDFs, and the render cache. |

How the AI wiring works: when `OPENAI_API_KEY` is set **and** `OPENAI_BASE_URL`
is present, the backend resolves the provider to `openai_compatible` with that
base URL and `OPENAI_MODEL` (see `app/ai.py::get_provider_config`). An
environment-provided key always wins over any in-app setting, and the in-app
"AI Setup" key editor is disabled — so the shared model can't be changed from
the browser.

### Choosing a model

- **Term/sentence explanations** work with any text model (e.g. `llama3.1`,
  `mistral`, `qwen2.5`).
- **Figure explanations** send the page image, so they need a **vision-capable**
  model such as `llama3.2-vision`. With a text-only model, figure explanations
  will fail while everything else works.

### GPU acceleration

On CPU, explanations work but can take several seconds. To use a GPU, install
the NVIDIA Container Toolkit on the host and uncomment the `deploy:` block under
the `ollama` service in `docker-compose.yml`.

---

## Per-visitor isolation

A hosted instance is shared by strangers, so each visitor's data is scoped to an
anonymous session — no accounts required.

- **Session cookie.** A `@app.middleware("http")` handler issues an httpOnly
  `scai_session` cookie (random token) on a visitor's first request and reuses
  it thereafter. The `get_session_id` dependency exposes it to routes.
- **Library scoping.** A `document_sessions` table records which session
  uploaded which document. `GET /documents` joins on it, so a visitor sees only
  their own uploads. PDFs themselves are still de-duplicated by SHA-256 content
  hash under the hood (two visitors uploading the same paper share one stored
  file) — only the *library view* is per-session.
- **Annotation scoping.** `annotations` carries a `session_id`. Creating,
  listing, and deleting highlights are all filtered to the current session, so
  visitors can't see or delete each other's highlights.
- **Legacy data.** Rows with a `NULL` `session_id` (created before this feature)
  remain visible to everyone, so existing local highlights aren't lost after an
  upgrade. Fresh hosted databases never have such rows.

Because documents are addressed by an unguessable content hash, the raw
page/text/render endpoints aren't separately gated — knowing the hash means you
already have the file. The isolation that matters (library enumeration and
private highlights) is enforced.

---

## Highlight cap

To keep any one visitor from overloading the shared model:

- **50 highlights per document, per visitor.** Enforced in
  `POST /documents/{id}/annotations`; the 51st returns HTTP `429` with a clear
  message, and the reader sees a toast. The cap is independent per session, so
  one heavy user doesn't affect others.

Change the number via `HIGHLIGHTS_PER_DOC_LIMIT` in
`app/routes/annotations.py`.

---

## Persistence & backups

- `scai-data` volume holds `reader.db` (documents, annotations, explanation
  cache, search index), uploaded PDFs, and the render cache.
- `ollama-models` holds the downloaded model weights.

Back up the database by copying it out of the volume:

```bash
docker compose cp app:/data/reader.db ./reader-backup.db
```

---

## TLS & a real domain

Expose port 8000 directly only for a quick demo. For a real URL, run a reverse
proxy that terminates TLS and forwards to the app. Example with
[Caddy](https://caddyserver.com/) (automatic HTTPS):

```
reader.example.com {
    reverse_proxy localhost:8000
}
```

(nginx or Traefik work equally well.)

---

## Operations

```bash
# Logs
docker compose logs -f app
docker compose logs -f ollama

# Update to the latest code
git pull && docker compose up -d --build

# Swap the model
#   1. set OLLAMA_MODEL=<new-model>
#   2. docker compose exec ollama ollama pull <new-model>
#   3. docker compose up -d
```

---

## Testing

Backend isolation and cap behaviour are covered in
`backend/tests/integration/test_sessions.py`:

- per-session library separation,
- per-session annotation visibility,
- cross-session delete is denied,
- the cap triggers on the 51st highlight,
- the cap is independent per session.

The env-based Ollama wiring is covered in `backend/tests/unit/test_ai.py`
(`test_openai_env_with_base_url_is_compatible`). Run everything with
`./scripts/ci.sh`.

---

## Limitations & what's not included

- **No named accounts.** Sessions are anonymous and cookie-bound, so a visitor's
  library doesn't follow them across browsers or devices, and clearing cookies
  starts fresh. Named sign-ups, cross-device sync, and per-user API keys are a
  future multi-tenant phase.
- **Single instance.** SQLite + a global PDFium lock + one Ollama model suit
  demo-scale traffic on one box. Horizontal scaling would need Postgres, shared
  object storage for PDFs, and a separately scaled inference tier.
- **Model resourcing.** Ollama needs real RAM (a GPU ideally). On a small CPU
  box, explanations are slow.
- **Figure explanations** require a vision-capable model (see
  [Choosing a model](#choosing-a-model)).
