from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..config import Settings
from ..storage import db, files
from .deps import get_session_id, get_settings

router = APIRouter(prefix="/documents/{doc_id}/annotations", tags=["annotations"])

# Cap highlights per document per visitor — bounds load on the shared (free,
# self-hosted) AI model and keeps any one visitor from flooding a doc.
HIGHLIGHTS_PER_DOC_LIMIT = 50

HighlightColor = Literal["yellow", "blue", "red", "green", "pink"]
"""Edge-style 5-color palette."""

ALLOWED_COLORS: frozenset[HighlightColor] = frozenset(
    ("yellow", "blue", "red", "green", "pink")
)


class Rect(BaseModel):
    x0: float = Field(ge=0)
    y0: float = Field(ge=0)
    x1: float = Field(gt=0)
    y1: float = Field(gt=0)


class CreateHighlight(BaseModel):
    page: int = Field(ge=1, description="1-indexed page number")
    color: HighlightColor
    rects: list[Rect]
    text: str | None = Field(default=None, max_length=4000)
    # When true, this highlight triggers an AI explanation (any color). Plain
    # highlights leave it false. Historically "blue" implied explanation; that
    # legacy behaviour is preserved on read (see list_annotations).
    explain: bool = False


def _is_explain(payload: dict) -> bool:
    """Whether a stored highlight is an explanation highlight. Falls back to
    the legacy rule (blue == explanation) for rows saved before the flag."""
    flagged = payload.get("explain")
    if flagged is None:
        return payload.get("color") == "blue"
    return bool(flagged)


@router.post("")
def create_annotation(
    doc_id: str,
    body: CreateHighlight,
    settings: Settings = Depends(get_settings),
    session_id: str = Depends(get_session_id),
) -> dict:
    if not body.rects:
        raise HTTPException(status_code=422, detail="rects must not be empty")
    if not files.pdf_path(settings, doc_id).exists():
        raise HTTPException(status_code=404, detail="document not found")

    annotation_id = uuid.uuid4().hex
    payload = {
        "color": body.color,
        "rects": [r.model_dump() for r in body.rects],
        "explain": body.explain,
    }
    if body.text:
        payload["text"] = body.text
    now = datetime.now(timezone.utc).isoformat()

    with db.connect(settings.db_path) as conn:
        # Confirm document exists in DB too (uploaded properly).
        row = conn.execute(
            "SELECT 1 FROM documents WHERE id = ?", (doc_id,)
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="document not found")
        # Enforce the per-visitor, per-document highlight cap.
        count = conn.execute(
            "SELECT COUNT(*) FROM annotations WHERE doc_id = ? AND session_id = ?",
            (doc_id, session_id),
        ).fetchone()[0]
        if count >= HIGHLIGHTS_PER_DOC_LIMIT:
            raise HTTPException(
                status_code=429,
                detail=(
                    f"Highlight limit reached ({HIGHLIGHTS_PER_DOC_LIMIT} per "
                    "document). Delete some highlights to add more."
                ),
            )
        conn.execute(
            "INSERT INTO annotations "
            "(id, doc_id, page_index, kind, payload, created_at, session_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (annotation_id, doc_id, body.page - 1, "highlight",
             json.dumps(payload), now, session_id),
        )

    return {
        "id": annotation_id,
        "page": body.page,
        "kind": "highlight",
        "color": body.color,
        "rects": payload["rects"],
        "text": payload.get("text"),
        "explain": body.explain,
        "created_at": now,
    }


@router.get("")
def list_annotations(
    doc_id: str,
    page: int | None = None,
    settings: Settings = Depends(get_settings),
    session_id: str = Depends(get_session_id),
) -> list[dict]:
    if not files.pdf_path(settings, doc_id).exists():
        raise HTTPException(status_code=404, detail="document not found")

    with db.connect(settings.db_path) as conn:
        # LEFT JOIN so highlights without an explanation still come back.
        # Frontend uses this to seed its explanation cache so the tooltip
        # opens instantly on hover instead of doing a follow-up GET.
        # Scope to this visitor's session; NULL = legacy rows (pre-isolation),
        # kept visible so existing local highlights aren't lost.
        base_select = (
            "SELECT a.id, a.page_index, a.kind, a.payload, a.created_at, "
            "       e.kind AS exp_kind, e.content AS exp_content, "
            "       e.status AS exp_status "
            "FROM annotations a "
            "LEFT JOIN explanations e ON e.annotation_id = a.id "
        )
        scope = "(a.session_id = ? OR a.session_id IS NULL) "
        if page is None:
            rows = conn.execute(
                base_select + "WHERE a.doc_id = ? AND " + scope
                + "ORDER BY a.created_at ASC",
                (doc_id, session_id),
            ).fetchall()
        else:
            if page < 1:
                raise HTTPException(status_code=400, detail="page must be >= 1")
            rows = conn.execute(
                base_select
                + "WHERE a.doc_id = ? AND a.page_index = ? AND " + scope
                + "ORDER BY a.created_at ASC",
                (doc_id, page - 1, session_id),
            ).fetchall()

    out: list[dict] = []
    for r in rows:
        payload = json.loads(r["payload"])
        entry: dict = {
            "id": r["id"],
            "page": r["page_index"] + 1,
            "kind": r["kind"],
            "color": payload.get("color"),
            "rects": payload.get("rects", []),
            "text": payload.get("text"),
            "explain": _is_explain(payload),
            "created_at": r["created_at"],
        }
        # Only attach a non-null explanation when one's fully cached.
        # Pending/errored rows fall back to the existing on-hover flow.
        if r["exp_status"] == "complete" and r["exp_content"]:
            entry["explanation"] = {
                "kind": r["exp_kind"],
                "content": r["exp_content"],
            }
        out.append(entry)
    return out


@router.delete("/{annotation_id}", status_code=204)
def delete_annotation(
    doc_id: str,
    annotation_id: str,
    settings: Settings = Depends(get_settings),
    session_id: str = Depends(get_session_id),
) -> None:
    with db.connect(settings.db_path) as conn:
        # Only delete the visitor's own highlights (or legacy NULL-session ones).
        cur = conn.execute(
            "DELETE FROM annotations WHERE id = ? AND doc_id = ? "
            "AND (session_id = ? OR session_id IS NULL)",
            (annotation_id, doc_id, session_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="annotation not found")
