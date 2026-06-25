from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import ai, llm
from ..ai import ProviderConfig
from ..config import Settings
from .deps import get_settings

log = logging.getLogger(__name__)

router = APIRouter(prefix="/settings", tags=["settings"])


class AiStatus(BaseModel):
    configured: bool
    source: str | None = None  # "env" | "stored" | None
    provider: str | None = None
    model: str | None = None
    base_url: str | None = None
    # An env-provided key can't be changed from the UI.
    editable: bool = True


class AiConfigRequest(BaseModel):
    provider: str = Field()
    api_key: str = Field(min_length=1, max_length=400)
    model: str | None = Field(default=None, max_length=120)
    base_url: str | None = Field(default=None, max_length=400)
    # Verify against the provider before saving. Off in tests.
    validate_key: bool = True


class AiConfigResponse(BaseModel):
    configured: bool
    source: str | None = None
    provider: str | None = None
    model: str | None = None
    validated: bool = False
    warning: str | None = None


def _status(settings: Settings) -> AiStatus:
    cfg = ai.get_provider_config(settings)
    if cfg is None:
        return AiStatus(configured=False)
    return AiStatus(
        configured=True,
        source=cfg.source,
        provider=cfg.provider,
        model=cfg.model,
        base_url=cfg.base_url,
        editable=cfg.source != "env",
    )


@router.get("/ai", response_model=AiStatus)
def get_ai_status(settings: Settings = Depends(get_settings)) -> AiStatus:
    return _status(settings)


@router.put("/ai", response_model=AiConfigResponse)
def set_ai_config(
    body: AiConfigRequest,
    settings: Settings = Depends(get_settings),
) -> AiConfigResponse:
    if ai.key_source(settings) == "env":
        raise HTTPException(
            status_code=409,
            detail=(
                "An API key is set via environment variable, so the provider "
                "can't be changed from here. Unset it to manage AI in-app."
            ),
        )

    if body.provider not in ai.PROVIDERS:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown provider. Choose one of: {', '.join(ai.PROVIDERS)}.",
        )

    key = body.api_key.strip()
    hint = ai.key_format_hint(body.provider, key)
    if hint:
        raise HTTPException(status_code=400, detail=hint)

    base_url = (body.base_url or "").strip() or None
    model = (body.model or "").strip() or None

    if body.provider == "openai_compatible" and not base_url:
        raise HTTPException(
            status_code=400,
            detail="An OpenAI-compatible provider needs a base URL (e.g. http://localhost:11434/v1).",
        )
    if body.provider == "openai_compatible" and not model:
        raise HTTPException(
            status_code=400,
            detail="An OpenAI-compatible provider needs a model name.",
        )

    cfg = ProviderConfig(
        provider=body.provider, api_key=key, model=model, base_url=base_url
    )

    validated = False
    warning: str | None = None
    if body.validate_key:
        try:
            validated, warning = llm.validate_config(cfg)
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail=(
                    "The provider rejected that key. Double-check you copied "
                    "the whole key (and the base URL, if any)."
                ),
            )

    ai.set_provider_config(
        settings, body.provider, key, model=model, base_url=base_url
    )
    saved = ai.get_provider_config(settings)
    return AiConfigResponse(
        configured=True,
        source=saved.source if saved else None,
        provider=saved.provider if saved else None,
        model=saved.model if saved else None,
        validated=validated,
        warning=warning,
    )


@router.delete("/ai", response_model=AiStatus)
def delete_ai_config(settings: Settings = Depends(get_settings)) -> AiStatus:
    if ai.key_source(settings) == "env":
        raise HTTPException(
            status_code=409,
            detail="AI is configured via environment variable; nothing to remove.",
        )
    ai.clear_stored_config(settings)
    return _status(settings)
