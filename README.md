# ScAI-Reader

A Python PDF reader, written from scratch — eventually. **Phase 1 ships a working web viewer** (FastAPI backend + TypeScript/Vite frontend) backed by `pypdfium2` (the same PDFium engine Chrome and Edge use). Future phases progressively replace pieces of the backend with from-scratch implementations, validated against the same contract test suite.

Plan: [`/Users/areddy/.claude/plans/i-want-to-build-snoopy-hippo.md`](../.claude/plans/i-want-to-build-snoopy-hippo.md)

## Run it

```bash
# Backend
cd backend
python3.12 -m venv .venv
.venv/bin/pip install -e ".[test]"
.venv/bin/uvicorn app.main:app --reload --port 8000

# Frontend (separate shell)
cd frontend
npm install
npm run dev     # http://localhost:5173
```

The Vite dev server proxies `/documents` and `/healthz` to the backend on `:8000`.

## Run the tests

```bash
./scripts/ci.sh                           # everything
cd backend && .venv/bin/pytest            # backend only
cd backend && .venv/bin/pytest --update-goldens   # refresh visual goldens
```

42 tests across four layers — see Testing below.

## Architecture

```
Browser ◄──── HTTP ────► FastAPI ────► PdfBackend (interface)
                            │                │
                            ▼                ▼
                         SQLite     PdfiumBackend (v1, pypdfium2)
                                            │
                                            └─► (future) CustomBackend
                                                tokenizer → renderer
```

Everything touching PDF internals goes through `app.pdf.backend.PdfBackend`. The single most important file in the repo is `backend/tests/contract/test_backend_contract.py` — it parametrizes over every backend implementation and locks behavior, so the hybrid replacement path stays honest.

## Testing — no human in the loop

| Layer | Where | What it asserts |
|---|---|---|
| Unit | `backend/tests/unit/`, `frontend/src/*.test.ts` (later) | Pure logic |
| Contract | `backend/tests/contract/test_backend_contract.py` | The `PdfBackend` interface spec — runs against every backend |
| Visual golden | `backend/tests/contract/test_visual_goldens.py` + `tests/goldens/` | Rendered PNGs match committed baselines via SHA-256 → pixel-perfect → SSIM ladder |
| Integration | `backend/tests/integration/` | Full FastAPI stack via TestClient with isolated tmp dirs |
| (Phase 5+) E2E | Playwright | Browser-driven user flows |
| (Phase 7) Perf | pytest-benchmark | Latency thresholds |
| (Phase 7) Fuzz | nightly | Crash/hang/leak detection on bad-PDF corpus |

Goldens are regenerated explicitly with `pytest --update-goldens` — drift is never silent.

## Phase 1 status: complete

- [x] `PdfBackend` abstract interface + types
- [x] `PdfiumBackend` implementation (page_count, metadata, render_page, get_page_text, get_outline)
- [x] SQLite storage + SHA-256-keyed file cache + render cache
- [x] FastAPI routes: `POST /documents`, `GET /documents`, `GET /documents/{id}`, `GET /documents/{id}/pages/{n}.png?dpi=…`, `GET /healthz`
- [x] Minimal frontend: upload PDF, view all pages
- [x] Contract suite (14 tests), visual goldens (8 tests, 12 PNGs), integration (10 tests), unit (10 tests)
- [x] CI script that runs everything

Next: Phase 2 — virtualized scroll + zoom + multi-page navigation.
