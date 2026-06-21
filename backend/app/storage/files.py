from __future__ import annotations

import hashlib
import os
import secrets
from pathlib import Path

from ..config import Settings


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _unique_tmp(target: Path) -> Path:
    """A per-writer temp path next to `target`. Concurrent writers of the same
    cache file must not share a temp name, or one can rename it out from under
    the other (FileNotFoundError). The final atomic rename is last-writer-wins,
    which is fine since every writer produces identical bytes."""
    token = f"{os.getpid()}.{secrets.token_hex(4)}"
    return target.with_name(f"{target.name}.{token}.tmp")


def pdf_path(settings: Settings, doc_id: str) -> Path:
    return settings.pdf_dir / f"{doc_id}.pdf"


def render_path(settings: Settings, doc_id: str, page_index: int, dpi: int) -> Path:
    return settings.render_cache_dir / doc_id / f"p{page_index}_{dpi}.png"


def save_pdf(settings: Settings, data: bytes) -> str:
    """Write bytes to disk keyed by SHA-256; returns the doc id."""
    settings.pdf_dir.mkdir(parents=True, exist_ok=True)
    doc_id = sha256_bytes(data)
    target = pdf_path(settings, doc_id)
    if not target.exists():
        tmp = _unique_tmp(target)
        tmp.write_bytes(data)
        tmp.replace(target)
    return doc_id


def write_render_cache(
    settings: Settings,
    doc_id: str,
    page_index: int,
    dpi: int,
    png_bytes: bytes,
) -> Path:
    p = render_path(settings, doc_id, page_index, dpi)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = _unique_tmp(p)
    tmp.write_bytes(png_bytes)
    tmp.replace(p)
    return p
