from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
    id           TEXT PRIMARY KEY,            -- sha256 of file bytes
    filename     TEXT NOT NULL,
    page_count   INTEGER NOT NULL,
    title        TEXT,
    author       TEXT,
    size_bytes   INTEGER NOT NULL,
    uploaded_at  TEXT NOT NULL                -- ISO-8601
);

CREATE TABLE IF NOT EXISTS page_dimensions (
    doc_id       TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    page_index   INTEGER NOT NULL,
    width_pt     REAL NOT NULL,
    height_pt    REAL NOT NULL,
    PRIMARY KEY (doc_id, page_index)
);

-- FTS5 virtual table for full-text search across page text. `page_index` here
-- is 1-indexed (client-friendly) so the search route can return it verbatim.
-- We don't FK to documents(id) because FTS5 virtual tables can't carry foreign
-- keys; the search route deletes rows by doc_id on re-upload to keep them in
-- sync.
CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
    doc_id      UNINDEXED,
    page_index  UNINDEXED,
    text,
    tokenize = "unicode61 remove_diacritics 2"
);
"""


def init_db(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as conn:
        conn.executescript(SCHEMA)


@contextmanager
def connect(path: Path) -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
