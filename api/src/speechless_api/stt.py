"""Speech-to-text for the other person, via ElevenLabs Scribe.

The browser's own recogniser only hears the default microphone. To hear a call (Teams,
Zoom) the client captures the computer's audio itself, cuts it into utterances and
posts each one here; we forward it to Scribe with the person's key.
"""

from __future__ import annotations

import httpx

from .tts import ELEVENLABS_BASE, TTSError, _describe_elevenlabs_error

SCRIBE_MODEL = "scribe_v1"
MAX_AUDIO_BYTES = 10 * 1024 * 1024


async def transcribe_elevenlabs(
    client: httpx.AsyncClient,
    *,
    api_key: str,
    audio: bytes,
    content_type: str,
    language_code: str | None = None,
) -> str:
    """Return the transcript of one utterance (may be empty). Raises TTSError on refusal."""
    data: dict[str, str] = {"model_id": SCRIBE_MODEL, "tag_audio_events": "false"}
    if language_code:
        data["language_code"] = language_code
    response = await client.post(
        f"{ELEVENLABS_BASE}/v1/speech-to-text",
        headers={"xi-api-key": api_key},
        data=data,
        files={"file": ("utterance", audio, content_type or "application/octet-stream")},
    )
    if response.status_code >= 400:
        raise TTSError(
            response.status_code, _describe_elevenlabs_error(response.status_code, response.content)
        )
    body = response.json()
    text = body.get("text") if isinstance(body, dict) else None
    return text.strip() if isinstance(text, str) else ""
