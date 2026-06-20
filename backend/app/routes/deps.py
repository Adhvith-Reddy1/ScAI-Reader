from __future__ import annotations

from functools import lru_cache

from ..config import Settings


@lru_cache(maxsize=1)
def _default_settings() -> Settings:
    s = Settings.from_env()
    s.ensure_dirs()
    return s


def get_settings() -> Settings:
    """FastAPI dependency. Tests override this via app.dependency_overrides."""
    return _default_settings()
