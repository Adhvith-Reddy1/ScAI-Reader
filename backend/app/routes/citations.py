"""Citation detection and reference-resolution endpoints.

Two endpoints, mirroring the figure module's "cheap per-page detection +
cached heavier resolution" split:

* ``GET /documents/{doc_id}/pages/{n}/citations`` — stateless regex sweep that
  returns the clickable in-text citation markers on one page (bbox + the
  reference numbers each points to). See ``app/pdf/citations.py``.

* ``GET /documents/{doc_id}/references`` — the parsed bibliography as
  ``{number, authors, title}`` rows. The reference list is extracted from the
  document text and parsed once by Claude, then cached in SQLite. A
  ``reference_runs`` row makes the parse single-flight: the first caller does
  the work, concurrent callers get ``status: "pending"`` and poll.

Matching a marker to a reference is a plain integer lookup on the client, so it
works whether or not the PDF carried citation hyperlinks.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone

import anthropic
from fastapi import APIRouter, Depends, HTTPException

from ..config import Settings
from ..pdf.backend import PdfError
from ..pdf.citations import (
    CitationMarker,
    detect_citations,
    extract_references_text,
)
from ..pdf.pdfium_backend import PdfiumBackend
from ..storage import db, files
from .deps import get_settings

log = logging.getLogger(__name__)

router = APIRouter(prefix="/documents/{doc_id}", tags=["citations"])

MODEL_REFERENCES = "claude-sonnet-4-6"

# Bump whenever reference extraction/parsing improves so cached runs from an
# older version are re-parsed instead of served stale. v2: whole-document
# fallback + merged-heading detection (was: strict heading only).
REFERENCE_PARSER_VERSION = 2

SYSTEM_REFERENCES = (
    "You parse the reference list of an academic paper into structured data. "
    "You are given text extracted from the paper — ideally just the "
    "References/Bibliography section, but it may include surrounding article "
    "body, methods, or figure text, possibly with scrambled line wrapping from "
    "a multi-column layout. Find the numbered reference list within it and "
    "parse only those entries. Return ONLY a JSON array — no prose, no "
    "markdown, no code fences. Each element is an object with exactly these "
    'keys: "number" (integer — the citation number as it would appear in-text, '
    "e.g. 12 for a superscript or [12]; infer it from the entry's leading "
    "number whether written as '12.', '[12]', or '12)'), \"authors\" (string — "
    'the author names as written; if there are many, you may shorten to "First '
    'Author et al."), and "title" (string — the title of the cited work). Omit '
    "any entry whose number you cannot determine. Preserve the document's "
    "numbering exactly; do not renumber. If there is no reference list in the "
    "text, return an empty array []."
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _doc_exists(settings: Settings, doc_id: str) -> bool:
    return files.pdf_path(settings, doc_id).exists()


def _marker_to_dict(m: CitationMarker) -> dict:
    return {
        "marker_id": m.marker_id,
        "page": m.page_index + 1,
        "bbox": {"x0": m.bbox.x0, "y0": m.bbox.y0, "x1": m.bbox.x1, "y1": m.bbox.y1},
        "numbers": list(m.numbers),
        "raw": m.raw,
    }


@router.get("/pages/{page_number}/citations")
def list_page_citations(
    doc_id: str,
    page_number: int,
    settings: Settings = Depends(get_settings),
) -> dict:
    """In-text citation markers on a single page (stateless regex sweep)."""
    if not _doc_exists(settings, doc_id):
        raise HTTPException(status_code=404, detail="document not found")
    if page_number < 1:
        raise HTTPException(status_code=400, detail="page must be >= 1")

    try:
        with PdfiumBackend.open(files.pdf_path(settings, doc_id)) as backend:
            dims = backend.page_dimensions(page_number - 1)
            page = backend.get_page_text(page_number - 1)
    except PdfError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    markers = detect_citations(page)
    return {
        "doc_id": doc_id,
        "page": page_number,
        "page_width_pt": dims.width_pt,
        "page_height_pt": dims.height_pt,
        "citations": [_marker_to_dict(m) for m in markers],
    }


# --- Reference list parsing -------------------------------------------------


def _load_references(conn, doc_id: str) -> list[dict]:
    rows = conn.execute(
        "SELECT number, authors, title, raw FROM document_references "
        "WHERE doc_id = ? ORDER BY number",
        (doc_id,),
    ).fetchall()
    return [
        {
            "number": row["number"],
            "authors": row["authors"],
            "title": row["title"],
            "raw": row["raw"],
        }
        for row in rows
    ]


def _fresh_status(conn, doc_id: str) -> str | None:
    """Status of this doc's parse, but only if it was produced by the CURRENT
    parser version. A row from an older version is treated as absent so the
    improved extractor re-runs (and stale 'empty'/'error' results self-heal)."""
    row = conn.execute(
        "SELECT status, parser_version FROM reference_runs WHERE doc_id = ?",
        (doc_id,),
    ).fetchone()
    if row is None or row["parser_version"] != REFERENCE_PARSER_VERSION:
        return None
    return row["status"]


def _claim_run(conn, doc_id: str) -> bool:
    """Atomically claim the parse for this doc at the current parser version.
    Returns True if we won the claim. Handles both brand-new docs and docs with
    a stale (older-version) row that needs re-parsing."""
    now = _now()
    cur = conn.execute(
        "INSERT OR IGNORE INTO reference_runs "
        "(doc_id, status, error, parser_version, created_at, updated_at) "
        "VALUES (?, 'pending', NULL, ?, ?, ?)",
        (doc_id, REFERENCE_PARSER_VERSION, now, now),
    )
    if cur.rowcount > 0:
        return True
    # A row exists. Re-claim it if it's from an older parser version OR it
    # previously errored (errors are usually transient — a missing/invalid key,
    # a rate limit — so a later request should retry). Only one racer wins the
    # WHERE clause, preserving single-flight.
    cur = conn.execute(
        "UPDATE reference_runs SET status = 'pending', error = NULL, "
        "parser_version = ?, updated_at = ? "
        "WHERE doc_id = ? AND (parser_version < ? OR status = 'error')",
        (REFERENCE_PARSER_VERSION, now, doc_id, REFERENCE_PARSER_VERSION),
    )
    return cur.rowcount > 0


def _finish_run(
    conn, doc_id: str, status: str, error: str | None = None
) -> None:
    conn.execute(
        "UPDATE reference_runs SET status = ?, error = ?, "
        "parser_version = ?, updated_at = ? WHERE doc_id = ?",
        (status, error, REFERENCE_PARSER_VERSION, _now(), doc_id),
    )


def _store_references(conn, doc_id: str, entries: list[dict]) -> None:
    conn.execute("DELETE FROM document_references WHERE doc_id = ?", (doc_id,))
    conn.executemany(
        "INSERT OR REPLACE INTO document_references "
        "(doc_id, number, authors, title, raw) VALUES (?, ?, ?, ?, ?)",
        [
            (
                doc_id,
                e["number"],
                e.get("authors"),
                e.get("title"),
                e.get("raw"),
            )
            for e in entries
        ],
    )


def _gather_references_text(settings: Settings, doc_id: str) -> str:
    """Open the PDF once, pull every page's text, and slice out the reference
    section. Runs at most once per document (gated by the run claim)."""
    pdf_path = files.pdf_path(settings, doc_id)
    pages = []
    with PdfiumBackend.open(pdf_path) as backend:
        for i in range(backend.page_count()):
            try:
                pages.append(backend.get_page_text(i))
            except Exception:  # noqa: BLE001
                log.exception("text extraction failed for page %d", i)
    return extract_references_text(pages)


def _extract_json_array(text: str) -> list:
    """Parse the JSON array out of a model response, tolerantly.

    Tries the whole (de-fenced) string first, then falls back to the substring
    between the first ``[`` and the last ``]`` so stray prose around the array
    doesn't blow up the parse."""
    s = text.strip()
    if s.startswith("```"):
        s = s.split("\n", 1)[1] if "\n" in s else s
        if s.endswith("```"):
            s = s[:-3]
    s = s.strip()
    try:
        parsed = json.loads(s)
        if isinstance(parsed, list):
            return parsed
    except json.JSONDecodeError:
        pass
    start = s.find("[")
    end = s.rfind("]")
    if start != -1 and end > start:
        parsed = json.loads(s[start : end + 1])
        if isinstance(parsed, list):
            return parsed
    raise ValueError("model response did not contain a JSON array")


def _coerce_entries(parsed: object) -> list[dict]:
    """Validate the model's JSON into clean reference rows."""
    if not isinstance(parsed, list):
        return []
    out: list[dict] = []
    seen: set[int] = set()
    for item in parsed:
        if not isinstance(item, dict):
            continue
        raw_num = item.get("number")
        try:
            number = int(raw_num)
        except (TypeError, ValueError):
            continue
        if number < 1 or number in seen:
            continue
        seen.add(number)
        authors = item.get("authors")
        title = item.get("title")
        out.append(
            {
                "number": number,
                "authors": str(authors).strip() if authors else None,
                "title": str(title).strip() if title else None,
                "raw": None,
            }
        )
    return out


async def _parse_with_claude(references_text: str) -> list[dict]:
    """Ask Claude to turn the raw reference blob into structured rows.

    Non-streaming: we want the whole JSON array before persisting. Raises on
    transport/parse failure so the caller can mark the run errored."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise RuntimeError("ANTHROPIC_API_KEY not set on backend")

    # `extract_references_text` already caps the size; send as-is.
    blob = references_text
    client = anthropic.AsyncAnthropic()
    msg = await client.messages.create(
        model=MODEL_REFERENCES,
        max_tokens=16000,
        system=SYSTEM_REFERENCES,
        messages=[
            {
                "role": "user",
                "content": (
                    "Here is the reference section:\n\n"
                    f"<references>\n{blob}\n</references>"
                ),
            }
        ],
    )
    text = "".join(
        block.text for block in msg.content if getattr(block, "type", "") == "text"
    )
    return _coerce_entries(_extract_json_array(text))


@router.get("/references")
async def get_references(
    doc_id: str,
    settings: Settings = Depends(get_settings),
) -> dict:
    """Return the parsed bibliography, parsing on first request and caching.

    Response shape: ``{doc_id, status, references}`` where status is one of
    complete | pending | empty | error. The client matches a clicked marker's
    number against ``references`` (each row: number, authors, title)."""
    if not _doc_exists(settings, doc_id):
        raise HTTPException(status_code=404, detail="document not found")

    # Fast path: already parsed (or known-empty / in-flight). A prior "error"
    # is NOT short-circuited — it gets re-claimed below so a fixed key or a
    # cleared rate limit retries automatically.
    with db.connect(settings.db_path) as conn:
        status = _fresh_status(conn, doc_id)
        if status == "complete":
            return {"doc_id": doc_id, "status": "complete",
                    "references": _load_references(conn, doc_id)}
        if status in ("pending", "empty"):
            return {"doc_id": doc_id, "status": status, "references": []}
        # No run yet, stale version, or a previous error — (re)claim and parse.
        won = _claim_run(conn, doc_id)
        if not won:
            return {"doc_id": doc_id, "status": "pending", "references": []}

    # We own the parse. Extract the reference text, hand it to Claude, persist.
    try:
        references_text = _gather_references_text(settings, doc_id)
    except PdfError as e:
        with db.connect(settings.db_path) as conn:
            _finish_run(conn, doc_id, "error", str(e))
        raise HTTPException(status_code=400, detail=str(e)) from e

    if not references_text.strip():
        with db.connect(settings.db_path) as conn:
            _finish_run(conn, doc_id, "empty")
        return {"doc_id": doc_id, "status": "empty", "references": []}

    try:
        entries = await _parse_with_claude(references_text)
    except Exception as e:  # noqa: BLE001
        log.exception("reference parsing failed")
        detail = f"{type(e).__name__}: {e}"
        with db.connect(settings.db_path) as conn:
            _finish_run(conn, doc_id, "error", detail)
        return {"doc_id": doc_id, "status": "error", "references": [],
                "error": detail}

    with db.connect(settings.db_path) as conn:
        if entries:
            _store_references(conn, doc_id, entries)
            _finish_run(conn, doc_id, "complete")
        else:
            _finish_run(conn, doc_id, "empty")

    return {
        "doc_id": doc_id,
        "status": "complete" if entries else "empty",
        "references": entries,
    }
