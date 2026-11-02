"""FastAPI app: /api/* endpoints plus the built web app (when `web/dist` exists)."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated, Literal

import anthropic
import httpx
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .config import MAX_TEXT_CHARS, WEB_DIST, BackendMode, Settings, load_settings, resolve_backend
from .stt import MAX_AUDIO_BYTES, transcribe_elevenlabs
from .llm import DEFAULT_REPLIES, LLMError, MAX_REPLIES, Turn, suggest_replies, tidy_text
from .tts import (
    MAX_SPEED,
    MIN_SPEED,
    TTSError,
    list_edge_voices,
    list_elevenlabs_voices,
    stream_edge,
    stream_elevenlabs,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.settings = load_settings()
    app.state.http = httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=10.0))
    app.state.anthropic = make_anthropic_client(app.state.settings)
    try:
        yield
    finally:
        await app.state.http.aclose()
        if app.state.anthropic is not None:
            await app.state.anthropic.close()


def make_anthropic_client(settings: Settings) -> anthropic.AsyncAnthropic | None:
    if settings.llm_provider != "anthropic":
        return None
    # Quick replies must be fast or they are useless: short timeout, one retry.
    return anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key, timeout=20.0, max_retries=1)


app = FastAPI(title="Speechless API", lifespan=lifespan)


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_http(request: Request) -> httpx.AsyncClient:
    return request.app.state.http


SettingsDep = Annotated[Settings, Depends(get_settings)]
HttpDep = Annotated[httpx.AsyncClient, Depends(get_http)]
# The app's settings screen sends the person's own ElevenLabs key per request. It is
# never stored or logged server-side; the env key is only a default.
ElevenLabsKeyHeader = Annotated[str | None, Header(alias="X-ElevenLabs-Key")]


def effective_key(settings: Settings, header_key: str | None) -> str:
    return (header_key or "").strip() or settings.elevenlabs_api_key


class SpeakRequest(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_TEXT_CHARS)
    backend: Literal["auto", "elevenlabs", "edge"] | None = None
    voice_id: str | None = Field(default=None, max_length=120, pattern=r"^[\w\-]+$")
    # Speaking rate multiplier; 1.0 is the voice's natural pace.
    speed: float = Field(default=1.0, ge=MIN_SPEED, le=MAX_SPEED)


@app.get("/api/health")
async def health(settings: SettingsDep) -> dict[str, object]:
    return {
        "ok": True,
        "tts": settings.backend,
        "server_has_elevenlabs_key": bool(settings.elevenlabs_api_key),
        "llm": settings.llm_configured,
    }


@app.post("/api/speak")
async def speak(
    body: SpeakRequest, settings: SettingsDep, http: HttpDep, header_key: ElevenLabsKeyHeader = None
):
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=422, detail="text is empty")

    key = effective_key(settings, header_key)
    mode: BackendMode = body.backend or settings.tts_backend
    backend = resolve_backend(mode, key)
    chunks: AsyncIterator[bytes]
    if backend == "elevenlabs":
        chunks = stream_elevenlabs(
            http,
            api_key=key,
            voice_id=body.voice_id or settings.elevenlabs_voice_id,
            model_id=settings.elevenlabs_model_id,
            output_format=settings.elevenlabs_output_format,
            text=text,
            speed=body.speed,
        )
    elif backend == "edge":
        chunks = stream_edge(voice=body.voice_id or settings.edge_voice, text=text, speed=body.speed)
    elif mode == "elevenlabs":
        raise HTTPException(status_code=503, detail="elevenlabs_key_missing")
    else:
        raise HTTPException(status_code=503, detail="tts_unconfigured")

    # Pull the first chunk eagerly so a backend refusal becomes a proper HTTP error
    # instead of a broken 200 stream.
    try:
        first = await anext(chunks)
    except TTSError as exc:
        raise HTTPException(status_code=502, detail=exc.detail) from exc
    except StopAsyncIteration:
        raise HTTPException(status_code=502, detail=f"{backend} returned no audio")

    async def body_iter():
        yield first
        async for chunk in chunks:
            yield chunk

    return StreamingResponse(
        body_iter(),
        media_type="audio/mpeg",
        headers={"Cache-Control": "no-store", "X-TTS-Backend": backend},
    )


@app.get("/api/voices")
async def voices(
    backend: Literal["elevenlabs", "edge"],
    settings: SettingsDep,
    http: HttpDep,
    header_key: ElevenLabsKeyHeader = None,
):
    """Browsable voice catalogue for the voice picker."""
    try:
        if backend == "elevenlabs":
            key = effective_key(settings, header_key)
            if not key:
                raise HTTPException(status_code=503, detail="elevenlabs_key_missing")
            return {"voices": await list_elevenlabs_voices(http, api_key=key)}
        return {"voices": await list_edge_voices()}
    except TTSError as exc:
        status = 401 if exc.status_code == 401 else 502
        raise HTTPException(status_code=status, detail=exc.detail) from exc


class TurnIn(BaseModel):
    speaker: Literal["them", "me"]
    text: str = Field(max_length=2000)


class SuggestRequest(BaseModel):
    turns: list[TurnIn] = Field(min_length=1, max_length=50)
    count: int = Field(default=DEFAULT_REPLIES, ge=1, le=MAX_REPLIES)


@app.post("/api/suggest")
async def suggest(body: SuggestRequest, settings: SettingsDep, http: HttpDep, request: Request):
    """Quick replies for the user to tap, given the conversation so far."""
    if not settings.llm_configured:
        raise HTTPException(status_code=503, detail="llm_unconfigured")
    turns: list[Turn] = [{"speaker": t.speaker, "text": t.text} for t in body.turns]
    if not any(t["text"].strip() for t in turns):
        raise HTTPException(status_code=422, detail="transcript is empty")
    try:
        replies = await suggest_replies(
            http, settings, turns, body.count, anthropic_client=request.app.state.anthropic
        )
    except LLMError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    return {"replies": replies}


class TidyRequest(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_TEXT_CHARS)
    # The person's own abbreviations and names, which must never be "corrected".
    keep: list[str] = Field(default_factory=list, max_length=200)


@app.post("/api/tidy")
async def tidy(body: TidyRequest, settings: SettingsDep, http: HttpDep, request: Request):
    """Fix typos in a typed message before it is spoken. The client speaks the raw text
    if this fails or is slow, so errors here must stay cheap and honest (502/503)."""
    if not settings.llm_configured:
        raise HTTPException(status_code=503, detail="llm_unconfigured")
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=422, detail="text is empty")
    keep = [w.strip()[:60] for w in body.keep if w.strip()]
    try:
        fixed = await tidy_text(http, settings, text, keep=keep, anthropic_client=request.app.state.anthropic)
    except LLMError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    return {"text": fixed, "changed": fixed != text}


@app.post("/api/transcribe")
async def transcribe(
    settings: SettingsDep,
    http: HttpDep,
    audio: Annotated[UploadFile, File()],
    language: Annotated[str | None, Form(max_length=16, pattern=r"^[A-Za-z\-]*$")] = None,
    header_key: ElevenLabsKeyHeader = None,
):
    """One utterance of the other person (captured client-side from the mic or from
    the computer's own audio, e.g. a Teams call) -> text, via ElevenLabs Scribe."""
    key = effective_key(settings, header_key)
    if not key:
        raise HTTPException(status_code=503, detail="elevenlabs_key_missing")
    data = await audio.read(MAX_AUDIO_BYTES + 1)
    if not data:
        raise HTTPException(status_code=422, detail="audio is empty")
    if len(data) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="audio clip too large")
    try:
        text = await transcribe_elevenlabs(
            http,
            api_key=key,
            audio=data,
            content_type=audio.content_type or "application/octet-stream",
            language_code=(language or "").split("-")[0].lower() or None,
        )
    except TTSError as exc:
        status = 401 if exc.status_code == 401 else 502
        raise HTTPException(status_code=status, detail=exc.detail) from exc
    return {"text": text}


# Serve the built PWA from the same origin so one process is the whole deploy.
if WEB_DIST.is_dir():
    app.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str):
        # Only files under web/dist: an encoded "../" must not walk out to .env.
        candidate = (WEB_DIST / path).resolve()
        if path and candidate.is_relative_to(WEB_DIST.resolve()) and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(WEB_DIST / "index.html")
