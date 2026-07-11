"""Daily AI-usage throttling for anonymous readers.

There's no login (see docs/specs/README.md — "no auth, no per-user
identity"), so a "user" here is just an opaque client identifier the
frontend generates once and stores in localStorage (frontend/src/clientId.ts),
sent as the `X-Client-Id` header. It identifies a browser, not a person, and
exists solely to bound how much of the shared, server-funded AI budget one
browser can draw on per day. Callers who supply their own API key
(`X-User-Api-Key`) skip this entirely — see app.ai.with_override_key.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

from fastapi import Request

from .config import Settings
from .storage import db

# A UUIDv4 is 36 chars; give a little headroom without inviting abuse.
_CLIENT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


def _today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def resolve_client_key(request: Request, client_id: str | None) -> str:
    """A well-formed client id is trusted as-is; anything missing or
    malformed falls back to the requester's IP so throttling still applies
    to callers that don't (or can't) send the header."""
    if client_id and _CLIENT_ID_RE.match(client_id):
        return f"id:{client_id}"
    ip = request.client.host if request.client else "unknown"
    return f"ip:{ip}"


def try_consume(settings: Settings, client_key: str, limit: int) -> bool:
    """Atomically counts one AI call against `client_key` for today if it's
    still under `limit`. Returns True (and records the call) when allowed,
    False when today's quota is already used up."""
    day = _today()
    with db.connect(settings.db_path) as conn:
        cur = conn.execute(
            """
            INSERT INTO ai_usage (client_id, day, count) VALUES (?, ?, 1)
            ON CONFLICT(client_id, day) DO UPDATE SET count = count + 1
            WHERE count < ?
            """,
            (client_key, day, limit),
        )
        return cur.rowcount > 0
