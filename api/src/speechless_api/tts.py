"""Text-to-speech backends: streaming speech plus voice catalogues.

- ElevenLabs: paid, best quality, needs an API key (from the app's settings screen or
  the server env).
- Edge: Microsoft's neural "Read Aloud" voices through the unofficial `edge-tts`
  package. Free and keyless, but undocumented, so treat any failure as transient and
  let the client fall back to the browser voice.
"""

from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator
from typing import TypedDict

import edge_tts
import httpx

ELEVENLABS_BASE = "https://api.elevenlabs.io"
EDGE_VOICES_TTL_SECONDS = 60 * 60
# Speaking rate as a multiplier of the voice's natural pace. The range is ElevenLabs'
# (`voice_settings.speed`); Edge and the browser voice accept the same multiplier.
MIN_SPEED = 0.7
MAX_SPEED = 1.2


class TTSError(Exception):
    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class Voice(TypedDict):
    id: str
    name: str
    description: str
    preview_url: str | None


# --- ElevenLabs ------------------------------------------------------------------


async def stream_elevenlabs(
    client: httpx.AsyncClient,
    *,
    api_key: str,
    voice_id: str,
    model_id: str,
    output_format: str,
    text: str,
    speed: float = 1.0,
) -> AsyncIterator[bytes]:
    """Raises TTSError if ElevenLabs refuses the request (bad key, quota, etc.)."""
    url = f"{ELEVENLABS_BASE}/v1/text-to-speech/{voice_id}/stream"
    payload: dict = {"text": text, "model_id": model_id}
    if speed != 1.0:
        # Only override what the slider changed; the voice keeps its own stability etc.
        payload["voice_settings"] = {"speed": speed}
    request = client.build_request(
        "POST",
        url,
        params={"output_format": output_format},
        headers={"xi-api-key": api_key, "accept": "audio/mpeg"},
        json=payload,
    )
    response = await client.send(request, stream=True)
    if response.status_code >= 400:
        body = await response.aread()
        await response.aclose()
        raise TTSError(response.status_code, _describe_elevenlabs_error(response.status_code, body))
    try:
        async for chunk in response.aiter_bytes():
            if chunk:
                yield chunk
    finally:
        await response.aclose()


async def list_elevenlabs_voices(client: httpx.AsyncClient, *, api_key: str) -> list[Voice]:
    """Voices visible to this key: ElevenLabs' stock voices plus the account's own."""
    response = await client.get(f"{ELEVENLABS_BASE}/v1/voices", headers={"xi-api-key": api_key})
    if response.status_code >= 400:
        raise TTSError(
            response.status_code, _describe_elevenlabs_error(response.status_code, response.content)
        )
    voices: list[Voice] = []
    for v in response.json().get("voices", []):
        labels = v.get("labels") or {}
        parts = [labels.get(k) for k in ("gender", "age", "accent", "description", "use_case")]
        voices.append(
            Voice(
                id=v["voice_id"],
                name=v.get("name", v["voice_id"]),
                description=" · ".join(p for p in parts if p),
                preview_url=v.get("preview_url"),
            )
        )
    return voices


def _describe_elevenlabs_error(status: int, body: bytes) -> str:
    snippet = _elevenlabs_reason(body) or body[:300].decode("utf-8", errors="replace")
    if status == 401:
        return f"ElevenLabs rejected the API key ({snippet})"
    if status == 429:
        return f"ElevenLabs rate limit or quota hit ({snippet})"
    return f"ElevenLabs error {status} ({snippet})"


def _elevenlabs_reason(body: bytes) -> str | None:
    """ElevenLabs errors look like {"detail": {"status": ..., "message": ...}}; pull out the
    human-readable part so the app can show *why* a key was refused (invalid vs. a
    restricted key missing the `voices_read` permission, for example)."""
    try:
        detail = json.loads(body).get("detail")
    except (ValueError, AttributeError):
        return None
    if isinstance(detail, str):
        return detail
    if isinstance(detail, dict):
        message = detail.get("message")
        if isinstance(message, str) and message:
            return message
    return None


# --- Microsoft Edge ------------------------------------------------------------------


def edge_rate(speed: float) -> str:
    """Edge wants the rate as a signed percentage change, e.g. 0.85 -> "-15%"."""
    return f"{round((speed - 1.0) * 100):+d}%"


async def stream_edge(*, voice: str, text: str, speed: float = 1.0) -> AsyncIterator[bytes]:
    """Raises TTSError if the Edge service fails or returns no audio."""
    communicate = edge_tts.Communicate(text, voice, rate=edge_rate(speed))
    got_audio = False
    try:
        async for chunk in communicate.stream():
            if chunk.get("type") == "audio" and chunk.get("data"):
                got_audio = True
                yield chunk["data"]
    except Exception as exc:  # edge-tts raises a family of its own exceptions
        raise TTSError(502, f"Edge TTS failed: {type(exc).__name__}: {exc}") from exc
    if not got_audio:
        raise TTSError(502, "Edge TTS returned no audio")


_edge_voices_cache: tuple[float, list[Voice]] | None = None


async def list_edge_voices() -> list[Voice]:
    """All Edge voices (several hundred, every locale), cached for an hour."""
    global _edge_voices_cache
    now = time.monotonic()
    if _edge_voices_cache and now - _edge_voices_cache[0] < EDGE_VOICES_TTL_SECONDS:
        return _edge_voices_cache[1]
    try:
        raw = await edge_tts.list_voices()
    except Exception as exc:
        raise TTSError(502, f"Edge TTS voice list failed: {type(exc).__name__}: {exc}") from exc
    voices = [_edge_voice(v) for v in raw]
    voices.sort(key=lambda v: (not v["id"].startswith("en-"), v["id"]))
    _edge_voices_cache = (now, voices)
    return voices


def _edge_voice(v: dict) -> Voice:
    short = v.get("ShortName", "")
    friendly = (
        (v.get("FriendlyName") or short)
        .replace("Microsoft ", "")
        .replace(" Online (Natural)", "")
    )
    name, _, region = friendly.partition(" - ")
    tags = v.get("VoiceTag") or {}
    personalities = ", ".join(tags.get("VoicePersonalities") or [])
    parts = [region, v.get("Gender"), personalities]
    return Voice(
        id=short,
        name=name or short,
        description=" · ".join(p for p in parts if p),
        preview_url=None,
    )
