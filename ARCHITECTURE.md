# ScAI-Reader — Architecture Deep Dive

> A from-scratch walkthrough of the entire system: every service, process, data
> structure, and the flows that tie them together. If you've never opened the
> code, read this top to bottom — it's written to take you from zero to being
> able to reason about any part of the app.
>
> Companion docs: [`README.md`](README.md) (quick start) and
> [`HANDOFF.md`](HANDOFF.md) (chronological build log of *why* each piece exists).

---

## Table of contents

1. [What the app is, in one paragraph](#1-what-the-app-is-in-one-paragraph)
2. [The mental model](#2-the-mental-model)
3. [Tech stack & repository layout](#3-tech-stack--repository-layout)
4. [The 30,000-foot picture](#4-the-30000-foot-picture)
5. [Backend, service by service](#5-backend-service-by-service)
6. [The AI explanation subsystem (the heart of the app)](#6-the-ai-explanation-subsystem-the-heart-of-the-app)
7. [Frontend, module by module](#7-frontend-module-by-module)
8. [End-to-end flows (follow the data)](#8-end-to-end-flows-follow-the-data)
9. [Cross-cutting concerns](#9-cross-cutting-concerns)
10. [Persistence & caching layers](#10-persistence--caching-layers)
11. [Testing strategy](#11-testing-strategy)
12. [Running & configuring it](#12-running--configuring-it)
13. [Known limitations & roadmap](#13-known-limitations--roadmap)

---

## 1. What the app is, in one paragraph

ScAI-Reader is an **AI-augmented PDF reader for academic papers**. You upload a
paper, it renders every page as an image with an invisible, selectable text
layer on top (the same trick PDF.js uses). You can highlight text in five
colors, search the document, and navigate via its outline. The differentiator:
highlight something in **blue** and Claude explains it in a tooltip *without you
leaving the page* — a short definition for a term, a plain-language restatement
for a sentence — and double-clicking a **figure** gets you a concise AI
walkthrough of that figure. Everything you create (highlights, AI explanations)
is persisted and survives reloads and re-uploads.

---

## 2. The mental model

Three things will make everything else click:

1. **Documents are content-addressed.** A PDF's identity *is* the SHA-256 of its
   bytes. Upload the same file twice and you get the same `doc_id`, the same
   stored file, the same highlights. This is why "re-open" and "re-upload" are
   the same operation and why highlights never get orphaned.

2. **The backend owns all PDF intelligence; the frontend owns all interaction.**
   The browser never parses a PDF. It asks the backend for *page images*, *text
   runs with coordinates*, *the outline*, *search hits*, and *figure regions*.
   The frontend's job is to layer those on screen and turn mouse gestures into
   API calls. This split is what lets the rendering engine be swapped behind a
   contract (`PdfBackend`).

3. **AI answers stream over SSE and are cached in SQLite.** The first time you
   ask, tokens stream into the tooltip live. The result is written to SQLite, so
   every later hover — even after a reload — is a zero-LLM-call instant render.

Hold those three ideas and the rest is detail.

---

## 3. Tech stack & repository layout

**Backend** — Python 3.12, [FastAPI](https://fastapi.tiangolo.com/), rendering
via [`pypdfium2`](https://github.com/pypdfium2-team/pypdfium2) (the PDFium engine,
same one Chrome/Edge use), SQLite (incl. the FTS5 extension), and the official
`anthropic` SDK for AI.

**Frontend** — TypeScript + [Vite](https://vitejs.dev/), **zero runtime
dependencies** — it's hand-written DOM, SVG, and the Fetch/Streams APIs.
Tested with Vitest + jsdom.

```
ScAI-Reader/
├── README.md                 # quick start + feature summary
├── HANDOFF.md                # chronological "why we did X" build log
├── ARCHITECTURE.md           # ← you are here
├── Animal_farm.pdf           # a sample document used in dev
├── scripts/ci.sh             # runs the whole test+build pipeline
├── backend/
│   ├── pyproject.toml        # deps + "[test]" extra
│   └── app/
│       ├── main.py           # FastAPI app factory, CORS, router wiring, lifespan
│       ├── config.py         # Settings dataclass (paths, DPI, limits)
│       ├── pdf/
│       │   ├── backend.py        # PdfBackend ABC + PdfError (the contract)
│       │   ├── pdfium_backend.py # the concrete pypdfium2 implementation
│       │   ├── types.py          # BBox, TextRun, TextColumn, PageText, ...
│       │   ├── columns.py        # multi-column reading-order detection
│       │   └── figures.py        # figure-region detection from captions
│       ├── storage/
│       │   ├── db.py             # SQLite schema + connection helper
│       │   └── files.py          # SHA-256 keying, atomic writes, render cache
│       └── routes/
│           ├── deps.py           # get_settings() dependency
│           ├── documents.py      # upload / list / get / dimensions
│           ├── pages.py          # page → PNG rendering (+ disk cache)
│           ├── text.py           # page → text runs in columns
│           ├── annotations.py    # highlight CRUD
│           ├── explanations.py   # AI: explain / chat / refine (highlights)
│           ├── figures.py        # figure detection + AI figure explanations
│           ├── outline.py        # bookmarks → nested tree
│           └── search.py         # FTS5 full-text search
└── frontend/
    ├── index.html            # DOM skeleton with named "slots"
    ├── vite.config.ts        # dev server + /documents,/healthz proxy to :8000
    └── src/
        ├── main.ts           # bootstrap + global keyboard/zoom wiring
        ├── api.ts            # every backend call + the SSE reader
        ├── styles.css        # theme + layer z-order
        ├── viewer/           # the page-rendering subsystem (see §7)
        └── *.ts              # state stores + toolbar UI components (see §7)
```

---

## 4. The 30,000-foot picture

```
                                   Anthropic API
                                        ▲
                                        │  messages.stream()  → SSE tokens
                                        │  (PDF and/or page-text as context,
                                        │   cache_control: ephemeral)
                                        │
  ┌─────────────┐    HTTP / SSE   ┌─────┴───────┐   in-proc   ┌──────────────────┐
  │   Browser   │ ◄─────────────► │   FastAPI    │ ◄────────► │  PdfiumBackend   │
  │ (TS + DOM)  │                 │  (routers)   │            │   (pypdfium2)    │
  └─────────────┘                 └─────┬───────┘            └──────────────────┘
        │                               │
        │ render layers                 ▼
        │                          ┌──────────┐        ┌──────────────────────────┐
        ▼                          │  SQLite  │        │   Filesystem (DATA_DIR)  │
  page image + text layer +        │ reader.db│        │  pdfs/<sha>.pdf          │
  highlight SVG + tooltips         ├──────────┤        │  renders/<sha>/pN_dpi.png│
                                   │documents │        └──────────────────────────┘
                                   │annotations
                                   │explanations
                                   │figure_explanations
                                   │page_dimensions
                                   │pages_fts (FTS5)
                                   └──────────┘
```

**Two processes in dev:** Vite (`:5173`) serves the frontend and *proxies*
`/documents` and `/healthz` to uvicorn (`:8000`). In production, `tsc + vite
build` emits `frontend/dist`, and FastAPI serves it directly as static files
(see [§5.1](#51-app-bootstrap--mainpy)), so the whole thing runs as one server.

**Request lifecycle in brief:** the browser issues a normal HTTP request →
FastAPI routes it to a handler → the handler (a) reads/writes SQLite via the
`db.connect()` context manager and/or (b) opens the PDF through `PdfiumBackend`
behind a global lock → returns JSON, a PNG, or an SSE stream. AI endpoints
return `text/event-stream` and relay Claude's tokens frame-by-frame.

---

## 5. Backend, service by service

### 5.1 App bootstrap — `main.py`

`create_app()` is a factory that builds the FastAPI instance:

- **Lifespan** (`@asynccontextmanager lifespan`): on startup it calls
  `settings.ensure_dirs()` (creates `pdfs/`, `renders/`, the db's parent dir) and
  `db.init_db(settings.db_path)` (runs the idempotent `CREATE TABLE IF NOT
  EXISTS` schema). Nothing special on shutdown.
- **CORS**: only `http://localhost:5173` and `http://127.0.0.1:5173` are allowed
  (the Vite dev origin), all methods/headers.
- **Routers**: registers all eight routers (`documents`, `pages`, `text`,
  `annotations`, `explanations`, `figures`, `outline`, `search`).
- **`GET /healthz`** → `{"ok": true}` (also what Vite proxies for a liveness check).
- **Static serving**: if `frontend/dist` exists, it's mounted at `/` with
  `html=True`. This is the "single-binary" production mode — no separate Vite
  server needed.

`app = create_app()` at module scope is what `uvicorn app.main:app` imports.

### 5.2 Configuration — `config.py`

A single frozen dataclass, `Settings`:

| Field | Default | Meaning |
|---|---|---|
| `data_dir` | `./data` (or `$PDF_READER_DATA_DIR`) | root for everything on disk |
| `db_path` | `data_dir/reader.db` | the SQLite file |
| `pdf_dir` | `data_dir/pdfs` | stored uploads, named `<sha>.pdf` |
| `render_cache_dir` | `data_dir/renders` | cached page PNGs |
| `default_dpi` | `150` | render resolution when none requested |
| `max_dpi` | `600` | server-enforced ceiling on `?dpi=` |
| `upload_max_bytes` | `200 MB` | upload size limit |

`Settings.from_env()` builds it from `PDF_READER_DATA_DIR`; `ensure_dirs()`
creates the directory tree. It's injected everywhere via the FastAPI dependency
`get_settings()` in `deps.py`, which memoizes one instance with
`@lru_cache(maxsize=1)`. **Tests** override this via
`app.dependency_overrides[get_settings]` to point at a temp dir — that's the seam
that keeps tests hermetic.

### 5.3 The PDF abstraction — `pdf/backend.py`

`PdfBackend` is an **abstract base class** that defines the entire contract the
rest of the backend relies on. The point: the PDFium implementation is *one*
backend; a future from-scratch engine can slot in behind the same interface, and
the parametrized contract test suite (`tests/contract/`) will hold it to the same
behavior.

```python
class PdfBackend(ABC):
    @classmethod
    @abstractmethod
    def open(cls, path: Path) -> "PdfBackend": ...   # raises PdfError on bad input
    @abstractmethod
    def close(self) -> None: ...
    @abstractmethod
    def metadata(self) -> DocumentMetadata: ...
    @abstractmethod
    def page_count(self) -> int: ...
    @abstractmethod
    def page_dimensions(self, page_index: int) -> PageDimensions: ...   # points, 0-indexed
    @abstractmethod
    def render_page(self, page_index: int, dpi: int) -> bytes: ...      # PNG bytes
    @abstractmethod
    def get_page_text(self, page_index: int) -> PageText: ...
    @abstractmethod
    def get_outline(self) -> tuple[OutlineNode, ...]: ...
    # plus __enter__/__exit__ so it's usable as `with PdfiumBackend.open(p) as b:`
```

`PdfError` is the single exception type the contract promises for malformed
PDFs, out-of-range pages, or backend failures.

### 5.4 The concrete engine — `pdf/pdfium_backend.py`

`PdfiumBackend(PdfBackend)` wraps `pypdfium2`. Key behaviors:

- **Thread safety via a process-wide lock.** PDFium is *not* thread-safe, and
  FastAPI dispatches synchronous handlers onto a threadpool — so when the
  frontend fires dozens of concurrent page-render requests, multiple threads
  enter libpdfium at once and **segfault**. The fix is a module-level
  `_PDFIUM_LOCK = threading.RLock()` acquired at the top of *every* public
  method. Coarse but correct. (This was a real crash on the 44-page
  `Animal_farm.pdf`; see HANDOFF "Phase 1.1 hotfix".) The contract test
  `tests/integration/test_concurrent_renders.py` fires 32 parallel renders to
  lock this in.
- **`open`** wraps `pdfium.PdfDocument(str(path))`, translating
  `PdfiumError | FileNotFoundError | OSError` into `PdfError`.
- **`render_page(idx, dpi)`** computes `scale = dpi / 72.0`, renders a bitmap,
  converts to a PIL image, and PNG-encodes it (`compress_level=6`).
- **`get_page_text(idx)`** is where coordinate conversion happens. PDFium gives
  text rects in PDF-native coordinates (**origin bottom-left**); this method
  flips them to **origin top-left** (`y0 = page_height - top`) so the rest of the
  system — and the browser — uses one consistent convention. It builds a
  `TextRun` per non-empty rect (`text`, `bbox`, `font_size = top - bottom`), then
  calls `cluster_into_columns(...)` to group runs into reading-order columns, and
  returns a `PageText` carrying both the flat `runs` and the clustered `columns`.
- **`get_outline()`** reads `self._doc.get_toc()` (a flat, depth-tagged bookmark
  list in document order), resolves each bookmark's destination page, and
  `_build_outline_tree()` rebuilds the nested tree with a single stack-based
  pre-order walk.

### 5.5 Data types — `pdf/types.py`

All frozen dataclasses, all coordinates in **PDF points, top-left origin**:

- **`BBox(x0, y0, x1, y1)`** with `.width`, `.height`, `.contains_point()`.
- **`TextRun(text, bbox, font_size)`** — one extracted text fragment.
- **`TextColumn(bbox, runs)`** — a contiguous vertical region, runs in reading order.
- **`PageText(page_index, runs, columns)`** — `.plain` joins all run text.
- **`PageDimensions(width_pt, height_pt)`**.
- **`OutlineNode(title, page_index|None, children)`** — recursive tree node.
- **`DocumentMetadata(page_count, title?, author?)`**.

### 5.6 Column detection — `pdf/columns.py`

The problem: academic papers are usually two-column, and the browser's native
selection will happily drag from the left column into the right one if the DOM
doesn't physically separate them. So the backend must figure out which runs
belong to which column. **It does this geometrically — no ML.**
`cluster_into_columns(runs, page_width_pt)` works in these steps:

1. **Filter to body text** (`_filter_to_body_text`). Round every run's font size
   to 0.5pt, drop anything below `MIN_BODY_FONT_PT = 6.0` (sub/superscripts,
   inline-math glyphs, footnote markers — these used to poison the result), pick
   the modal size, and keep runs within `±15%` of it
   (`BODY_FONT_TOLERANCE_PCT`). If no size dominates (`< MIN_BODY_RUN_RATIO =
   0.15` of runs), skip filtering. This is what stops full-width titles/abstracts
   from being treated as column structure.
2. **Histogram left edges.** Bucket each body run's `x0` into `BUCKET_SIZE_PT =
   30.0`-pt buckets.
3. **Threshold.** Keep buckets with `≥ max(3, sqrt(total_body_runs))` runs.
4. **Trim false peaks.** If there are more than `DEFAULT_MAX_COLUMNS = 4`
   candidates, keep the densest 4. For 3+ candidates with *uneven* gaps (a gap
   deviates more than `UNIFORM_GAP_TOLERANCE = 0.15` from the mean), drop to the
   top 2 by count — this kills "right-justified numbers look like a column"
   false positives.
5. **Reject tight layouts.** If the smallest inter-peak gap `< MIN_COLUMN_GAP_PT
   = 140.0`, declare a single column.
6. **Assign.** Boundaries sit at the *start of the next peak's bucket* (so a long
   word reaching toward the gutter stays in its own column). Then **every** run
   — including the non-body ones filtered out in step 1 — is bucketed by `x0`.
   Title/footer runs fall into column 0 by virtue of starting near the left
   margin. Runs within a column are sorted `(y0, x0)`.

The history of this algorithm (a coverage-profile sweep that failed on
full-width headers, then this histogram rewrite, then the body-font filter) is
documented in HANDOFF under "Phase 3 column-detection".

### 5.7 Figure detection — `pdf/figures.py`

PDFs don't mark where figures are, but papers *always* caption them
("Figure 2:", "Fig. 3a", "Table 1"). So detection is **caption-anchored**:

1. `CAPTION_PATTERN` (a regex) scans text runs for ones that *start* with a
   caption keyword + number.
2. For each caption, `_column_for_caption` decides which column it belongs to —
   or, if the caption spans `≥ WIDE_CAPTION_FRACTION = 0.70` of the page width,
   treats it as a full-width figure.
3. `_figure_bbox_above_caption` walks upward through that column's runs, finds
   the nearest text bottom strictly above the caption, and if the vertical gap
   exceeds `MIN_FIGURE_GAP_PT = 18.0` declares that whitespace the figure region.
4. Results are deduped per label (a caption sometimes splits across two runs) and
   returned as `FigureRegion(figure_id, label, page_index, bbox, caption_bbox)`.

The `figure_id` is a stable, URL-safe key — `p{page_index}_{label}` with
non-alphanumerics replaced (e.g. `p3_Figure_2`) — and it's the primary key under
which figure explanations are cached. Detection is **stateless and cheap** (one
regex sweep over text we already have), so it runs on demand per page rather than
being persisted.

### 5.8 Storage — `storage/db.py` and `storage/files.py`

**`db.py`** holds the entire SQLite schema (see [§10](#10-persistence--caching-layers)
for the full table list) and two helpers:

- `init_db(path)` runs the schema via `executescript` (idempotent).
- `connect(path)` is a context manager that opens a connection with
  `row_factory = sqlite3.Row` (dict-like rows), turns on `PRAGMA foreign_keys =
  ON` (SQLite needs this *per connection* for cascades to fire), and
  **commits on clean exit / rolls back on exception**.

**`files.py`** handles the on-disk artifacts:

- `sha256_bytes(data)` → the content hash that becomes `doc_id`.
- `pdf_path(settings, doc_id)` → `pdfs/<sha>.pdf`.
- `render_path(settings, doc_id, page_index, dpi)` → `renders/<sha>/pN_dpi.png`.
- `save_pdf` and `write_render_cache` both use an **atomic write**: write to a
  per-writer unique temp file (`_unique_tmp` = pid + random token), then
  `Path.replace()` (atomic rename). The uniqueness matters because two threads
  can render the *same* page concurrently; a shared temp name let one rename the
  file out from under the other (`FileNotFoundError`). Identical bytes mean
  last-writer-wins is safe. (HANDOFF: "Pre-existing race fixed".)

### 5.9 The routes

Every route depends on `get_settings`. Paths, methods, and shapes:

#### `documents.py` — `/documents`

| Method | Path | Does |
|---|---|---|
| `POST` | `/documents` | **Upload.** Reads bytes, validates `0 < size ≤ 200MB`, hashes to `doc_id`, writes the file (if new). Opens the PDF once to pull metadata, per-page dimensions, and per-page flattened text. Then a single transaction: **UPSERT** the `documents` row, `INSERT OR IGNORE` page dimensions, and **DELETE+INSERT** the FTS rows. Returns `{id, filename, page_count, title, author}`. |
| `GET` | `/documents` | List all docs, newest first (powers the Library). |
| `GET` | `/documents/{doc_id}` | One doc's metadata. |
| `GET` | `/documents/{doc_id}/dimensions` | Per-page `{page, width_pt, height_pt}`. The frontend needs honest page sizes *before* any image loads so the virtualized scrollbar is accurate. Lazy-populates the cache for docs uploaded before this endpoint existed. |

> **The re-upload data-loss bug (important).** The upload originally used `INSERT
> OR REPLACE`, which SQLite implements as DELETE-then-INSERT. Because
> `annotations` has `ON DELETE CASCADE` to `documents`, every re-upload **wiped
> every highlight**. The fix is the explicit `ON CONFLICT(id) DO UPDATE` upsert
> you see now (updates in place, no cascade). Regression test:
> `test_reupload_preserves_existing_annotations`. (HANDOFF: "Data-loss bug".)

#### `pages.py` — `GET /documents/{doc_id}/pages/{page_number}.png`

Renders a page (page numbers are **1-indexed** on the wire) to PNG. Accepts
`?dpi=` (default 150, must be in `(0, max_dpi]`). **Disk-cached**: if
`renders/<sha>/p{n-1}_{dpi}.png` exists it's served straight from disk; otherwise
it renders, caches, and returns. Responses carry `Cache-Control: public,
max-age=31536000, immutable` so the browser caches aggressively (safe, because
content-addressed bytes never change).

#### `text.py` — `GET /documents/{doc_id}/pages/{page_number}/text`

Returns `{page_index, page_width_pt, page_height_pt, columns: [{bbox, runs:
[{text, bbox, font_size}]}]}`. This is the data the frontend turns into its
invisible selectable text layer. Coordinates are PDF points, top-left origin;
the client scales by `display_width / page_width_pt`.

#### `annotations.py` — `/documents/{doc_id}/annotations`

| Method | Path | Does |
|---|---|---|
| `POST` | `…/annotations` | Create a highlight. Body: `{page (1-idx), color ∈ {yellow,blue,red,green,pink}, rects:[{x0,y0,x1,y1}], text?}`. Stored as a row with a JSON `payload` (`{color, rects, text?}`) and a fresh UUID `id`. Page stored 0-indexed internally. |
| `GET` | `…/annotations[?page=N]` | List highlights (optionally one page). **LEFT JOINs `explanations`** so each highlight can carry its cached AI explanation inline (`{kind, content}`) when one is `complete` — this is what makes the first hover instant with no extra request. |
| `DELETE` | `…/annotations/{id}` | Delete (204). Cascades to the `explanations` row. |

Only `highlight` is implemented today, though the schema's `kind` column leaves
room for `note`/`ink`.

#### `outline.py` — `GET /documents/{doc_id}/outline`

Opens the PDF, calls `get_outline()`, and serializes the tree to `{doc_id, nodes:
[{title, page (1-idx or null), children:[…]}]}`.

#### `search.py` — `GET /documents/{doc_id}/search?q=…&limit=…`

Full-text search via the `pages_fts` FTS5 table. The query is sanitized (embedded
quotes doubled) and given a `*` suffix for **prefix matching** so "anim" finds
"animal" mid-type. Results come back ranked by FTS5 `rank`, each with a
`snippet(...)` that wraps matches in `<mark>…</mark>`. FTS5 HTML-escapes the text
before injecting the tags, so the frontend can `innerHTML` the snippet safely. A
malformed FTS query degrades to an empty result list rather than a 500.

#### `explanations.py` and `figures.py`

These are the AI endpoints and get their own section next.

---

## 6. The AI explanation subsystem (the heart of the app)

There are two AI surfaces — **highlight explanations** (`explanations.py`) and
**figure explanations** (`figures.py`) — and they share a design: a streaming
SSE endpoint that talks to Claude and persists the final answer to SQLite;
repeat requests short-circuit to the cached row.

### 6.1 The SSE wire format

Every AI endpoint returns `media_type="text/event-stream"` and emits newline-
delimited `data:` frames, each a JSON object:

```
data: {"type":"meta","kind":"definition","cached":false}
data: {"type":"delta","text":"A "}
data: {"type":"delta","text":"glossary..."}
data: {"type":"done","text":"A glossary term meaning..."}
```

Frame types: `meta` (start; carries `kind`, `cached`, sometimes `refined`),
`delta` (a token chunk), `done` (the full accumulated text), `error` (a message).
A **cache hit replays the same shape** — `meta(cached:true)` → one `delta` with
the whole text → `done` — so the client has exactly one code path whether the
answer is live or cached.

### 6.2 Routing: definition vs. explanation

When you highlight in blue, the server decides what kind of help you need with a
tiny heuristic, `classify(text)`:

```python
word_count <= 4 and no terminal punctuation (.!?)  →  "definition"
otherwise                                          →  "explanation"
```

A short, punctuation-free phrase is a *term to define*; anything sentence-shaped
is a *passage to restate*. The client can override by passing `kind` explicitly.

### 6.3 Models and prompts

| Use | Model constant | Value | Why |
|---|---|---|---|
| Definition | `MODEL_DEFINITION` | `claude-haiku-4-5` | tiny, fast, ≤35-word glossary tooltip |
| Explanation | `MODEL_EXPLANATION` | `claude-sonnet-4-6` | a touch more reasoning for restating a sentence |
| Chat | (uses `MODEL_EXPLANATION`) | `claude-sonnet-4-6` | multi-turn follow-ups |
| Refine | def→Haiku, expl→Sonnet | — | rewrite folding in the chat |
| Figure | `MODEL_FIGURE` | `claude-sonnet-4-6` | vision; faster than Opus for a quick gloss |

Each path has a tightly scoped system prompt with hard word limits (definition:
35 words; explanation: 2 sentences/45 words; figure: 3 sentences/70 words) and a
"no preamble, the reader is mid-paragraph" instruction. `max_tokens` is small to
match (80/140/200/400).

### 6.4 The latency trick: page-text context, not the whole PDF

This is the single most important performance decision. Originally every
`/explain` base64-encoded the **entire PDF** as a `document` block, so the model
had to prefill tens of thousands of tokens before emitting a 35-word answer —
slow on the first hover, and `cache_control` only helped within its 5-minute TTL.

Now, for the initial definition/explanation, the server sends **only the text of
the page the highlight is on** (`_page_text()` joins that page's runs — a few
hundred to ~2K tokens) wrapped in a `<page>…</page>` block, with **no document
block at all**. That slashes prefill and makes the first hover fast.
`_verify_ownership` returns the annotation's `page_index` precisely so this is
possible. If extraction fails, it falls back to `""` and the model answers from
general knowledge. (HANDOFF: "Explanation latency".)

**Chat and refine still attach the full PDF** (`_pdf_document_block`, marked
`cache_control: ephemeral`) — they're deliberate, less latency-sensitive, and
genuinely benefit from whole-paper context. The ephemeral cache marker means the
2nd+ call on the same document reuses the cached prefix.

### 6.5 The four highlight endpoints

All are under `/documents/{doc_id}/annotations/{annotation_id}`.

- **`GET /explanation`** — return the persisted explanation row, or 404.
- **`POST /explain`** — the main path. Validates the doc and annotation (capturing
  the page), **checks the cache** (serves a single-flush replay if a `complete`
  row matches the same `text` and `kind`), otherwise writes a `pending` row,
  builds the page-text prompt, streams Claude via `_stream_claude` →
  `_stream_anthropic`, and **finalizes** the row to `complete` (or `error`) when
  the stream ends.
- **`POST /chat`** — a follow-up thread. The PDF + the tooltip context (the
  highlighted text + the current tooltip) ride on the **first** user turn
  (`_build_chat_messages`), and the rest of the thread is sent verbatim. Streams
  a reply; **not persisted** (chat lives only in the frontend store).
- **`POST /refine`** — "Update explanation": a one-shot rewrite that folds the
  useful parts of the conversation back into a tightened tooltip. On a clean
  finish it **UPSERTs the new text** as the canonical explanation
  (`_save_refined`), so it shows on the next hover and is inlined by `GET
  /annotations`. A *failed* refine never overwrites the text the reader already
  had.

The persistence helpers (`_upsert_pending`, `_finalize`, `_save_refined`,
`_load_explanation`) all operate on the `explanations` table, keyed by
`annotation_id`.

`_stream_anthropic(model, system, messages, max_tokens)` is the shared core: it
checks `ANTHROPIC_API_KEY` (emitting a single `error` frame if unset — this is
why the tooltip shows "Explanation unavailable" without a key), opens
`AsyncAnthropic().messages.stream(...)`, yields `("delta", chunk)` per token,
then `("done", full)`, and converts API/other exceptions into `("error", msg)`.

### 6.6 The figure endpoints

Under `/documents/{doc_id}`:

- **`GET /pages/{page_number}/figures`** — runs `detect_figures()` on demand and
  returns each region's `figure_id`, `label`, `bbox`, and `caption_bbox` (in
  page-space points, same convention as `/text`). It also **inlines any cached
  explanation** so the frontend can seed its figure store exactly like it does
  for highlights.
- **`GET /figures/{figure_id}/explanation`** — the cached row, or 404.
- **`POST /figures/{figure_id}/explain`** — cache-check first; on a miss it
  renders the page to PNG at 150 DPI, then streams Claude with **three content
  blocks**: the full PDF (`document`, cached ephemeral), the **page image**
  (`image/png`, so the model can see which figure is meant), and a text
  instruction naming the label and page. Persists to `figure_explanations`
  (keyed by `(doc_id, figure_id)`).

---

## 7. Frontend, module by module

The frontend is vanilla TypeScript organized into three layers: **the viewer
subsystem** (`src/viewer/`), **state stores** (small pub/sub modules), and
**toolbar UI components**. State flows one way: UI components mutate a store →
the store notifies subscribers → the viewer re-renders.

### 7.1 Bootstrap — `index.html` + `main.ts`

`index.html` is a static skeleton with named **slots**: a `.toolbar` containing
`#sidebar-toggle-slot`, the file `#file` input, `#highlight-button-slot`,
`#erase-button-slot`, `#zoom-controls-slot`, `#page-indicator-slot`,
`#doc-info`; and a `.main-area` with `#sidebar` and the scrollable `#viewer`.

`main.ts` runs on load and:

- Initializes zoom (`initViewerZoom`), the sidebar (`initSidebar` +
  `mountSidebarPanel("outline", …)`), and fills every slot with its component
  (`buildHighlightButton()`, `buildZoomControls()`, etc.).
- Wires **global keyboard shortcuts**: `Esc` closes Find; `Cmd/Ctrl+S` is
  *trapped* (shows a "highlights save automatically" toast instead of the
  browser's save dialog); `Cmd/Ctrl+F` opens Find; `Cmd/Ctrl + +/-/0` zoom
  anchored at the viewer center.
- Wires **pinch-to-zoom**: trackpad pinch arrives as a `wheel` event with
  synthetic `ctrlKey` (Chrome/Edge/FF) or as Safari `GestureEvent`s. Both are
  rAF-throttled and **anchored** so the content under the cursor stays put.
- Drives the **document lifecycle**: `showLibrary()` on startup; on upload or
  tile click, `renderDocument(meta)` fetches dimensions, sets document bounds for
  the fit math, builds a `PageList`, and registers it with `pageNav` so the page
  indicator works.

### 7.2 The API client — `api.ts`

One file, every backend call, fully typed. It mirrors the backend's shapes
(`DocumentMeta`, `PageText`, `Annotation`, `OutlineNode`, `PageFigure`, etc.) and
exposes plain `fetch` wrappers (`uploadDocument`, `listDocuments`,
`fetchDocumentDimensions`, `fetchPageText`, `createHighlight`, `listAnnotations`,
`deleteAnnotation`, `fetchOutline`, `fetchSearchResults`, `fetchPageFigures`) plus
a URL builder (`pageImageUrl`).

The streaming functions (`streamExplanation`, `streamChat`, `streamRefine`,
`streamFigureExplanation`) are the interesting part. Each opens a `fetch` with an
`AbortController`, reads `response.body` as a stream, and parses SSE frames
(`consumeSSE` is the shared reader: split on `\n\n`, take `data:` lines,
`JSON.parse`, dispatch by `type`). They invoke `{onMeta, onDelta, onDone,
onError}` callbacks and **return an abort function** so a caller can cancel when
the user navigates away or hovers elsewhere.

### 7.3 The viewer subsystem — `src/viewer/`

**The layered page model.** Each page is a stack of overlays. In z-order,
bottom → top:

1. `<img class="page">` — the rasterized page PNG.
2. `<svg class="live-selection-layer">` — your *in-progress* drag selection,
   drawn as one merged blue rect per visual line.
3. `<svg class="annotation-layer">` — *saved* highlights, one `<g>` per highlight,
   one `<rect>` per merged line.
4. `<div class="text-layer">` — the invisible, selectable text spans.

The text layer is on **top** because it must intercept the drag-select mouse
events; its spans are transparent so the image shows through, and the highlight
SVG below it stays visible.

The modules:

- **`PageList.ts`** — virtualization. It lays out an accurately-sized placeholder
  for *every* page up front (so the scrollbar is honest from frame one), then an
  `IntersectionObserver` with a `±1 viewport` margin **upgrades** a placeholder
  into a live `PageView` as it nears the viewport and **demotes** it back when it
  leaves. A second observer tracks which page is most visible and publishes it via
  `subscribeCurrentPage` (drives the page indicator). It listens to zoom/fit
  changes to resize placeholders. Exposes `scrollToPage`, `getCurrentPage`,
  `dispose`.
- **`PageView.ts`** — everything for a single page. Loads the image at a DPI that
  adapts to zoom; on load, fetches the text and builds the `TextLayer`,
  `LiveSelectionLayer`, and `AnnotationLayer`; fetches annotations and **seeds
  the explanation store** from their inline cached explanations; fetches figures
  and seeds the figure store; wires `mouseup` → auto-save highlight,
  `dblclick` → figure hit-test → figure card, and find-query subscription. It's
  the orchestration hub where stores, geometry, and the API meet.
- **`coords.ts`** — the coordinate bridge. `pageBBoxToViewport` / 
  `viewportBBoxToPage` convert between PDF points (top-left) and on-screen pixels
  using `sx = displayWidthPx / pageWidthPt`. Everything geometric goes through
  here.
- **`selection.ts`** — turns a browser `Range` into storable rects:
  `clientRectsRelativeTo` (DOMRects → page-wrap-relative) →
  `mergeAdjacentLineRects` (union the per-span boxes into one rect per line,
  bucketing by `y` within 3px) → `rectsToPageSpace` (pixels → PDF points). The
  line-merge is why saved highlights look like clean blocks instead of scrappy
  per-word fragments. `AnnotationLayer` also re-merges at render time so *legacy*
  highlights stored before the fix render cleanly without a DB migration.
- **`TextLayer.ts`** — builds one `<div class="text-column">` per detected column,
  with a transparent `<span class="text-run">` per run absolutely positioned to
  its glyph box. The per-column DOM containers are what keep native selection
  inside a column.
- **`LiveSelectionLayer.ts`** — a single document-level `selectionchange`
  listener dispatches to every registered page; each redraws its selection as
  merged-by-line SVG rects (`rgba(79,140,255,0.4)`). This replaces the browser's
  default `::selection` (which paints one box per inline span, leaving gaps) for
  Mac-Preview-clean visuals.
- **`columnConstraint.ts`** — anchor-preserving clamp that keeps a drag inside the
  column it started in (using `setBaseAndExtent` so backward drags don't flip).
  **Currently not installed by `PageView`** — the clean per-column DOM made it
  unnecessary and the user wanted intentional cross-column selection — so it's
  kept as tested-but-dormant code for a possible opt-in lock later. (HANDOFF:
  "Constraint removed".)
- **`AnnotationLayer.ts`** — renders saved highlights as colored SVG, with the
  per-color alpha values tuned for legibility over text. Erase-mode click deletes
  immediately; non-blue highlights get a hover "Delete" pill
  (`HighlightHoverActions`); **blue** highlights get the explanation tooltip
  (`bindBlueAnnotation`).
- **`ExplanationTooltip.ts`** — the pinnable AI tooltip (a singleton). Hover dwell
  shows it above the highlight; it renders the explanation store's state
  (loading shimmer → streamed text → ready). Click "Ask a follow-up" to **pin**
  it: pinning disables auto-hide, reveals a scrollable chat thread + input +
  "Update explanation", and adds resize handles. Pinned size persists to
  `localStorage` (`scai.explanationBoxSize`) and grows-then-scrolls up to a cap.
  Click-outside or × closes it; "Update explanation" closes immediately and
  refines in the background.
- **`HighlightHoverActions.ts`** — the standalone hover-Delete pill for non-blue
  highlights, anchored bottom-left, using a page-wrap `mousemove` hit-test (the
  text layer overlays the SVG, so per-group `mouseenter` won't fire).
- **`FigureCard.ts`** — the figure explanation card shown on double-click, with
  loading/ready/error states, positioned beside the figure and clamped to the
  viewport; driven by the figure store.
- **`findInPage.ts`** — tags `.text-run` spans that contain the query with
  `.find-match` (and one `.find-match-current`), returning the ordered match list.

### 7.4 State stores (pub/sub modules)

Each is a tiny module holding state + a subscriber set, exposing
`get*/set*/subscribe*`:

- **`explanationStore.ts`** — per-annotation explanation state (`idle → loading →
  ready/error`) **plus** the per-annotation chat thread. Key functions:
  `seedExplanation` (prime from server cache without clobbering a live stream),
  `startExplanation` (kick off the SSE stream, once), `hydrateExplanation` (check
  the server for a cached row), `getChat` / `sendChatMessage` (stream a reply),
  `refineFromChat` (stream a rewrite that lands as the new `ready` text).
- **`figureStore.ts`** — the same shape keyed by `(docId, figureId)`:
  `seedFigure`, `startFigureExplanation`, `subscribeFigure`.
- **`highlightMode.ts`** / **`eraseMode.ts`** — the two drawing modes; mutually
  exclusive (turning one on disables the other via a late-bound callback to avoid
  a circular import). `main.ts` mirrors their `active` flag onto
  `documentElement.dataset` so CSS can restyle (e.g. `cursor: cell` over text).
- **`findState.ts`** — the search query + a registry of per-page
  `PageMatchAdapter`s. It owns the flattened global match list and
  `next`/`prev` navigation across pages, plus `getTotalMatches` / 
  `getCurrentIndex` for the count display.
- **`fit.ts`** — fit mode (`fit-width` default, `fit-page`, `actual`) and the
  resulting `baseScale`. The display formula is `displayPx = pagePt × baseScale ×
  zoom`. Decoupling fit from zoom is what keeps the math clean.
- **`zoom.ts`** — the zoom multiplier with a discrete ladder
  (`ZOOM_STEPS`, clamped `0.5–4.0`).
- **`viewerZoom.ts`** — viewer-aware *anchored* zoom: it preserves the cursor's
  fractional position through the scroll area across a zoom step, so content
  doesn't jump (critical on a multi-million-pixel document).
- **`pageNav.ts`** — bridges the active `PageList` to the toolbar page indicator
  (`setActivePageList`, `jumpToPage`, `subscribePageInfo`).
- **`sidebar.ts`** — the tabbed sidebar shell (`mountSidebarPanel`, visibility
  toggle, persisted user intent).

### 7.5 Toolbar / UI components

Each `build*()` returns a DOM element wired to a store:

- **`Library.ts`** — the recent-documents grid (`listDocuments` → tiles → `onOpen`).
- **`Outline.ts`** — the outline sidebar panel; fetches on doc change, renders a
  collapsible tree, click → `jumpToPage`.
- **`FindBar.ts`** — the Cmd-F bar: debounced query input, "current / total"
  count, prev/next, Esc to close.
- **`HighlightButton.ts`** — highlight toggle + 5-swatch color popover.
- **`EraseButton.ts`** — erase-mode toggle.
- **`ZoomControls.ts`** — `[−] [100%] [+]`, all anchored at viewer center.
- **`PageIndicator.ts`** — `[5] / 127` editable jump-to-page field.
- **`SidebarToggle.ts`** — show/hide the sidebar.

---

## 8. End-to-end flows (follow the data)

### 8.1 Upload & first render

1. User picks a file → `uploadDocument()` POSTs it.
2. Backend hashes → `doc_id`, stores the file (if new), opens it once to extract
   metadata + dimensions + per-page text, upserts `documents`, ignores-or-inserts
   `page_dimensions`, rebuilds `pages_fts`.
3. Frontend `renderDocument()` fetches `/dimensions`, sets fit bounds, builds the
   `PageList` of accurately-sized placeholders.
4. As pages scroll into view, each upgrades to a `PageView`: it requests
   `/pages/{n}.png` (served from the render cache or freshly rendered+cached),
   then `/pages/{n}/text` to build the selectable layer, then `/annotations?page=n`
   to draw existing highlights and seed cached explanations.

### 8.2 Blue highlight → AI explanation (the signature flow)

1. Highlight mode is set to **blue**; you drag-select. On `mouseup`, `PageView`
   captures the selection text, merges rects per line, converts to page-space,
   and `POST`s the highlight (`createHighlight`).
2. On success it calls `startExplanation()`, which POSTs `…/explain`. The server
   classifies definition vs. explanation, writes a `pending` row, builds a prompt
   from **just that page's text**, and streams Claude's tokens back as SSE
   `delta` frames.
3. The explanation store accumulates deltas (`loading`), the tooltip subscribes
   and fills in live; on `done` the store goes `ready` and the server writes
   `complete` + the text into `explanations`.
4. Hovering the highlight (200ms dwell) anchors the tooltip. Because
   `GET /annotations` inlines the cached explanation, **a reopen costs zero LLM
   calls and zero extra requests** — it's already in the store.
5. Not good enough? Pin the tooltip, ask follow-ups (`…/chat`, full PDF as
   context), then "Update explanation" (`…/refine`) to fold the conversation back
   into a tightened tooltip that persists.

### 8.3 Figure → AI walkthrough

Double-click a page → `PageView` hit-tests the cursor against figure bboxes from
`/pages/{n}/figures` → `showFigureCard()` → `startFigureExplanation()` POSTs
`…/figures/{id}/explain` → the server renders the page image, streams Claude
(PDF + image + label), and persists to `figure_explanations`. Cached on re-open.

### 8.4 Find-in-page

`Cmd-F` → `FindBar` → `setQuery()`. Each visible `PageView` re-applies the query
to its text layer (`applyFindToTextLayer`) and registers its match count with
`findState`. The bar shows "current / total"; `next`/`prev` walks the global
flattened match list, scrolling the owning page into view and marking the current
hit. (The backend's `/search` FTS endpoint powers result *snippets*; the
in-page tagging is the client-side complement.)

---

## 9. Cross-cutting concerns

### 9.1 Coordinate systems (a frequent source of bugs)

- **PDF-native**: origin **bottom-left**. Only `pypdfium2` speaks this; the
  backend converts immediately in `get_page_text`.
- **Page-space**: PDF points, origin **top-left**. The canonical wire format —
  every `bbox`/`rect` over HTTP is in this system. Highlights are stored here, so
  they're zoom- and DPI-independent.
- **Viewport-space**: CSS pixels on screen. `coords.ts` converts to/from
  page-space by the display/point scale.

### 9.2 Page indexing

**0-indexed internally** (DB `page_index`, all `PdfBackend` methods);
**1-indexed on every wire boundary** (URLs, JSON `page`, the UI). Routes
translate at the edge. The HANDOFF flags a related gotcha: `dpi or default` is
wrong because `0` is falsy — use `default if dpi is None else dpi`.

### 9.3 Concurrency & atomicity

- PDFium access is serialized by one global `RLock` (§5.4).
- File writes are temp-file-plus-atomic-rename with per-writer unique temp names
  (§5.8).
- SQLite connections enable `foreign_keys` per-connection and commit/rollback
  around each request.

### 9.4 Security note on search snippets

FTS5's `snippet()` HTML-escapes the source text *before* injecting `<mark>`
tags, which is the only reason the frontend can `innerHTML` snippets without an
XSS hole. Don't change that without re-escaping client-side.

---

## 10. Persistence & caching layers

**SQLite (`reader.db`)** — six tables:

| Table | Key | Holds | Cascade |
|---|---|---|---|
| `documents` | `id` (sha256) | filename, page_count, title, author, size, uploaded_at | — |
| `annotations` | `id` (uuid) | doc_id, page_index, kind, JSON payload, created_at | `doc → CASCADE` |
| `explanations` | `annotation_id` | kind, highlighted text, content, status, error, timestamps | `annotation → CASCADE` |
| `figure_explanations` | `(doc_id, figure_id)` | page_index, label, content, status, error, timestamps | `doc → CASCADE` |
| `page_dimensions` | `(doc_id, page_index)` | width_pt, height_pt | `doc → CASCADE` |
| `pages_fts` | (FTS5 virtual) | doc_id, page_index (1-idx), text | none (FTS5 can't FK; kept in sync by delete-then-insert on upload) |

**Filesystem (`$PDF_READER_DATA_DIR`, default `./data`)** — `pdfs/<sha>.pdf`
(canonical uploads) and `renders/<sha>/pN_dpi.png` (the page-image cache, served
with a one-year immutable `Cache-Control`).

**Caching layers, in order of cheapness:**
1. Browser HTTP cache for page PNGs (immutable URLs).
2. On-disk render cache (`renders/`).
3. SQLite explanation/figure caches (zero LLM calls on repeat).
4. Anthropic prompt cache (`cache_control: ephemeral`) for the PDF prefix on
   chat/refine/figure calls within the 5-minute TTL.
5. The frontend stores (`explanationStore`, `figureStore`) seeded from inline
   `GET /annotations` / `GET …/figures` data, so an in-session hover hits no
   network at all.

---

## 11. Testing strategy

Run everything with `./scripts/ci.sh` (pytest + `tsc` + `vite build`).

| Layer | Location | Asserts |
|---|---|---|
| Backend unit | `backend/tests/unit/` | column detection, figure detection, outline-tree build, storage paths |
| Backend contract | `backend/tests/contract/test_backend_contract.py` | the `PdfBackend` interface spec — runs against *every* backend |
| Visual golden | `backend/tests/contract/test_visual_goldens.py` | rendered PNGs vs. baselines via a SHA-256 → pixel → SSIM ladder |
| Backend integration | `backend/tests/integration/` | the FastAPI stack: annotations, documents, search, outline, concurrent renders, the explanation/chat no-key paths |
| Frontend unit | `frontend/src/**/*.test.ts` | selection geometry, coord transforms, sidebar/highlight/erase/find state, tooltip behavior |

Fixtures are deterministic reportlab-generated PDFs (`tests/fixtures/`). The live
AI path isn't covered end-to-end (it'd need a real key in CI); the classifier,
SSE framing, and persistence are each tested in isolation. Note the
`with TestClient(app)` lifespan caveat (handled by the `app_client` fixture) and
the Python `>= 3.12` floor.

---

## 12. Running & configuring it

```bash
# Backend
cd backend
python3.12 -m venv .venv
.venv/bin/pip install -e ".[test]"
export ANTHROPIC_API_KEY=sk-ant-...      # only needed for AI features
.venv/bin/uvicorn app.main:app --reload --port 8000

# Frontend (separate shell)
cd frontend
npm install
npm run dev                               # http://localhost:5173
```

Vite proxies `/documents` and `/healthz` to `:8000`. Everything except AI works
without a key; without `ANTHROPIC_API_KEY` the explain stream emits a single
error frame and the tooltip reads "Explanation unavailable".

| Env var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | required for all AI endpoints |
| `PDF_READER_DATA_DIR` | on-disk root for `reader.db`, `pdfs/`, `renders/` (default `./data`) |

For production, `npm run build` emits `frontend/dist`, which FastAPI serves at
`/` — a single server, no Vite.

---

## 13. Known limitations & roadmap

- **Chat threads are in-memory** on the frontend — only the *refined* tooltip
  text persists. Persisting threads would need a new table.
- **Figure detection is caption-heuristic** — figures without a recognizable
  caption prefix, or with unusual layouts, won't be detected.
- **Column detection constants are tuned for academic papers** (`MIN_BODY_FONT_PT
  = 6.0`, `MIN_COLUMN_GAP_PT = 140`); title pages with centered abstracts can
  leak slightly, and e-books/comics would need retuning.
- **The PDFium global lock** serializes all rendering across documents — fine
  now, but a per-document instance cache with finer locking is the planned scale
  path.
- **No delete UI in the Library**, and it lists every document with no search.
- **The AI path has no end-to-end automated coverage** (needs a live key).
- **Roadmap**: methods-aware explanations that pull in the relevant methods
  section; broader automated AI coverage.

---

*This document reflects the code as of the `claude/exciting-noether-wt93rk`
branch. When the architecture shifts, update this file alongside the change — and
add a dated note to `HANDOFF.md` explaining the why.*
