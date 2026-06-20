from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..config import Settings
from ..storage import db, files
from .deps import get_settings

router = APIRouter(prefix="/documents/{doc_id}/annotations", tags=["annotations"])

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


@router.post("")
def create_annotation(
    doc_id: str,
    body: CreateHighlight,
    settings: Settings = Depends(get_settings),
) -> dict:
    if not body.rects:
        raise HTTPException(status_code=422, detail="rects must not be empty")
    if not files.pdf_path(settings, doc_id).exists():
        raise HTTPException(status_code=404, detail="document not found")

    annotation_id = uuid.uuid4().hex
    payload = {
        "color": body.color,
        "rects": [r.model_dump() for r in body.rects],
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
        conn.execute(
            "INSERT INTO annotations (id, doc_id, page_index, kind, payload, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (annotation_id, doc_id, body.page - 1, "highlight",
             json.dumps(payload), now),
        )

    return {
        "id": annotation_id,
        "page": body.page,
        "kind": "highlight",
        "color": body.color,
        "rects": payload["rects"],
        "text": payload.get("text"),
        "created_at": now,
    }


@router.get("")
def list_annotations(
    doc_id: str,
    page: int | None = None,
    settings: Settings = Depends(get_settings),
) -> list[dict]:
    if not files.pdf_path(settings, doc_id).exists():
        raise HTTPException(status_code=404, detail="document not found")

    with db.connect(settings.db_path) as conn:
        # LEFT JOIN so highlights without an explanation still come back.
        # Frontend uses this to seed its explanation cache so the tooltip
        # opens instantly on hover instead of doing a follow-up GET.
        base_select = (
            "SELECT a.id, a.page_index, a.kind, a.payload, a.created_at, "
            "       e.kind AS exp_kind, e.content AS exp_content, "
            "       e.status AS exp_status "
            "FROM annotations a "
            "LEFT JOIN explanations e ON e.annotation_id = a.id "
        )
        if page is None:
            rows = conn.execute(
                base_select + "WHERE a.doc_id = ? ORDER BY a.created_at ASC",
                (doc_id,),
            ).fetchall()
        else:
            if page < 1:
                raise HTTPException(status_code=400, detail="page must be >= 1")
            rows = conn.execute(
                base_select
                + "WHERE a.doc_id = ? AND a.page_index = ? "
                "ORDER BY a.created_at ASC",
                (doc_id, page - 1),
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
) -> None:
    with db.connect(settings.db_path) as conn:
        cur = conn.execute(
            "DELETE FROM annotations WHERE id = ? AND doc_id = ?",
            (annotation_id, doc_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="annotation not found")
