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

CREATE TABLE IF NOT EXISTS annotations (
    id           TEXT PRIMARY KEY,
    doc_id       TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    page_index   INTEGER NOT NULL,
    kind         TEXT NOT NULL,               -- highlight | note | ink
    payload      TEXT NOT NULL,               -- JSON
    created_at   TEXT NOT NULL,
    session_id   TEXT                         -- anonymous owner; NULL = legacy
);

CREATE INDEX IF NOT EXISTS idx_annotations_doc_page
    ON annotations(doc_id, page_index);

-- Which anonymous session uploaded which document, so each visitor sees only
-- their own library. Documents themselves are content-addressed and shared
-- (dedup); this table scopes the *library view* per session. filename and
-- uploaded_at are per session so re-uploads under different names are honoured.
CREATE TABLE IF NOT EXISTS document_sessions (
    session_id   TEXT NOT NULL,
    doc_id       TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    filename     TEXT NOT NULL,
    uploaded_at  TEXT NOT NULL,
    PRIMARY KEY (session_id, doc_id)
);

CREATE INDEX IF NOT EXISTS idx_document_sessions_session
    ON document_sessions(session_id);

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

CREATE TABLE IF NOT EXISTS explanations (
    annotation_id TEXT PRIMARY KEY
                  REFERENCES annotations(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL,               -- definition | explanation
    text          TEXT NOT NULL,               -- the highlighted text
    content       TEXT,                        -- AI response (null while pending)
    status        TEXT NOT NULL,               -- pending | complete | error
    error         TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS figure_explanations (
    figure_id     TEXT NOT NULL,               -- e.g. p3_Figure_2
    doc_id        TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    page_index    INTEGER NOT NULL,
    label         TEXT NOT NULL,               -- "Figure 2", "Table 1"
    content       TEXT,                        -- AI response (null while pending)
    status        TEXT NOT NULL,               -- pending | complete | error
    error         TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    PRIMARY KEY (doc_id, figure_id)
);
"""


def _migrate(conn: sqlite3.Connection) -> None:
    """Schema migrations for DBs created before a column existed. SQLite has no
    ADD COLUMN IF NOT EXISTS, so we inspect the table first."""
    cols = {row[1] for row in conn.execute("PRAGMA table_info(annotations)")}
    if "session_id" not in cols:
        conn.execute("ALTER TABLE annotations ADD COLUMN session_id TEXT")


def init_db(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as conn:
        conn.executescript(SCHEMA)
        _migrate(conn)


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
