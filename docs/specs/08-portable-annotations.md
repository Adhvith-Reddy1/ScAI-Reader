# Spec 08 — Portable annotations (share a PDF with its citations)

**Branch:** `feat/08-portable-annotations` · **Wave:** 3 · **Depends on:**
Spec 02 (storage) and Spec 06 (explanation cache), both landed on this branch's
base. **Full UI end-to-end also needs Spec 05** (highlights in IndexedDB).

## Goal
Let a reader **download their annotated PDF, send it to a friend, and have the
friend open it with the same highlights and AI explanations** — no LLM calls to
regenerate anything. This turns explanations into shareable artifacts and makes
the expensive AI work a one-time cost per document, not per reader.

## Why this works
A document's id is the **SHA-256 of its bytes** (`doc_id`, computed identically
on server and client). So the same file yields the same id for everyone — the
only thing missing was a way for the annotation *rows* to travel. Option B
(chosen): embed them **inside the PDF** so there's a single file to share.

## Design
Client-side, dependency-free, built on the frozen Shared Contract A:

- **`storage/portableBundle.ts`** — `exportBundle(docId, now, filename?)` reads
  a document's `annotations` + `explanations` out of IndexedDB into a versioned,
  self-describing JSON bundle stamped with the original `docId`.
  `parseBundle` validates it; `importBundle(bundle, targetDocId?)` writes the
  rows back, **re-keyed** to the id the receiver computed for the file it opened
  (idempotent — `put*` overwrites by key, so re-import merges cleanly).
- **`storage/pdfSidecar.ts`** — `embedBundleInPdf(pdfBytes, json)` appends the
  base64 bundle after the PDF's bytes, wrapped in sentinel markers; every viewer
  ignores trailing bytes after `%%EOF`, so the file still opens normally.
  `extractBundleFromPdf` / `hasBundle` / `stripBundle` recover it.
- **`storage/localStore.ts`** — added `listExplanations(docId)` (additive,
  non-breaking) so all of a document's explanations (annotation *and* figure)
  can be exported in one query.

### The hash subtlety
Embedding the bundle changes the file's bytes, hence its `doc_id`. That's fine:
`importBundle` re-keys rows to the id the receiver computes for the file they
opened, so everything stays self-consistent. The bundle still carries the
original `docId` for provenance/verification. `stripBundle` recovers the exact
original bytes when needed.

## Out of scope (this branch)
- **UI wiring** — a "Share (with annotations)" export button and an
  import-on-open flow in the library/toolbar. These touch `main.ts`/`Library.ts`
  and overlap Spec 04/05; land them once those are in.
- **Trust/provenance UX** — whether an imported explanation is shown as-is or
  marked "shared, not regenerated", and whether to re-verify. Recommended:
  display with a subtle "shared" marker; never silently trust for re-generation.
- **Native PDF markup annotations** (highlights visible in other PDF viewers) —
  a nice interop layer to add on top later.

## Testing
- **Vitest:** `portableBundle.test.ts` (export scope + isolation, parse
  validation, import re-key/idempotency), `pdfSidecar.test.ts` (embed/extract
  round-trip incl. unicode, prefix-preservation, strip, re-embed replace),
  `localStore.test.ts` (+`listExplanations`).
- **Playwright:** `portableBundle.persistence.spec.ts` — annotate → embed →
  wipe IndexedDB (fresh browser) → open the file → extract + import → the
  explanation hydrates from the restored cache with **zero `/ai/explain` calls**.

## Acceptance criteria
- [x] Export a document's annotations + explanations to a portable bundle.
- [x] Embed/extract the bundle in a PDF without breaking the file.
- [x] Import restores rows (re-keyed) so cached explanations serve with no LLM call.
- [x] Vitest + Playwright pass; build passes.
- [ ] UI export/import buttons (follow-up, after Spec 05).
