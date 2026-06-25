from __future__ import annotations

import secrets
from functools import lru_cache

from fastapi import Request

from ..config import Settings

# Cookie name for the anonymous per-visitor session (set by middleware).
SESSION_COOKIE = "scai_session"


@lru_cache(maxsize=1)
def _default_settings() -> Settings:
    s = Settings.from_env()
    s.ensure_dirs()
    return s


def get_settings() -> Settings:
    """FastAPI dependency. Tests override this via app.dependency_overrides."""
    return _default_settings()


def get_session_id(request: Request) -> str:
    """The visitor's anonymous session id. Normally set by the session
    middleware; falls back to a fresh value so the app never crashes if a
    request somehow bypassed it."""
    sid = getattr(request.state, "session_id", None)
    if not sid:
        sid = secrets.token_urlsafe(18)
        request.state.session_id = sid
    return sid
