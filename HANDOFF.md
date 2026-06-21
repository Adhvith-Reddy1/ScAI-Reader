# Handoff

**Read this file first.** It's the per-session resumption record. Plan of record is `/Users/areddy/.claude/plans/i-want-to-build-snoopy-hippo.md`. This file captures what was just done and what's next; newest section on top.

When starting fresh: read this, skim the plan, then check `TaskList`.

---

## Explanation box: capped grow-then-scroll size — 2026-06-21

The pinned box's `max-height` was `calc(100vh - 24px)` (≈ full screen), so a
streaming follow-up grew the box almost to fill the page before scrolling. Now
it grows with content up to a readable cap, then the thread scrolls.

- `ExplanationTooltip.ts`: pinned `position()` no longer sets an explicit height
  — it sets `width` (default `DEFAULT_PINNED_WIDTH = 600`) and a `max-height`
  cap (`DEFAULT_CAP_PX = 620`, or the remembered size), clamped to
  `vh - top - margin` so the panel never runs past the bottom of the screen.
  Height is left `auto` so it grows then the thread (`overflow-y:auto`) scrolls.
- A **remembered/resized height is now the grow-to cap**, not a fixed height —
  reopening still expands-then-scrolls at the reader's chosen size. Resize drag
  sets `height` + `max-height` together so a drag can grow past the cap.
- `styles.css` `.is-pinned` fallback `max-height: min(620px, calc(100vh-24px))`.
- Tests: `ExplanationTooltip.test.ts` → 9 (added "caps height (grow-then-scroll)
  when not resized"; "remembers size" now checks `max-height`, not `height`).

### Pre-existing race fixed (separate commit)

`storage/files.py` wrote the render cache via a fixed `*.tmp` name, so two
threads rendering the same page raced (`tmp.rename` → FileNotFoundError). This
session's container timing made `test_concurrent_renders` fail consistently.
Fixed with a per-writer unique temp name (`_unique_tmp`, pid + random token) +
`Path.replace`. Same applied to `save_pdf`.

---

## Explanation box: chat-mode polish + persistent size — 2026-06-21

Four follow-up tweaks to the pinnable explanation box (all in
`ExplanationTooltip.ts` + a little CSS):

- **No Delete while chatting.** The footer (Delete + "Ask a follow-up") shows
  only in the collapsed hover state; opening the chat hides the whole footer —
  if you're chatting, you're not deleting. `renderChat` now does
  `footEl.style.display = pinned ? "none" : "flex"`.
- **Click-outside closes.** A `document` `pointerdown` listener closes a pinned
  panel when the target is outside it (resize handles and the chat are inside,
  so they don't trigger it; the open-chat click fires while still unpinned).
- **"Update explanation" closes immediately, refines in the background.** The
  apply handler captures doc/id/text, calls `refineFromChat`, then `hide()`s
  right away. The store keeps streaming the rewrite and lands it as `ready` (and
  the server persists it), so the next hover shows the updated text — the reader
  never waits on the model. A failed refine restores the original text.
- **Persistent size.** Replaced the per-session `userSized` flag with
  `savedSize` (persisted to `localStorage` key `scai.explanationBoxSize`) +
  `pinnedPlaced`. Resizing records the size; `hide()` keeps it; `position()`
  re-applies it (width + height) each time the panel is pinned, anchored to the
  new highlight. Cleared only by `_resetForTest`.

Tests: `ExplanationTooltip.test.ts` is now 8 — added footer-hidden-when-pinned,
click-outside-closes, update-closes-and-refines-in-background, and
size-persists-across-reopen. 135 frontend + 102 backend green.

Still browser-unverified (no browser in container) — needs a live eyeball on
the resize/scroll/persist feel.

---

## Explanation box: bottom-left Delete, scrolling chat, resizable — 2026-06-21

### Why

Three UX fixes to the pinnable explanation/definition box: (1) put Delete at
the bottom-left of the box; (2) a long follow-up thread ran off the bottom of
the screen — it should scroll inside the box instead; (3) let the reader resize
the box from any edge/corner with the text reflowing to fit.

### What changed (frontend only)

- `ExplanationTooltip.ts`
  - Footer is now `[Delete | Ask a follow-up ›]`. Delete calls the highlight's
    `onDelete`, so `bindBlueAnnotation(group, doc, id, text, onDelete)` gained a
    param; `show()`/re-bind capture it as `activeOnDelete`. Delete is shown in
    every state (incl. error/empty) so a blue highlight is always removable.
  - Pinned panel is a flex column capped at `calc(100vh - 24px)`; the thread is
    the sole scroll region (`flex:1; min-height:0; overflow-y:auto`). `position()`
    now sets `display:flex` when pinned and clamps vertically so it never runs
    off-screen. Fixed the bug where `position()` forced `display:block` and broke
    the flex layout.
  - Eight resize handles (n/s/e/w + corners), shown only when pinned, dragged via
    pointer events (`startResize`). Once dragged, `userSized` makes `position()`
    leave geometry alone; `hide()` resets it and clears inline width/height.
- `AnnotationLayer.ts` — blue highlights use the in-box Delete (no standalone
  pill); every other color keeps the standalone hover pill.
- `HighlightHoverActions.ts` — that pill now anchors at the highlight's
  **bottom-left** (was top-right).
- `styles.css` — `.is-pinned` flex/scroll/`overflow:hidden`; footer space-between
  + `.explanation-tooltip-delete`; `.explanation-resize-handle` edge/corner specs
  positioned just inside the border (so `overflow:hidden` doesn't clip them).

### Tests (132 frontend + 102 backend)

`ExplanationTooltip.test.ts` grew to 5: open-chat, footer Delete → onDelete, SE
resize drag, Escape, dismiss-on-delete. `RESIZE_MIN_W/H = 260/200`.

### Notes

- No browser in the container, so resize/scroll were verified via jsdom unit
  tests + review, not a live drag. Still needs a real-browser eyeball.
- Native CSS `resize` only does the SE corner, so the 8-way handles are custom.

---

## Tooltip chat + refine, and hover-to-delete — 2026-06-21

### Why

Two requests against the blue-highlight explanation feature: (1) when a
definition/explanation isn't good enough, let the reader chat to clarify, then
fold the useful parts back into the tooltip; (2) replace the `window.confirm`
click-to-delete with a hover "Delete" button. (This branch was fast-forwarded
onto `dazzling-hypatia-wiv6h5`, which is where the explanation feature lives.)

### Backend (`app/routes/explanations.py`)

- Refactored the Claude stream into `_stream_anthropic(model, system, messages,
  max_tokens)` + `_pdf_document_block(pdf_b64)`; `_stream_claude` now delegates.
- `POST …/chat` — streams an assistant reply (SSE, same wire format as
  `/explain`). The PDF + the tooltip context (highlighted text + current
  content) ride on the first user turn via `_build_chat_messages`; the rest of
  the thread is sent verbatim. Uses `MODEL_EXPLANATION`, 400 tok, `SYSTEM_CHAT`.
- `POST …/refine` — one-shot rewrite that folds the conversation back into the
  tooltip. On a clean finish it calls `_save_refined` (UPSERT into
  `explanations`, status `complete`) so the new text is served on reload and
  inlined by `GET /annotations`. A failed refine never overwrites existing text.
- No schema change — refine reuses the `explanations.content` column.

### Frontend

- `api.ts` — `streamChat` / `streamRefine` over a shared `consumeSSE` reader.
- `explanationStore.ts` — per-annotation `ChatThread` ({messages, streaming,
  refining, error}) plus `sendChatMessage`, `refineFromChat`, `getChat`,
  `_resetForTest`. Refine streams live into the body as `loading` then `ready`.
- `ExplanationTooltip.ts` — the hover tooltip is now *pinnable*. Collapsed: a
  bottom-right "Ask a follow-up ›" affordance. Click → `pinned=true`: auto-hide
  and hover-switching are disabled, a close (×) appears, and a thread + input +
  "Update explanation" button show. `pinned` is the key new module flag guarding
  `hide`/`scheduleHide`/`onMove`.
- `HighlightHoverActions.ts` (new) — hover any highlight → a "Delete" button at
  its top-right. Same page-wrap mousemove hit-test trick the tooltip uses (the
  text-layer overlays the SVG so `mouseenter` on groups doesn't fire).
- `AnnotationLayer.ts` — dropped the `window.confirm` click path; binds
  `bindHighlightActions` for every highlight. Erase-mode click-delete unchanged.

### Tests (now 127 frontend + 102 backend)

- Backend: `tests/integration/test_explanation_chat.py` — chat/refine 404 +
  422 validation, the no-API-key SSE error path, refine-doesn't-overwrite, and
  `_save_refined` persistence.
- Frontend: `explanationStore.chat.test.ts` (6) + `HighlightHoverActions.test.ts`
  (2); updated `AnnotationLayer.test.ts` (plain click no longer deletes).

### Notes / followups

- Chat threads are in-memory (frontend store) — they don't survive reload; only
  the refined tooltip text persists. Persisting the thread would need a table.
- No `ANTHROPIC_API_KEY` in this container, so chat/refine were verified
  structurally (validation + no-key error path), not against a live model.
- Fresh container had no `backend/.venv`; recreate with `python3.12 -m venv` +
  `pip install -e ".[test]"` (the `>=3.12` floor rejects the default 3.11).

---

## Data-loss bug: re-upload wiped highlights — 2026-06-18

### The bug

User reported "When I hit openpdf and reupload the pdf, the highlights don't persist." Confirmed with a curl repro: 6 annotations → POST same file → 0 annotations.

Root cause: `app/routes/documents.py` used `INSERT OR REPLACE INTO documents`. SQLite implements REPLACE as DELETE-then-INSERT, and the annotations table has `REFERENCES documents(id) ON DELETE CASCADE`. So every re-upload of the same PDF cascaded into a wipe of every saved highlight for that document.

This had been the case since Phase 1. The user only hit it now because the new Library tile made re-opening feel like a normal action.

### Fix

`documents.py` now uses a proper UPSERT:

```sql
INSERT INTO documents (...) VALUES (...)
ON CONFLICT(id) DO UPDATE SET
  filename = excluded.filename,
  page_count = excluded.page_count,
  title = excluded.title,
  author = excluded.author,
  size_bytes = excluded.size_bytes
```

ON CONFLICT...DO UPDATE updates the row in place — no DELETE, no cascade, annotations stay put.

### Regression test

`tests/integration/test_annotations.py::test_reupload_preserves_existing_annotations`. Upload → create highlight → re-upload same file → assert highlight survives with same id and color.

### Backups + data restore

While diagnosing, the user's 6 prior highlights had already been wiped by previous re-uploads. A backup remained in `/tmp/pdf_reader_dev/reader.db` (from earlier debug sessions). Migrated those back into the active `backend/data/reader.db` with `INSERT OR IGNORE` and verified they now survive a fresh re-upload.

### Tests

- Backend: 75 (+1 regression)
- Frontend: 54 (unchanged)
- Total: 129

---

## Recent documents library + Cmd-S trap — 2026-06-18

### Why

User reported: "I want highlights to persist if I close the reader and reopen the document." Highlights *do* persist — they're keyed by SHA-256 in SQLite and the same file always resolves to the same doc_id. The friction was that the empty viewer state offered no way to re-open a prior document; the user had to re-pick the file from disk every session. That felt like data loss.

### Files added

- `src/Library.ts` — fetches `GET /documents`, renders one tile per doc with title / page count / author / size. Click → caller's `onOpen` fires with the `LibraryDocument` and the existing `renderDocument` pipeline takes over.
- `src/Library.test.ts` — 6 tests (formatSize, tiles render, empty state, fetch-error state).
- `src/api.ts` — added `LibraryDocument` interface and `listDocuments()`.

### main.ts changes

- Initial state shows the library (`showLibrary()` runs on load).
- Tile click → `renderDocument(doc)`. The existing `PageView` flow then auto-loads annotations per page through `listAnnotations`.
- Cmd/Ctrl-S is now intercepted to prevent the browser's "save page" dialog from confusing the user (they reported reaching for it as if it were the highlight-save action). Replaced with a transient toast: "Highlights save automatically — no manual save needed."

### CSS

`.library`, `.library-tile`, `.library-empty`, `.toast` styles added to styles.css. Grid layout `repeat(auto-fill, minmax(260px, 1fr))` for tiles. Toast uses a small fade-out at 1.8 → 2.2 s.

### Tests now

- Frontend: 54 (+6 Library)
- Backend: 74 (unchanged)

### Followups

- The library currently lists ALL uploaded documents, no delete UI. Worth adding.
- No filtering / search yet — fine for tens of documents.
- The Cmd-S trap also blocks Cmd-S from saving in any future text input we add; revisit when we add forms.

---

## Highlight rendering fix (was: "highlights not saving") — 2026-06-18

### Symptom

User reported highlights were not saving. They were — every drag in highlight mode was hitting `POST /annotations` with 200 OK (visible in uvicorn logs). The actual bug: each saved highlight had **dozens of tiny rectangles** (one per text-run span), and `mergeAdjacentLineRects` was only joining rects whose x-gap was < 1px. Word-spans have multi-pixel gaps between them, so they stayed as separate fragments. The yellow color rendered as a row of barely-visible scraps instead of a clean block.

### Two-part fix

1. `mergeAdjacentLineRects` now does a proper **per-line union** (bucket by y within 3px, then union x ranges) — same shape as `LiveSelectionLayer.groupAndMergeByLine`. Going forward, saved highlights have one rect per line.
2. `AnnotationLayer.buildAnnotationLayer` also calls `mergeAdjacentLineRects` at render time. This means **legacy highlights** already in the SQLite DB (saved with many scrappy rects before this fix) now render cleanly without a DB migration.

### Tests

- Added: regression test "merges word-rects with big x gaps on the same line" — directly captures the failing case
- Added: tolerance test "treats rects within 3px of each other as the same line"
- Total frontend: 48 (was 46)
- Backend: 74 (unchanged)

### Files changed

- [selection.ts](frontend/src/viewer/selection.ts) — `mergeAdjacentLineRects` rewritten as per-line union
- [selection.test.ts](frontend/src/viewer/selection.test.ts) — +2 tests
- [AnnotationLayer.ts](frontend/src/viewer/AnnotationLayer.ts) — merges before rendering

---

## Smooth selection rendering (Mac Preview parity) — 2026-06-18

### What changed

User compared our selection against Mac Preview side-by-side. Mac Preview shows one clean rectangle per line; ours showed a row of tiny per-span boxes with hairline gaps between them. Cause: the browser's default `::selection` paints once per inline box, and our text layer has one absolutely-positioned `<span>` per text-run (word or fragment), so a selected line shows many fragmented boxes.

### Fix

[LiveSelectionLayer.ts](frontend/src/viewer/LiveSelectionLayer.ts) — new SVG overlay that renders the live (in-progress) selection ourselves:

1. CSS makes the native `::selection` transparent so the browser's per-span boxes don't paint.
2. A single document-level `selectionchange` listener dispatches to every registered page wrap.
3. `Range.getClientRects()` returns one DOMRect per inline box. We group them by `top` (within 3px tolerance), then take the union per line. Output: one merged rect per visual line.
4. Each merged rect becomes an `<svg><rect>` painted at `rgba(79, 140, 255, 0.4)`.

The layer sits below the annotation layer so saved highlights remain visible during selection; both are semi-transparent so they blend rather than occlude.

### Tests

- New: `LiveSelectionLayer.test.ts` — 7 tests for `groupAndMergeByLine` (same-line merging, multi-line separation, 3px tolerance, zero-rect filtering, container-origin subtraction, 3×3 grid).
- Frontend total: 46 (was 39).
- Backend unchanged: 74.

### Z-order in PageView now

1. `<img>` (page raster)
2. `<svg class="live-selection-layer">` (current selection)
3. `<svg class="annotation-layer">` (saved highlights)
4. `<div class="text-layer">` (invisible spans intercepting mouse)

Selection background is now a smooth line-merged blue overlay. Should match Mac Preview's visual cleanliness.

### Followups

- The selection rects extend exactly to where the actual text ends on each line; they don't auto-extend to the column right edge. Mac Preview does the same. If the user wants "column-width" selections (highlight whole line regardless of where text ends), that's a different request.
- Performance: `selectionchange` fires ~60Hz during drag. The SVG rebuild is cheap (handful of rects), but for very-long selections across many lines it could be optimized by reusing existing `<rect>` elements instead of clearing/rebuilding.

---

## Constraint removed — cross-column selection enabled — 2026-06-18

### Why

After the column-detection v2 fix shipped clean DOM columns, the user re-tested and reported they wanted to be able to drag-select across columns intentionally (top-right to bottom-left and vice versa). The constraint installed in Phase 6.1 was blocking that.

The constraint was originally a defense-in-depth measure against bleed before column detection was reliable. With detection now correct (clean `.text-column` containers, every body run in the right column), the DOM structure alone prevents the original bleed bug: within-column drag stays within column because spans are siblings, and cross-column drag does the natural reading-order thing.

### What changed

[PageView.ts](frontend/src/viewer/PageView.ts) no longer calls `installColumnConstraint(wrap)`. The constraint module (`columnConstraint.ts`) and its 8 tests are kept as dead code in case we want an opt-in column lock later (e.g. Shift+drag to clamp).

### Trade-off the user accepted by asking for this

If the user drag-selects within a column but **overshoots** the gutter at the end of the drag, the selection will include some text from the other column. The original "bleed bug" they showed me was a *misclassification* problem (left col runs in right col DIV); that's fixed. Overshoot bleed is a different category and is the standard PDF.js behavior.

### Tests

74 backend + 39 frontend = 113. Unchanged from previous: the column constraint helpers (`columnOf`, `clampFocusToColumn`, `clipRangeToColumn`) still have unit tests, just no production caller.

---

## Phase 3 column-detection v2 + anchor-preserving constraint — 2026-06-18

### Two follow-ups after user testing

User reported (a) text from left column was rendering as if it belonged to the right column, and (b) backward drags (top-right → bottom-left) broke. Both were real.

### Backend: body-font filter

Before clustering, filter runs to the page's dominant body font size. Without this, on a body page with lots of subscripts and inline math, the modal font ends up being something like 4.5pt (subscripts), which doesn't represent column structure at all — page 5 of the Virtual Lab paper regressed to 1 column when I first tried filtering.

Two key constants in [columns.py](backend/app/pdf/columns.py):
- `MIN_BODY_FONT_PT = 6.0` — exclude sub/superscripts from the mode candidates
- `MIN_BODY_RUN_RATIO = 0.15` — fall back to all runs when no font dominates

Post-fix probe of Virtual Lab paper, pages 1-15: every page detects 2 columns with col-1 right edge ~295pt and col-2 left edge ~300pt. Page 1 col-1 still extends to x=561 because of the full-width title (whose runs are assigned to col 1 by virtue of starting near the left margin), but the assignment boundary remains at 304, so right-column text stays cleanly in the right column DOM.

### Frontend: anchor-preserving selection clip

The old constraint built a new Range with `setStart`/`setEnd`, which loses the anchor/focus distinction. When the user dragged backward (started in right col, dragged up-left to left col), the clip rebuilt the range from "start of right col" → "user's anchor in right col", which felt broken.

Now in [columnConstraint.ts](frontend/src/viewer/columnConstraint.ts):
- New `clampFocusToColumn(anchor, focus, targetCol)` picks the end of the column or the start, based on `compareDocumentPosition(focus)` — forward drag clamps focus to end of column; backward drag clamps to start.
- `handleSelectionChange` calls `Selection.setBaseAndExtent(anchorNode, anchorOffset, clampedNode, clampedOffset)`. Anchor stays exactly where the user clicked down.
- Old `clipRangeToColumn` is kept and tested for any Range-based callers.

### Tests now

- Backend: 74 (unchanged; existing column tests still pass with body filter)
- Frontend: 39 (+1 forward-drag clamp + 1 backward-drag clamp + 1 empty-column null + same legacy clipRange tests)

### Open items

- Cross-column intentional selection: the user wanted to be able to drag from top-right to bottom-left across both columns sometimes. Currently the constraint always clips to start col. Possible v2: hold Shift to disable clipping, or geometric heuristic for "deliberate" cross-col drags.
- Title page (page 1) still has col 1's bbox extend across full page because of the title. Assignments are correct, but if the user expects col 1's visible bbox to be ~280pt wide, that's a known cosmetic limit.
- The `MIN_BODY_FONT_PT = 6.0` cutoff was chosen for academic papers. For e-books or comics it'd need tuning.

---

## Phase 3 column-detection rewrite — 2026-06-18

### Bug

After Phase 6.1 the user re-tested column bleed in plain (non-highlight) selection on the Virtual Lab paper and it was still broken. Diagnosis: the `cluster_into_columns` heuristic was reporting **1 column** for every page of that paper despite the obvious 2-column layout. Frontend's column-constraint logic was correct but inert — the DOM had a single `.text-column` containing everything, so cross-column selection was technically *within* a single column.

Root cause: the old "vertical gutter coverage profile" used a binary "is any text covering this x?" sweep. Full-width runs (page title, headers, page numbers, footnotes) bridged the gutter and the algorithm couldn't see it. Lots of PDFs have these; the heuristic was brittle.

### Fix

`backend/app/pdf/columns.py` rewritten end-to-end. Algorithm now is left-edge histogram + peak detection:

1. Histogram run `x0` values into 30pt buckets
2. Keep buckets with `≥ max(3, sqrt(total))` runs
3. Sort by x. If 3+ candidates with uneven gaps (>15% deviation from mean), drop to top 2 by count — handles "right-edge clusters within a column" false positives
4. Reject if minimum inter-peak gap < 140pt (avoids splitting tight layouts)
5. Boundaries placed at the **start of the next peak's bucket**, not the midpoint — runs near the right edge of column 1 (long words near gutter) stay in column 1
6. Assign each run by `x0`

### Validation

Live probe of `Virtual Lab.pdf` after the fix:
```
page 1: cols=2  ranges=[(40, 508), (214, 562)]   (title page, partial leak — acceptable)
page 2: cols=2  ranges=[(40, 357), (306, 561)]
page 3: cols=2  ranges=[(40, 295), (306, 561)]
page 5: cols=2  ranges=[(40, 297), (300, 561)]
page 8: cols=2  ranges=[(40, 295), (306, 561)]
```
Body pages: clean. Title pages with abstract/headings have minor leaks but the gutter is still respected on most runs.

### Tests added

- `tests/unit/test_columns.py::test_full_width_headers_do_not_break_column_detection` — the specific regression: 2 columns + 3 full-width header runs. Old algorithm: 1 col. New: 2 cols.
- Renamed `test_gap_below_threshold_does_not_split` → `test_columns_too_close_fall_back_to_single` (uses the new MIN_COLUMN_GAP_PT = 140 instead of the removed 18pt-gap heuristic).
- All other column tests pass unchanged. 74/74 backend tests green.

### Open follow-ups

- Title pages with centered abstracts / single-col regions inside a 2-col paper still leak slightly. Real fix would be y-banded column detection (different columns in header vs body bands).
- The 30% gap-uniformity threshold was tuned heuristically against the Virtual Lab paper; may need tuning for tri-column or unusual layouts.
- The frontend column constraint code is unchanged — it just now has real columns to constrain to.

---

## Phase 6.1 UX rework — 2026-06-18

### Two issues addressed

**Issue A — column bleed in plain selection.** Phase 3's per-column DOM only helped one direction (top-to-bottom in a single column). It did NOT stop the browser's Selection API from spanning across sibling columns when the drag ended in a different column. User reported the original column-bleed bug returning in highlight mode.

**Issue B — UX.** The per-page floating toolbar over a fresh selection was clunky. User wanted Edge's pattern: a Highlight button on the nav bar with a color picker, click → highlight mode active → drag-select auto-saves.

### Fixes

**Column-bleed clipping (`src/viewer/columnConstraint.ts`)**
- `installColumnConstraint(wrap)` per page-wrap: tracks the `.text-column` where mousedown landed
- A single global `selectionchange` handler clips the live selection range to stay inside the start column
- Pure helpers (`columnOf`, `clipRangeToColumn`) are exported and unit-tested in isolation — 7 tests covering each cross-column direction + the "neither endpoint inside" pin-to-column fallback

**Highlight mode + nav button**
- `src/highlightMode.ts` — tiny pub/sub state machine: `{active, color}`, `subscribeHighlightMode`. 5 unit tests.
- `src/HighlightButton.ts` — nav-bar button with color indicator + popover. Click → opens popover → swatch click sets `{active:true, color}`, "Off" or re-click button sets `{active:false}`. 6 unit tests.
- `src/main.ts` — installs button into `#highlight-button-slot`. Sets `html[data-highlight-active]` for global styling (currently: `cursor: cell` over text columns when active).
- `src/viewer/PageView.ts` — removed the floating per-page toolbar. On mouseup, if `getHighlightMode().active`, capture selection rects → save → clear selection → re-render annotations.
- `src/viewer/HighlightToolbar.ts` deleted (replaced by `HighlightButton`).

### Tests now

- Backend: 73 (unchanged from 6.0)
- Frontend: 38 (was 23; +7 columnConstraint, +5 highlightMode, +6 HighlightButton; -3 HighlightToolbar dropped)

### Z-order is unchanged from Phase 6

1. `<img>`
2. `<svg class="annotation-layer">`
3. `<div class="text-layer">` (above; intercepts mouse)
4. (No floating toolbar — replaced by nav button)

### Live env

Uvicorn :8000, Vite :5173. HMR will pick up TS/CSS changes; the user just needs to hard-refresh the page.

### Known limits / followups

- The `selectionchange` clipping uses a re-entry guard but can in theory infinite-loop if another listener also mutates the selection. None do today.
- The clipping is only installed on page-wraps that have a fully loaded text layer. Pages whose text fetch failed silently won't have constraints — fine for now since selection won't work there anyway.
- Edge actually has 4 colors (Y/G/B/R); we ship 5 per user request (added pink).
- Pen cursor: I used `cursor: cell` because we don't have a custom SVG cursor yet. Could swap in a marker SVG later.

---

## Phase 6 ships (highlights with persistence) — 2026-06-18

### What works now

Drag-select text → 5-color floating toolbar (yellow/blue/red/green/pink, in Edge order) → click a color → highlight saves to SQLite, appears as SVG overlay, survives reload. Click an existing highlight → confirm → delete.

### Files

**Backend**
- `app/routes/annotations.py` — `POST /documents/{id}/annotations`, `GET ?page=N`, `DELETE /annotations/{aid}`. Pydantic validates color is one of 5 enum values; rects required non-empty (explicit check after Pydantic since min_length swallowed empties).
- `app/main.py` — registers router.
- SQLite `annotations` table already in `storage/db.py` from Phase 1, payload is JSON: `{color, rects:[{x0,y0,x1,y1}]}` in **page-space** (PDF points), top-left origin.

**Frontend**
- `src/viewer/AnnotationLayer.ts` — builds an `<svg>` overlay; one `<g class="annotation">` per highlight, one `<rect>` per stored rect; click dispatches confirm dialog → onDelete callback.
- `src/viewer/HighlightToolbar.ts` — palette as `<button class="swatch">` with `data-color`; `mousedown` `preventDefault` to keep the selection alive when clicked.
- `src/viewer/selection.ts` — `clientRectsRelativeTo` + `rectsToPageSpace` + `mergeAdjacentLineRects` (collapses adjacent same-line rects to fewer SVG nodes).
- `src/viewer/PageView.ts` — orchestrates everything. Loads page → text layer + annotation layer in parallel → wires mouseup → toolbar → save → re-render layer.
- `src/api.ts` — `HIGHLIGHT_COLORS`, `createHighlight`, `listAnnotations`, `deleteAnnotation`.
- `src/styles.css` — `.annotation-layer`, `.highlight-toolbar`, `.swatch` (24px circular buttons, hover-scale).

### Tests (88 total)

- Backend: 73 (added 13 annotation integration tests covering all 5 colors, invalid color, empty rects, unknown doc, list filter, delete, persistence)
- Frontend: 23 vitest (added 5 AnnotationLayer tests + 3 HighlightToolbar tests + 5 selection coordinate tests)

### Layout, in z-order, bottom→top

1. `<img class="page">` — rasterized PDF page
2. `<svg class="annotation-layer">` — saved highlights (pointer-events: none on layer, auto on per-annotation `<g>`)
3. `<div class="text-layer">` — transparent selectable spans (above so selection sees them)
4. `<div class="highlight-toolbar">` — palette, positioned absolutely on mouseup near selection

The annotation layer goes BELOW text-layer because text-layer needs to intercept drag-selection mouse events first. Highlights remain visible because text-layer spans are transparent.

### Live env

Backend: uvicorn on :8000 (currently PID 72447, check `lsof -ti tcp:8000`).
Frontend: vite on :5173 (PID 71221, originally launched by user).
HMR will pick up any further CSS/TS edits.

### Followups

- ESLint/Prettier — not yet wired
- Phase 2 (zoom): when zoom lands, annotations need to re-render at new geometry. Already plumbed via `state.geom` in PageView; just rebuild the SVG on resize.
- Phase 5 (search): independent
- Phase 4 (outline): independent
- Tune color alphas: current values (yellow 0.42, red 0.28) chose for legibility over text; if a color is too faint over body text, bump alpha
- The two-confirm UX for delete (browser `confirm()`) is functional but not pretty — a hover popover would be nicer
- Edge cases not yet tested: highlight that crosses a column boundary (selection generates rects for both columns; backend stores them both, renders both)
- The mouseup handler attaches per page-wrap and never detaches — fine for a session, would leak across many doc reloads. Cleanup needed if we later support tab-switching between docs.

---

## Phase 3 in progress — 2026-06-18

### What shipped (text selection foundation)

User discovered they could "highlight" text on Animal_farm.pdf — that turned out to be **macOS Live Text** OCR-ing our `<img>`, not our app. With column bleed and OCR errors. Phase 3 replaces that with the real PDF.js trick: invisible-but-selectable `<span>` overlay using **actual** PDF text + bboxes, with **per-column DOM containers** to kill the bleed bug.

### Files added/changed

**Backend**
- `app/pdf/columns.py` — `cluster_into_columns(runs, page_width_pt)`. 1-D coverage-profile sweep over the page width; finds vertical gutters ≥ 18pt wide; bucketizes runs by x-centroid. Falls back to 1 column when no gutter or too many candidates.
- `app/pdf/types.py` — added `TextColumn`. `PageText` now carries both flat `runs` (back-compat) and clustered `columns`.
- `app/pdf/pdfium_backend.py` — `get_page_text` now calls `cluster_into_columns` and populates `columns`.
- `app/routes/text.py` — new `GET /documents/{id}/pages/{n}/text` returning `{page_width_pt, page_height_pt, columns: [{bbox, runs:[{text,bbox,font_size}]}]}`.
- `app/main.py` — registers the text router.
- `tests/fixtures/build_fixtures.py` — added `two_column.pdf` fixture.

**Frontend**
- `src/api.ts` — `fetchPageText()` + types.
- `src/viewer/coords.ts` — page-space ↔ viewport-space transforms.
- `src/viewer/TextLayer.ts` — builds invisible overlay; one `<div class="text-column">` per column, transparent `<span class="text-run">` per run, positioned in pixels.
- `src/viewer/PageView.ts` — composes image + text layer; text loads lazily after image's `load` event so we have real `clientWidth`.
- `src/main.ts` — refactored to use `buildPageView`.
- `src/styles.css` — `.text-layer`, `.text-column`, `.text-run` styles; `color: transparent` keeps it invisible while keeping text selectable; per-column `pointer-events: auto`.
- Vitest + jsdom added (`package.json`, `vite.config.ts`).

### Test counts now

- 59 backend (was 43): added `tests/unit/test_columns.py` (9), 3 contract tests for column extraction, 4 integration tests for `/text` endpoint
- 10 frontend: `coords.test.ts` (5 — round-trip identity at varying zooms), `TextLayer.test.ts` (5 — column container structure, no cross-bleed in DOM)

### Verification status

Backend: contract tests assert real two-column fixture produces 2 columns with no left/right text mixing. `/text` endpoint integration tests confirm wire format.
Frontend: jsdom tests assert `buildTextLayer` produces 1 `.text-column` per detected column with the right `.text-run` spans inside.
**Open**: end-to-end browser drag-selection test not yet automated — user will exercise manually.

### Live env

Uvicorn running on :8000 (PID was 71437 last I checked; check with `lsof -ti tcp:8000`). Vite running on :5173 (PID 71221). User should refresh http://localhost:5173 → re-upload PDF → drag-select. Multi-column papers should now select within column only.

### Followups (deferred)

- Phase 6 (highlight persistence): now unblocked — text layer is in place
- Zoom / nav: Phase 2 work — still pending
- The Vite-deprecation warning about httpx is cosmetic; ignore
- The TestClient lifespan caveat: `with TestClient(app)` is required, the `app_client` fixture handles this already
- Column heuristic constants (`DEFAULT_MIN_GAP_PT = 18.0`, `DEFAULT_MAX_COLUMNS = 4`) might need tuning on real-world papers — flag any over/under-splitting

---

## Phase 1.1 hotfix — 2026-06-18

### Bug: PDFium segfault on multi-page document load

User reported `zsh: segmentation fault` from uvicorn whenever they opened the Animal_farm.pdf (44 pages). Reproduced: the upload itself was fine, but the frontend then fires 44 concurrent page-image requests, FastAPI dispatches each sync handler to a threadpool worker, and concurrent calls into libpdfium crash because **PDFium is not thread-safe**.

### Fix

`backend/app/pdf/pdfium_backend.py` — module-level `threading.RLock` (`_PDFIUM_LOCK`) acquired in every public method (`open`, `close`, `metadata`, `page_count`, `page_dimensions`, `render_page`, `get_page_text`, `get_outline`). Coarse but correct; kills the crash.

### Regression test

`backend/tests/integration/test_concurrent_renders.py` — uses a `ThreadPoolExecutor(16)` to fire 32 parallel page-render requests through `TestClient`, asserts every one returns a valid PNG and the process doesn't die.

### Also fixed in same hotfix

`frontend/src/styles.css` — `.page-wrap` had no width, so even when images loaded the layout collapsed to icon-sized boxes. Now `width: 100%; max-width: 900px;` on `.page-wrap` and `width: 100%` on `.page`. Live-reloaded via Vite HMR.

### Verification

- 43/43 tests passing
- Reproduced original crash against live uvicorn (44 renders → process died)
- After fix: 44/44 renders return 200, uvicorn still alive
- User can now retry the Animal_farm.pdf upload

### Followup for Phase 2

Coarse global lock will hurt throughput once we add zoom (re-renders at new DPI) and multiple-doc viewing. Plan: keep an LRU of opened `PdfiumBackend` instances per doc_id, and replace the single global lock with per-instance locks. Defer until proven needed.

---

## Phase 1 complete — 2026-06-18

### What shipped

End-to-end Phase 1 of the plan: web PDF reader that opens a PDF, displays every page as PNG, with the full testing scaffold in place.

**Backend** (`backend/`, Python 3.12, FastAPI + pypdfium2):
- `app/pdf/backend.py` — `PdfBackend` abstract interface (the keystone — every future from-scratch impl satisfies this)
- `app/pdf/pdfium_backend.py` — v1 impl wrapping pypdfium2 (Apache 2.0, same engine as Edge)
- `app/pdf/types.py` — `BBox`, `TextRun`, `PageText`, `PageDimensions`, `OutlineNode`, `DocumentMetadata`
- `app/storage/db.py` (SQLite schema: documents + annotations) and `app/storage/files.py` (SHA-256-keyed PDF + render cache)
- `app/routes/documents.py`, `app/routes/pages.py`, `app/routes/deps.py`, `app/main.py`, `app/config.py`

**Frontend** (`frontend/`, Vite + TypeScript):
- `index.html`, `src/main.ts`, `src/api.ts`, `src/styles.css` — upload PDF, render every page as `<img>` (lazy loaded)

**Tests** — 42 passing, four layers:
- `tests/contract/test_backend_contract.py` (14) — the parametrized spec every backend must satisfy
- `tests/contract/test_visual_goldens.py` (8) — render PNGs vs `tests/goldens/`, SHA → pixel → SSIM ladder
- `tests/integration/test_routes.py` (10) — FastAPI TestClient, isolated tmp dirs
- `tests/unit/test_outline_tree.py` (6), `tests/unit/test_storage_files.py` (4)
- `tests/conftest.py` — `--update-goldens` flag, `app_client` fixture, `assert_golden` fixture
- `tests/fixtures/build_fixtures.py` — deterministic reportlab-generated PDFs

**CI** — `scripts/ci.sh` runs pytest + tsc + vite build. All green.

### Run / verify

```bash
./scripts/ci.sh
# OR
cd backend && .venv/bin/pytest -v
cd frontend && npm run build
```

### Environment

- Python 3.12 venv at `backend/.venv` (don't recreate — already has deps)
- Node deps at `frontend/node_modules`
- `npm`/`uvicorn` are NOT auto-allowed to run as a dev server by the auto-mode classifier — TestClient was used instead for verification. If user needs a live dev server, they should launch it manually or grant the permission.

### Next: Phase 2 — multi-page navigation + zoom

- Frontend: virtualized scroll list (only render `<img>` for pages near viewport)
- Zoom toolbar: 50–400%, fit-width, fit-page. Re-requests at new DPI.
- Page-number indicator + jump-to-page
- Tests required before "done": unit tests for zoom math + virtualized-scroll window calc, visual goldens at 75%/150%/300% DPI, integration test for varied DPI request
- Existing scaffold already supports DPI as a query param; the work is mostly client-side

### Gotchas the next session should know

- `dpi or default_dpi` is wrong for query-param parsing (0 is falsy); use `default if dpi is None else dpi` — already fixed in `pages.py` but be aware when adding more numeric query params
- `pypdfium2` raises `FileNotFoundError` (not `PdfiumError`) on missing files — `PdfiumBackend.open` catches both
- Page coordinates in the `BBox` type are **top-left origin** (image space), not PDF native (bottom-left); `PdfiumBackend.get_page_text` does the conversion
- Visual goldens were generated on macOS arm64 with pypdfium2 4.30; cross-platform CI may hit the SSIM tier (0.995) rather than pixel-perfect — that's expected
