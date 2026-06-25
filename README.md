# ScAI-Reader

**An AI-augmented PDF reader for academic papers.** FastAPI backend + TypeScript/Vite frontend, `pypdfium2` for rendering, Claude wired in for in-context understanding. The goal is to keep you *in* the paper: instead of bouncing to Google every time an unfamiliar term or a dense passage shows up, the model answers in a tooltip from inside the document, with the full paper as context.

## What it does today

- **Library + persistent state** — uploads keyed by SHA-256; highlights and AI explanations survive close/reopen and re-uploads.
- **Five-color highlight palette** with column-aware drag selection, zoom anchoring, and an erase mode.
- **Outline sidebar** — closable tabbed shell driven by the PDF's own outline.
- **Find-in-page** — Cmd-F bar with prev/next navigation across loaded pages (SQLite FTS5 on the backend).
- **AI hover explanations on blue highlights:**
  - Highlight a short term → Claude Sonnet 4.6 returns a tight definition (term first, then a clause of paper-specific context only if needed).
  - Highlight a sentence → Claude Opus 4.7 returns a two-sentence plain-language restatement.
  - Routing is server-side: a word-count + terminal-punctuation heuristic picks definition vs. explanation.
  - Streamed over SSE so the tooltip fills in live; cached in SQLite so every later hover is free (zero LLM calls).
  - The PDF is sent with `cache_control: ephemeral`, so prompt caching makes the 2nd+ call per document cheap.

## Run it (local)

**Prerequisites:** Python 3.12+ and Node.js 18+.

**Easiest — one command** (installs, builds, and tells you how to start):

```bash
curl -fsSL https://raw.githubusercontent.com/Adhvith-Reddy1/ScAI-Reader/main/scripts/install.sh | bash
```

**Or from a clone:**

```bash
git clone https://github.com/Adhvith-Reddy1/ScAI-Reader.git && cd ScAI-Reader
./scripts/run.sh
```

On first launch `run.sh` creates the Python venv, installs the backend and
frontend dependencies, and builds the frontend. Then it starts a single local
server and opens **http://localhost:8000** in your browser automatically. Stop
with Ctrl-C; later launches skip straight to starting (rebuilding the frontend
only if its sources changed). Use a different port with `PORT=9000 ./scripts/run.sh`,
or skip the auto-open with `NO_OPEN=1`.

### Turning on AI explanations

The AI features (hover explanations, figure walkthroughs) need an LLM provider.
**Everything else — highlights, outline, find-in-page — works without one.**

You don't need the command line: click **AI** in the top bar (or the first-run
banner), pick your provider, paste a key, and Save. The key is verified, then
stored locally on the backend. Until then, AI tooltips show a friendly "Set up
AI" prompt instead of an error. Supported:

- **Anthropic (Claude)** — key from [console.anthropic.com](https://console.anthropic.com/settings/keys).
- **OpenAI (GPT)** — key from [platform.openai.com](https://platform.openai.com/api-keys).
- **OpenRouter** — key from [openrouter.ai/keys](https://openrouter.ai/keys);
  one key, hundreds of models. Base URL is filled in for you.
- **OpenAI-compatible** — any other endpoint that speaks the OpenAI API: Groq,
  Together, Azure OpenAI, or **local models** via Ollama / LM Studio. Enter the
  base URL (e.g. `http://localhost:11434/v1`) and a model name.

Each path sends only the relevant page's text (plus the page image for figures)
to the provider — never the whole PDF — so behaviour is consistent across
providers. Usage is billed to your own provider account.

Advanced/hosted setups can instead export `ANTHROPIC_API_KEY` or
`OPENAI_API_KEY` (the latter honours `OPENAI_BASE_URL`); an environment key
always takes precedence and is managed outside the app.

### Dev mode (hot reload, two servers)

For active frontend work you may prefer Vite's hot-reload dev server:

```bash
./scripts/setup.sh --dev          # one-time: venv + deps + test toolchain

# Backend (shell 1)
cd backend && .venv/bin/uvicorn app.main:app --reload --port 8000
# Frontend (shell 2)
cd frontend && npm run dev        # http://localhost:5173
```

The Vite dev server proxies `/documents` and `/healthz` to the backend on
`:8000`. (The single-server `run.sh` path needs no proxy — the API and SPA
are same-origin.)

## Architecture

```
                          Anthropic API
                              ▲
                              │ messages.stream (SSE)
                              │ PDF + cache_control=ephemeral
                              │
Browser ◄──── HTTP ────► FastAPI ────► PdfiumBackend (pypdfium2)
                              │
                              ▼
                            SQLite
                            ├── documents       (SHA-256 keyed)
                            ├── annotations      (highlights)
                            ├── explanations     (AI cache, FK→annotation)
                            ├── page_dimensions  (zoom/layout)
                            └── pages_fts         (find-in-page, FTS5)
```

PDF internals go through `app.pdf.backend.PdfBackend` so an alternate backend can slot in behind the same contract tests.

### Key flow: blue highlight → AI explanation

1. Drag-select in blue mode. `PageView.maybeAutoSaveHighlight` captures the selection text and `POST`s the highlight (`color: blue` + text).
2. On success it fires `POST /documents/{id}/annotations/{ann_id}/explain`. The server classifies definition vs. explanation, opens a stream to Claude with the PDF attached, and relays tokens as `data: {"type":"delta",...}` SSE frames.
3. On `done`, the server writes `status="complete"` + the text into `explanations`.
4. Hovering for 200ms anchors a tooltip above the highlight. Its content is pre-seeded into `explanationStore` from the inline `explanation` field on `GET /annotations` — so reopens cost zero LLM calls and zero extra requests.

## Tests

```bash
./scripts/ci.sh                                    # everything
cd backend && .venv/bin/pytest                     # backend
cd backend && .venv/bin/pytest --update-goldens    # refresh visual goldens
cd frontend && npm test                            # vitest
```

| Layer | Where | Asserts |
|---|---|---|
| Unit (backend) | `backend/tests/unit/` | Column detection, outline tree, storage paths |
| Unit (frontend) | `frontend/src/**/*.test.ts` | Selection geometry, coord transforms, sidebar/highlight/erase/find state |
| Contract | `backend/tests/contract/test_backend_contract.py` | The `PdfBackend` interface spec, run against every backend |
| Visual golden | `backend/tests/contract/test_visual_goldens.py` | Rendered PNGs vs. baselines (SHA-256 → pixel → SSIM ladder) |
| Integration | `backend/tests/integration/` | FastAPI stack: annotations, documents, search, outline, concurrent renders |

The AI path is not yet covered end-to-end (would need a live key in CI). The classifier heuristic, SSE framing, and persistence are each testable in isolation and worth adding.

## Configuration

The AI provider is normally set in-app (see "Turning on AI explanations"); it's
stored at `<data dir>/ai_config.json`. The env vars below are optional overrides
for advanced/hosted use and always win over the stored config.

| Env var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | If set, selects Anthropic and turns AI on; managed outside the app (in-app setter disabled). |
| `OPENAI_API_KEY` | If set (and no Anthropic key), selects OpenAI. Honours `OPENAI_BASE_URL` for OpenAI-compatible endpoints. |
| `PDF_READER_DATA_DIR` | On-disk root for `reader.db`, uploaded PDFs, the render cache, and `ai_config.json`. Defaults to `./data`. |

## Roadmap

- **Figure explanations** — double-click a figure → concise AI walkthrough (next up; under design).
- Methods-aware explanations that pull in the relevant methods section.
- Automated coverage for the AI explanation path.
