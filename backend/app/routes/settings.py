from __future__ import annotations

import logging

import anthropic
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import ai
from ..config import Settings
from .deps import get_settings

log = logging.getLogger(__name__)

router = APIRouter(prefix="/settings", tags=["settings"])


class AiStatus(BaseModel):
    configured: bool
    source: str | None = None  # "env" | "stored" | None
    # An env-provided key can't be changed from the UI.
    editable: bool = True


class AiKeyRequest(BaseModel):
    api_key: str = Field(min_length=1, max_length=300)
    # Verify the key against Anthropic before saving. Off in tests.
    validate_key: bool = True


class AiKeyResponse(BaseModel):
    configured: bool
    source: str | None = None
    validated: bool = False
    warning: str | None = None


def _status(settings: Settings) -> AiStatus:
    source = ai.key_source(settings)
    return AiStatus(
        configured=source is not None,
        source=source,
        editable=source != "env",
    )


@router.get("/ai", response_model=AiStatus)
def get_ai_status(settings: Settings = Depends(get_settings)) -> AiStatus:
    return _status(settings)


@router.put("/ai", response_model=AiKeyResponse)
def set_ai_key(
    body: AiKeyRequest,
    settings: Settings = Depends(get_settings),
) -> AiKeyResponse:
    if ai.key_source(settings) == "env":
        raise HTTPException(
            status_code=409,
            detail=(
                "An ANTHROPIC_API_KEY environment variable is set, so the key "
                "can't be changed from here. Unset it to manage the key in-app."
            ),
        )

    key = body.api_key.strip()
    if not ai.looks_like_anthropic_key(key):
        raise HTTPException(
            status_code=400,
            detail=(
                "That doesn't look like an Anthropic API key — they start "
                "with “sk-ant-”. Copy it from console.anthropic.com."
            ),
        )

    validated = False
    warning: str | None = None
    if body.validate_key:
        try:
            anthropic.Anthropic(api_key=key).models.list(limit=1)
            validated = True
        except (anthropic.AuthenticationError, anthropic.PermissionDeniedError):
            raise HTTPException(
                status_code=400,
                detail=(
                    "Anthropic rejected that key. Double-check you copied the "
                    "whole key from console.anthropic.com."
                ),
            )
        except Exception:  # noqa: BLE001 — network/other: save but flag it
            log.warning("Could not verify Anthropic key (saving anyway)")
            warning = (
                "Saved, but we couldn't reach Anthropic to verify the key. "
                "If explanations fail, re-check the key."
            )

    ai.set_api_key(settings, key)
    source = ai.key_source(settings)
    return AiKeyResponse(
        configured=True, source=source, validated=validated, warning=warning
    )


@router.delete("/ai", response_model=AiStatus)
def delete_ai_key(settings: Settings = Depends(get_settings)) -> AiStatus:
    if ai.key_source(settings) == "env":
        raise HTTPException(
            status_code=409,
            detail="The key comes from an environment variable; nothing to remove.",
        )
    ai.clear_stored_key(settings)
    return _status(settings)
