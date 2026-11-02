from __future__ import annotations

import json
from types import SimpleNamespace

import anthropic
import httpx
import pytest
from fastapi.testclient import TestClient

from speechless_api import main as main_module
from speechless_api import tts as tts_module
from speechless_api.config import Settings, resolve_backend
from speechless_api.main import app

ELEVEN_VOICES = {
    "voices": [
        {
            "voice_id": "v1",
            "name": "Rachel",
            "preview_url": "https://cdn/rachel.mp3",
            "labels": {"gender": "female", "accent": "american", "use_case": "narration"},
        },
        {"voice_id": "v2", "name": "Mine", "labels": {}},
    ]
}
LLM_OK = {"choices": [{"message": {"content": "{\"replies\": [\"Yes please\", \"No thanks\", \"Just a little\"]}"}}]}
EDGE_VOICES = [
    {
        "ShortName": "fr-FR-DeniseNeural",
        "FriendlyName": "Microsoft Denise Online (Natural) - French (France)",
        "Gender": "Female",
        "VoiceTag": {"VoicePersonalities": ["Friendly"]},
    },
    {
        "ShortName": "en-GB-SoniaNeural",
        "FriendlyName": "Microsoft Sonia Online (Natural) - English (United Kingdom)",
        "Gender": "Female",
        "VoiceTag": {"VoicePersonalities": ["Friendly", "Positive"]},
    },
]


def make_settings(
    key: str = "env-key",
    backend: str = "auto",
    llm: bool = True,
    anthropic_key: str = "",
    reasoning: str = "none",
) -> Settings:
    return Settings(
        tts_backend=backend,  # type: ignore[arg-type]
        elevenlabs_api_key=key,
        elevenlabs_voice_id="voice123",
        elevenlabs_model_id="eleven_flash_v2_5",
        elevenlabs_output_format="mp3_44100_128",
        edge_voice="en-US-AriaNeural",
        anthropic_api_key=anthropic_key,
        llm_base_url="https://foundry.example/openai/v1" if llm else "",
        llm_api_key="llm-key" if llm else "",
        llm_model="gpt-6-luna" if llm else "claude-haiku-5-5",
        llm_reasoning_effort=reasoning,
    )


class FakeAnthropic:
    """Stand-in for anthropic.AsyncAnthropic: records create() kwargs, replays a response."""

    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.response: object = SimpleNamespace(
            stop_reason="end_turn",
            content=[SimpleNamespace(type="text", text='{"replies": ["Yes please", "No thanks"]}')],
        )
        self.error: Exception | None = None
        self.messages = SimpleNamespace(create=self._create)

    async def _create(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return self.response

    async def close(self) -> None:
        pass


class FakeCommunicate:
    """Stand-in for edge_tts.Communicate: records args, replays scripted chunks."""

    created: list[tuple[str, str]] = []
    rates: list[str] = []
    chunks: list[dict] = []
    error: Exception | None = None

    def __init__(self, text: str, voice: str, *, rate: str = "+0%") -> None:
        FakeCommunicate.created.append((text, voice))
        FakeCommunicate.rates.append(rate)

    async def stream(self):
        if FakeCommunicate.error:
            raise FakeCommunicate.error
        for chunk in FakeCommunicate.chunks:
            yield chunk


@pytest.fixture
def client(monkeypatch):
    """TestClient with ElevenLabs HTTP mocked and edge-tts replaced by fakes."""
    calls: list[httpx.Request] = []
    state = {"status": 200, "body": b"ID3fake-mp3-bytes", "settings": make_settings(), "llm": []}

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.url.host == "foundry.example":
            status, body = state["llm"].pop(0) if state["llm"] else (200, LLM_OK)
            return httpx.Response(status, json=body) if isinstance(body, dict) else httpx.Response(status, content=body)
        if request.url.path == "/v1/speech-to-text":
            if state["status"] >= 400:
                return httpx.Response(state["status"], content=state["body"])
            return httpx.Response(200, json={"language_code": "eng", "text": " Hello from Teams "})
        if request.url.path == "/v1/voices":
            if state["status"] >= 400:
                return httpx.Response(state["status"], content=state["body"])
            return httpx.Response(200, json=ELEVEN_VOICES)
        return httpx.Response(state["status"], content=state["body"])

    async def fake_list_voices():
        return EDGE_VOICES

    FakeCommunicate.created = []
    FakeCommunicate.rates = []
    FakeCommunicate.chunks = [
        {"type": "WordBoundary", "offset": 0},
        {"type": "audio", "data": b"edge-part-1"},
        {"type": "audio", "data": b"edge-part-2"},
    ]
    FakeCommunicate.error = None
    monkeypatch.setattr(tts_module.edge_tts, "Communicate", FakeCommunicate)
    monkeypatch.setattr(tts_module.edge_tts, "list_voices", fake_list_voices)
    monkeypatch.setattr(tts_module, "_edge_voices_cache", None)
    monkeypatch.setattr(main_module, "load_settings", lambda: state["settings"])
    with TestClient(app) as tc:
        app.state.http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        tc.calls = calls  # type: ignore[attr-defined]
        tc.state = state  # type: ignore[attr-defined]
        yield tc


def speak(client, text="hi", **extra):
    headers = extra.pop("headers", None)
    return client.post("/api/speak", json={"text": text, **extra}, headers=headers)


# --- backend selection -------------------------------------------------------


@pytest.mark.parametrize(
    ("mode", "key", "expected"),
    [
        ("auto", "k", "elevenlabs"),
        ("auto", "", "edge"),
        ("elevenlabs", "k", "elevenlabs"),
        ("elevenlabs", "", "none"),
        ("edge", "k", "edge"),
        ("none", "k", "none"),
    ],
)
def test_backend_resolution(mode, key, expected):
    assert resolve_backend(mode, key) == expected


def test_health_reports_server_defaults(client):
    assert client.get("/api/health").json() == {
        "ok": True,
        "tts": "elevenlabs",
        "server_has_elevenlabs_key": True,
        "llm": True,
    }
    app.state.settings = make_settings(key="")
    assert client.get("/api/health").json() == {
        "ok": True,
        "tts": "edge",
        "server_has_elevenlabs_key": False,
        "llm": True,
    }


# --- ElevenLabs ----------------------------------------------------------------


def test_speak_streams_mp3_from_elevenlabs(client):
    res = speak(client, "  hello there  ")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("audio/mpeg")
    assert res.headers["x-tts-backend"] == "elevenlabs"
    assert res.content == b"ID3fake-mp3-bytes"

    [req] = client.calls
    assert req.url.path == "/v1/text-to-speech/voice123/stream"
    assert req.url.params["output_format"] == "mp3_44100_128"
    assert req.headers["xi-api-key"] == "env-key"
    assert json.loads(req.content) == {"text": "hello there", "model_id": "eleven_flash_v2_5"}
    assert FakeCommunicate.created == []


def test_app_key_and_voice_override_server_defaults(client):
    app.state.settings = make_settings(key="")  # server has no key at all
    res = speak(client, voice_id="myVoice-1", headers={"X-ElevenLabs-Key": " app-key "})
    assert res.status_code == 200
    assert res.headers["x-tts-backend"] == "elevenlabs"
    [req] = client.calls
    assert req.url.path == "/v1/text-to-speech/myVoice-1/stream"
    assert req.headers["xi-api-key"] == "app-key"


def test_explicit_elevenlabs_without_any_key_is_503(client):
    app.state.settings = make_settings(key="")
    res = speak(client, backend="elevenlabs")
    assert res.status_code == 503
    assert res.json()["detail"] == "elevenlabs_key_missing"


def test_elevenlabs_failure_becomes_502(client):
    client.state["status"] = 401
    client.state["body"] = b'{"detail":"invalid api key"}'
    res = speak(client)
    assert res.status_code == 502
    assert "rejected the API key" in res.json()["detail"]


# --- Edge ----------------------------------------------------------------------


def test_speak_uses_edge_when_no_key(client):
    app.state.settings = make_settings(key="")
    res = speak(client, "hi there")
    assert res.status_code == 200
    assert res.headers["x-tts-backend"] == "edge"
    assert res.content == b"edge-part-1edge-part-2"
    assert FakeCommunicate.created == [("hi there", "en-US-AriaNeural")]
    assert client.calls == []


def test_app_can_force_edge_with_its_own_voice(client):
    res = speak(client, "bonjour", backend="edge", voice_id="fr-FR-DeniseNeural")
    assert res.status_code == 200
    assert res.headers["x-tts-backend"] == "edge"
    assert FakeCommunicate.created == [("bonjour", "fr-FR-DeniseNeural")]
    assert client.calls == []


def test_edge_failure_becomes_502(client):
    FakeCommunicate.error = RuntimeError("service moved")
    res = speak(client, backend="edge")
    assert res.status_code == 502
    assert "Edge TTS failed" in res.json()["detail"]


def test_edge_no_audio_becomes_502(client):
    FakeCommunicate.chunks = [{"type": "WordBoundary"}]
    res = speak(client, backend="edge")
    assert res.status_code == 502
    assert "no audio" in res.json()["detail"]


# --- speaking rate -------------------------------------------------------------


def test_speed_is_passed_to_elevenlabs_only_when_changed(client):
    assert speak(client, "hi").status_code == 200
    assert speak(client, "hi", speed=0.85).status_code == 200
    plain, slower = [json.loads(r.content) for r in client.calls]
    assert "voice_settings" not in plain
    assert slower["voice_settings"] == {"speed": 0.85}


def test_speed_becomes_an_edge_rate_percentage(client):
    assert speak(client, "hi", backend="edge").status_code == 200
    assert speak(client, "hi", backend="edge", speed=0.8).status_code == 200
    assert speak(client, "hi", backend="edge", speed=1.2).status_code == 200
    assert FakeCommunicate.rates == ["+0%", "-20%", "+20%"]


def test_speed_outside_range_is_rejected(client):
    assert speak(client, speed=0.5).status_code == 422
    assert speak(client, speed=1.5).status_code == 422
    assert client.calls == []


# --- voices ----------------------------------------------------------------------


def test_elevenlabs_voice_catalogue(client):
    res = client.get("/api/voices", params={"backend": "elevenlabs"}, headers={"X-ElevenLabs-Key": "app-key"})
    assert res.status_code == 200
    assert res.json() == {
        "voices": [
            {
                "id": "v1",
                "name": "Rachel",
                "description": "female · american · narration",
                "preview_url": "https://cdn/rachel.mp3",
            },
            {"id": "v2", "name": "Mine", "description": "", "preview_url": None},
        ]
    }
    [req] = client.calls
    assert req.headers["xi-api-key"] == "app-key"


def test_elevenlabs_voice_catalogue_bad_key_is_401(client):
    client.state["status"] = 401
    client.state["body"] = b"nope"
    res = client.get("/api/voices", params={"backend": "elevenlabs"})
    assert res.status_code == 401
    assert "rejected the API key" in res.json()["detail"]


def test_elevenlabs_voice_catalogue_without_key_is_503(client):
    app.state.settings = make_settings(key="")
    res = client.get("/api/voices", params={"backend": "elevenlabs"})
    assert res.status_code == 503
    assert res.json()["detail"] == "elevenlabs_key_missing"


def test_edge_voice_catalogue_is_english_first_and_tidy(client):
    res = client.get("/api/voices", params={"backend": "edge"})
    assert res.status_code == 200
    assert res.json()["voices"] == [
        {
            "id": "en-GB-SoniaNeural",
            "name": "Sonia",
            "description": "English (United Kingdom) · Female · Friendly, Positive",
            "preview_url": None,
        },
        {
            "id": "fr-FR-DeniseNeural",
            "name": "Denise",
            "description": "French (France) · Female · Friendly",
            "preview_url": None,
        },
    ]


# --- common ----------------------------------------------------------------------


def test_speak_without_any_backend_is_503(client):
    app.state.settings = make_settings(key="", backend="none")
    res = speak(client)
    assert res.status_code == 503
    assert res.json()["detail"] == "tts_unconfigured"


def test_speak_rejects_bad_input(client):
    assert speak(client, "   ").status_code == 422
    assert speak(client, "").status_code == 422
    assert speak(client, "x" * 1001).status_code == 422
    assert speak(client, voice_id="../etc").status_code == 422
    assert speak(client, backend="browser").status_code == 422
    assert client.calls == []
    assert FakeCommunicate.created == []


# --- quick replies ----------------------------------------------------------------

TURNS = [
    {"speaker": "them", "text": "Hi! Do you want milk in your coffee?"},
]


def test_suggest_calls_openai_compatible_endpoint_with_reasoning_off(client):
    res = client.post("/api/suggest", json={"turns": TURNS, "count": 3})
    assert res.status_code == 200
    assert res.json() == {"replies": ["Yes please", "No thanks", "Just a little"]}

    [req] = client.calls
    assert str(req.url) == "https://foundry.example/openai/v1/chat/completions"
    assert req.headers["api-key"] == "llm-key"
    assert req.headers["authorization"] == "Bearer llm-key"
    payload = json.loads(req.content)
    assert payload["model"] == "gpt-6-luna"
    assert payload["reasoning_effort"] == "none"
    assert payload["response_format"]["type"] == "json_schema"
    assert payload["messages"][0]["role"] == "system"
    assert "Propose 3 short replies" in payload["messages"][0]["content"]
    assert "them: Hi! Do you want milk in your coffee?" in payload["messages"][1]["content"]


def test_suggest_retries_plain_when_structured_output_is_rejected(client):
    client.state["llm"] = [
        (400, {"error": {"message": "response_format unsupported"}}),
        (200, {"choices": [{"message": {"content": '```json\n["Sure", "Sure", "Not now"]\n```'}}]}),
    ]
    res = client.post("/api/suggest", json={"turns": TURNS})
    assert res.status_code == 200
    assert res.json() == {"replies": ["Sure", "Not now"]}  # de-duplicated, fences stripped
    first, second = (json.loads(c.content) for c in client.calls)
    assert "response_format" in first and "reasoning_effort" in first
    assert "response_format" not in second and "reasoning_effort" not in second


def use_anthropic(client, **kw) -> FakeAnthropic:
    app.state.settings = make_settings(llm=False, anthropic_key="sk-ant-test", **kw)
    app.state.anthropic = FakeAnthropic()
    return app.state.anthropic


def test_settings_pick_anthropic_only_when_no_openai_endpoint():
    assert make_settings(llm=False, anthropic_key="k").llm_provider == "anthropic"
    assert make_settings(llm=True, anthropic_key="k").llm_provider == "openai"
    assert make_settings(llm=False).llm_provider == "none"


def test_suggest_calls_anthropic_with_thinking_off(client):
    fake = use_anthropic(client)
    res = client.post("/api/suggest", json={"turns": TURNS, "count": 2})
    assert res.status_code == 200
    assert res.json() == {"replies": ["Yes please", "No thanks"]}
    assert client.calls == []  # nothing over the OpenAI-compatible path

    [kwargs] = fake.calls
    assert kwargs["model"] == "claude-haiku-5-5"
    assert kwargs["thinking"] == {"type": "disabled"}
    assert kwargs["output_config"]["effort"] == "low"
    assert kwargs["output_config"]["format"]["type"] == "json_schema"
    assert "Propose 2 short replies" in kwargs["system"]
    assert kwargs["messages"] == [{"role": "user", "content": kwargs["messages"][0]["content"]}]
    assert "them: Hi! Do you want milk in your coffee?" in kwargs["messages"][0]["content"]


def test_suggest_anthropic_effort_level_keeps_thinking_on(client):
    fake = use_anthropic(client, reasoning="medium")
    assert client.post("/api/suggest", json={"turns": TURNS}).status_code == 200
    [kwargs] = fake.calls
    assert "thinking" not in kwargs
    assert kwargs["output_config"]["effort"] == "medium"


def test_suggest_anthropic_skips_thinking_blocks_and_handles_refusal(client):
    fake = use_anthropic(client)
    fake.response = SimpleNamespace(
        stop_reason="end_turn",
        content=[
            SimpleNamespace(type="thinking", thinking=""),
            SimpleNamespace(type="text", text='["Sure", "Not now"]'),
        ],
    )
    assert client.post("/api/suggest", json={"turns": TURNS}).json() == {"replies": ["Sure", "Not now"]}

    fake.response = SimpleNamespace(stop_reason="refusal", content=[])
    res = client.post("/api/suggest", json={"turns": TURNS})
    assert res.status_code == 502
    assert "declined" in res.json()["detail"]


def test_suggest_anthropic_auth_failure_is_502(client):
    fake = use_anthropic(client)
    fake.error = anthropic.AuthenticationError(
        "invalid x-api-key", response=httpx.Response(401, request=httpx.Request("POST", "https://x")), body=None
    )
    res = client.post("/api/suggest", json={"turns": TURNS})
    assert res.status_code == 502
    assert "rejected the API key" in res.json()["detail"]


def test_suggest_without_llm_config_is_503(client):
    app.state.settings = make_settings(llm=False)
    res = client.post("/api/suggest", json={"turns": TURNS})
    assert res.status_code == 503
    assert res.json()["detail"] == "llm_unconfigured"
    assert client.calls == []


def test_suggest_llm_auth_failure_is_502(client):
    client.state["llm"] = [(401, b"bad key")]
    res = client.post("/api/suggest", json={"turns": TURNS})
    assert res.status_code == 502
    assert "rejected the API key" in res.json()["detail"]


def test_suggest_rejects_empty_or_bad_transcript(client):
    assert client.post("/api/suggest", json={"turns": []}).status_code == 422
    assert client.post("/api/suggest", json={"turns": [{"speaker": "them", "text": "  "}]}).status_code == 422
    assert client.post("/api/suggest", json={"turns": [{"speaker": "bot", "text": "x"}]}).status_code == 422
    assert client.post("/api/suggest", json={"turns": TURNS, "count": 99}).status_code == 422
    assert client.calls == []


# --- typo fixing before speech ---------------------------------------------------


def tidy(client, text, **extra):
    return client.post("/api/tidy", json={"text": text, **extra}).json()


def test_tidy_fixes_fat_finger_typos_without_an_llm(client):
    app.state.settings = make_settings(llm=False)
    assert tidy(client, "hwllo, are we doing with thigns liek this?") == {
        "text": "hello, are we doing with things like this?",
        "changed": True,
    }
    assert tidy(client, "I will definately be tehre. Teh recieve adn beleive")["text"] == (
        "I will definitely be there. The receive and believe"
    )
    assert client.calls == []  # no model involved


def test_tidy_reports_unchanged_text(client):
    assert tidy(client, "all good here") == {"text": "all good here", "changed": False}


def test_tidy_leaves_names_slang_numbers_and_acronyms_alone(client):
    kept = "i dont think so lol, im at Herbz place at 3pm with the NHS ppl and it's wierd"
    assert tidy(client, kept)["text"] == kept.replace("wierd", "weird")
    # Capitalised mid-sentence words are treated as names; sentence-initial ones are fixed.
    assert tidy(client, "Hwllo Londno")["text"] == "Hello Londno"


def test_tidy_respects_the_keep_list(client):
    assert tidy(client, "ask tehre for the reciept")["text"] == "ask there for the receipt"
    assert tidy(client, "ask tehre for the reciept", keep=["reciept", " TEHRE "])["text"] == (
        "ask tehre for the reciept"
    )


def test_tidy_never_rephrases_or_touches_spacing(client):
    original = "ok   so...   whta   time?!"
    assert tidy(client, original)["text"] == "ok   so...   what   time?!"


def test_tidy_rejects_bad_input(client):
    assert client.post("/api/tidy", json={"text": ""}).status_code == 422
    assert client.post("/api/tidy", json={"text": "   "}).status_code == 422
    assert client.calls == []


# --- transcription -------------------------------------------------------------


def transcribe(client, data=b"RIFFfake-wav", **extra):
    headers = extra.pop("headers", None)
    return client.post(
        "/api/transcribe", files={"audio": ("utterance.wav", data, "audio/wav")}, data=extra, headers=headers
    )


def test_transcribe_posts_clip_to_scribe_and_returns_text(client):
    res = transcribe(client, language="en-GB", headers={"X-ElevenLabs-Key": "my-key"})
    assert res.status_code == 200
    assert res.json() == {"text": "Hello from Teams"}

    [req] = client.calls
    assert req.url.path == "/v1/speech-to-text"
    assert req.headers["xi-api-key"] == "my-key"
    body = req.content
    assert b'name="model_id"\r\n\r\nscribe_v1' in body
    assert b'name="language_code"\r\n\r\nen' in body
    assert b"RIFFfake-wav" in body


def test_transcribe_without_any_key_is_503(client):
    app.state.settings = make_settings(key="")
    res = transcribe(client)
    assert res.status_code == 503
    assert res.json()["detail"] == "elevenlabs_key_missing"


def test_transcribe_failure_becomes_502(client):
    client.state["status"] = 500
    client.state["body"] = b"boom"
    res = transcribe(client)
    assert res.status_code == 502


def test_transcribe_rejects_empty_audio(client):
    assert transcribe(client, data=b"").status_code == 422
