"""Provider-agnostic streaming for the AI features.

A single ``stream_completion`` coroutine talks to either Anthropic (native SDK)
or any OpenAI-compatible endpoint (OpenAI SDK with a configurable base URL), and
normalises both to the same ``(event_type, payload)`` event stream the routes
already consume:

    ("delta", chunk)  - new text
    ("done",  full)   - the whole accumulated reply
    ("error", message)- something went wrong (or no provider configured)

Messages use a tiny provider-neutral shape so the routes don't care which
backend runs. Build content with ``text_part`` / ``image_part``.
"""

from __future__ import annotations

import logging
from typing import AsyncIterator

from . import ai
from .ai import ProviderConfig

log = logging.getLogger(__name__)

# A content part is either text or an inline image.
TextPart = dict  # {"kind": "text", "text": str}
ImagePart = dict  # {"kind": "image", "media_type": str, "data": <base64 str>}


def text_part(text: str) -> TextPart:
    return {"kind": "text", "text": text}


def image_part(media_type: str, data_b64: str) -> ImagePart:
    return {"kind": "image", "media_type": media_type, "data": data_b64}


def user_text(text: str) -> dict:
    return {"role": "user", "content": text}


# --- per-provider content translation --------------------------------------


def _anthropic_content(content):
    if isinstance(content, str):
        return content
    out = []
    for p in content:
        if p["kind"] == "text":
            out.append({"type": "text", "text": p["text"]})
        else:
            out.append(
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": p["media_type"],
                        "data": p["data"],
                    },
                }
            )
    return out


def _openai_content(content):
    if isinstance(content, str):
        return content
    out = []
    for p in content:
        if p["kind"] == "text":
            out.append({"type": "text", "text": p["text"]})
        else:
            out.append(
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{p['media_type']};base64,{p['data']}"
                    },
                }
            )
    return out


# --- streaming -------------------------------------------------------------


async def _stream_anthropic(
    config: ProviderConfig,
    model: str,
    system: str,
    messages: list[dict],
    max_tokens: int,
) -> AsyncIterator[tuple[str, str]]:
    import anthropic

    client = anthropic.AsyncAnthropic(api_key=config.api_key)
    a_messages = [
        {"role": m["role"], "content": _anthropic_content(m["content"])}
        for m in messages
    ]
    accumulated: list[str] = []
    try:
        async with client.messages.stream(
            model=model,
            max_tokens=max_tokens,
            system=system,
            messages=a_messages,
        ) as stream:
            async for chunk in stream.text_stream:
                accumulated.append(chunk)
                yield ("delta", chunk)
        yield ("done", "".join(accumulated))
    except anthropic.APIError as e:
        log.exception("Anthropic API error")
        yield ("error", f"{type(e).__name__}: {e}")
    except Exception as e:  # noqa: BLE001
        log.exception("Unexpected error in Anthropic stream")
        yield ("error", f"{type(e).__name__}: {e}")


async def _stream_openai(
    config: ProviderConfig,
    model: str,
    system: str,
    messages: list[dict],
    max_tokens: int,
) -> AsyncIterator[tuple[str, str]]:
    import openai

    client = openai.AsyncOpenAI(
        api_key=config.api_key, base_url=config.resolve_base_url()
    )
    o_messages = [{"role": "system", "content": system}]
    o_messages += [
        {"role": m["role"], "content": _openai_content(m["content"])}
        for m in messages
    ]
    accumulated: list[str] = []
    try:
        stream = await client.chat.completions.create(
            model=model,
            messages=o_messages,
            max_tokens=max_tokens,
            stream=True,
        )
        async for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta.content
            if delta:
                accumulated.append(delta)
                yield ("delta", delta)
        yield ("done", "".join(accumulated))
    except openai.APIError as e:
        log.exception("OpenAI API error")
        yield ("error", f"{type(e).__name__}: {e}")
    except Exception as e:  # noqa: BLE001
        log.exception("Unexpected error in OpenAI stream")
        yield ("error", f"{type(e).__name__}: {e}")


async def stream_completion(
    config: ProviderConfig | None,
    *,
    system: str,
    messages: list[dict],
    max_tokens: int,
    tier: str = "good",
) -> AsyncIterator[tuple[str, str]]:
    """Stream a completion from the configured provider.

    Yields the normalised (event_type, payload) tuples. Emits a single
    ``("error", AI_NOT_CONFIGURED_MESSAGE)`` when no provider is set up.
    """
    if config is None or not config.api_key:
        yield ("error", ai.AI_NOT_CONFIGURED_MESSAGE)
        return

    model = config.resolve_model(tier)
    if not model:
        yield (
            "error",
            "No model is configured for this provider. Set one in AI Setup.",
        )
        return

    if config.provider == "anthropic":
        gen = _stream_anthropic(config, model, system, messages, max_tokens)
    else:  # openai / openrouter / openai_compatible
        gen = _stream_openai(config, model, system, messages, max_tokens)
    async for event in gen:
        yield event


def validate_config(config: ProviderConfig) -> tuple[bool, str | None]:
    """Best-effort live check that a config works. Returns (validated, warning).

    A True/None pair means the provider accepted a lightweight request. A
    False/str pair means we couldn't verify (network/endpoint issue) — callers
    may still choose to save. Auth failures raise ValueError so callers can
    reject the key outright.
    """
    try:
        if config.provider == "anthropic":
            import anthropic

            try:
                anthropic.Anthropic(api_key=config.api_key).models.list(limit=1)
                return True, None
            except (
                anthropic.AuthenticationError,
                anthropic.PermissionDeniedError,
            ) as e:
                raise ValueError("auth") from e
        else:
            import openai

            client = openai.OpenAI(
                api_key=config.api_key, base_url=config.resolve_base_url()
            )
            try:
                client.models.list()
                return True, None
            except (
                openai.AuthenticationError,
                openai.PermissionDeniedError,
            ) as e:
                raise ValueError("auth") from e
    except ValueError:
        raise
    except Exception:  # noqa: BLE001 — network/endpoint: save but warn
        log.warning("Could not verify provider key (saving anyway)")
        return False, (
            "Saved, but we couldn't reach the provider to verify the key. "
            "If explanations fail, re-check the key, model, and URL."
        )
