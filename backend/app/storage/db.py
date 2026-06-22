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
    created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_annotations_doc_page
    ON annotations(doc_id, page_index);

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

-- Tracks the one-shot parse of a document's reference list. A row here gates
-- the (potentially slow, LLM-backed) parse so concurrent requests don't
-- duplicate the work — see routes/citations.py.
CREATE TABLE IF NOT EXISTS reference_runs (
    doc_id          TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
    status          TEXT NOT NULL,             -- pending | complete | error | empty
    error           TEXT,
    parser_version  INTEGER NOT NULL DEFAULT 0,-- bumped when extraction improves
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

-- Parsed bibliography entries, keyed by the citation number used in-text
-- ("[12]" -> number 12). Populated once per document; clicking a citation
-- marker is then an integer lookup into this table.
CREATE TABLE IF NOT EXISTS document_references (
    doc_id      TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    number      INTEGER NOT NULL,
    authors     TEXT,
    title       TEXT,
    raw         TEXT,
    PRIMARY KEY (doc_id, number)
);
"""


def init_db(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as conn:
        conn.executescript(SCHEMA)
        _migrate(conn)


def _migrate(conn: sqlite3.Connection) -> None:
    """Lightweight, idempotent column additions for pre-existing databases.
    CREATE TABLE IF NOT EXISTS won't add columns to a table that already
    exists, so bring older DBs forward here."""
    # reference_runs.parser_version (added so improved reference extraction
    # auto-invalidates rows parsed by an older version).
    cols = {row[1] for row in conn.execute("PRAGMA table_info(reference_runs)")}
    if "parser_version" not in cols:
        conn.execute(
            "ALTER TABLE reference_runs ADD COLUMN "
            "parser_version INTEGER NOT NULL DEFAULT 0"
        )


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
