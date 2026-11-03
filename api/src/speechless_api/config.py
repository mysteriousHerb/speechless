"""Settings read from the environment (and the repo-root `.env`)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv

# api/src/speechless_api/config.py -> repo root is three levels up from `api/`.
REPO_ROOT = Path(__file__).resolve().parents[3]
WEB_DIST = REPO_ROOT / "web" / "dist"

load_dotenv(REPO_ROOT / ".env")

MAX_TEXT_CHARS = 1000

Backend = Literal["elevenlabs", "edge", "none"]
BackendMode = Literal["auto", "elevenlabs", "edge", "none"]
BACKEND_MODES: tuple[BackendMode, ...] = ("auto", "elevenlabs", "edge", "none")

DEFAULT_ELEVENLABS_VOICE = "21m00Tcm4TlvDq8ikWAM"  # "Rachel", an ElevenLabs stock voice
DEFAULT_EDGE_VOICE = "en-US-AriaNeural"
# Haiku: cheapest and fastest Claude; quick replies are a latency game, not a quality one.
DEFAULT_ANTHROPIC_MODEL = "claude-haiku-5-5"

LLMProvider = Literal["anthropic", "openai", "none"]


@dataclass(frozen=True)
class Settings:
    """Server-side defaults. The app's own settings screen can override the key,
    the backend and the voice per request."""

    tts_backend: BackendMode
    elevenlabs_api_key: str
    elevenlabs_voice_id: str
    elevenlabs_model_id: str
    elevenlabs_output_format: str
    edge_voice: str
    # Quick-reply LLM. Two providers:
    #  - Anthropic (default): ANTHROPIC_API_KEY alone is enough; model defaults to Claude Haiku.
    #  - any OpenAI-compatible chat-completions endpoint: LLM_BASE_URL + LLM_API_KEY + LLM_MODEL
    #    (Azure AI Foundry: LLM_BASE_URL=https://<resource>.openai.azure.com/openai/v1,
    #    LLM_MODEL=<deployment>). Setting LLM_BASE_URL selects this provider.
    anthropic_api_key: str
    llm_base_url: str
    llm_api_key: str
    llm_model: str
    llm_reasoning_effort: str

    @property
    def llm_provider(self) -> LLMProvider:
        if self.llm_base_url:
            return "openai" if self.llm_api_key and self.llm_model else "none"
        return "anthropic" if self.anthropic_api_key else "none"

    @property
    def llm_configured(self) -> bool:
        return self.llm_provider != "none"

    @property
    def backend(self) -> Backend:
        return resolve_backend(self.tts_backend, self.elevenlabs_api_key)


def resolve_backend(mode: BackendMode, elevenlabs_key: str) -> Backend:
    """Which backend will actually speak.

    `auto` prefers ElevenLabs when a key is available, otherwise the free Microsoft Edge
    voices. Explicit `elevenlabs` without a key means no server voice (the client then
    falls back to the browser's own speech).
    """
    if mode == "auto":
        return "elevenlabs" if elevenlabs_key else "edge"
    if mode == "elevenlabs":
        return "elevenlabs" if elevenlabs_key else "none"
    if mode == "edge":
        return "edge"
    return "none"


def load_settings() -> Settings:
    mode = os.environ.get("TTS_BACKEND", "auto").strip().lower() or "auto"
    if mode not in BACKEND_MODES:
        raise ValueError(f"TTS_BACKEND must be one of {BACKEND_MODES}, got {mode!r}")
    return Settings(
        tts_backend=mode,  # type: ignore[arg-type]
        elevenlabs_api_key=os.environ.get("ELEVENLABS_API_KEY", "").strip(),
        elevenlabs_voice_id=os.environ.get("ELEVENLABS_VOICE_ID", DEFAULT_ELEVENLABS_VOICE),
        # Flash is the low-latency model; fine for conversation.
        elevenlabs_model_id=os.environ.get("ELEVENLABS_MODEL_ID", "eleven_v4_turbo"),
        elevenlabs_output_format=os.environ.get("ELEVENLABS_OUTPUT_FORMAT", "mp3_44100_128"),
        edge_voice=os.environ.get("EDGE_TTS_VOICE", DEFAULT_EDGE_VOICE),
        anthropic_api_key=os.environ.get("ANTHROPIC_API_KEY", "").strip(),
        llm_base_url=os.environ.get("LLM_BASE_URL", "").strip().rstrip("/"),
        llm_api_key=os.environ.get("LLM_API_KEY", "").strip(),
        llm_model=os.environ.get("LLM_MODEL", "").strip() or DEFAULT_ANTHROPIC_MODEL,
        # "none" turns reasoning off (Claude: thinking disabled at low effort; gpt-6-luna:
        # reasoning_effort=none): latency matters more than cleverness because the human
        # picks the reply anyway. Any other value is passed through as the effort level.
        llm_reasoning_effort=os.environ.get("LLM_REASONING_EFFORT", "none").strip().lower(),
    )
