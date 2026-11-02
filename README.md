# Speechless

A speak-for-me app for when you've lost your voice. Phone first.

Type (or tap) what you want to say and Speechless says it out loud in a natural voice
(ElevenLabs TTS). An LLM listens to the conversation around you and offers quick
replies so you can answer in one tap instead of typing every sentence.

See `PLAN.md` for the product shape, stack and milestones.

## Layout

- `api/` — FastAPI service (Python, managed with `uv`). Holds the API keys and proxies
  ElevenLabs text-to-speech. Also serves the built web app from `web/dist` when it exists.
- `web/` — Vite + React PWA. Installs to the phone home screen.

## Run it (dev)

```bash
cp .env.example .env          # then fill in ELEVENLABS_API_KEY
cd api && uv run fastapi dev src/speechless_api/main.py   # http://localhost:8000
cd web && npm install && npm run dev                      # http://localhost:5173 (proxies /api)
```

Open the Vite URL on your phone (it binds to all interfaces; use the LAN address it
prints). The header shows which voice is speaking.

## Voices

Open **Settings** in the app to paste your ElevenLabs API key (kept on the device only),
pick Auto / ElevenLabs / Microsoft, and browse the voice catalogue with previews. The
server falls back to its own defaults (`TTS_BACKEND=auto`) when the app sends nothing:

1. **ElevenLabs** when a key is available (from the app, or `ELEVENLABS_API_KEY`). Best quality, paid.
2. **Microsoft Edge** otherwise. The neural "Read Aloud" voices via the unofficial
   [`edge-tts`](https://github.com/rany2/edge-tts) package: free, no key, but an
   undocumented endpoint that Microsoft could change at any time.
3. **Browser voice** as the client-side fallback whenever the server has no voice or
   the server voice fails mid-conversation. Quality depends on the phone.

## Speaking into a call (Teams, Zoom, Meet)

Settings → **Audio devices** → *Speak through* is a tick-list of outputs; the voice plays
on every ticked device at once. Install a virtual audio cable (VB-Cable on Windows,
BlackHole on macOS, a PipeWire/PulseAudio null sink on Linux), tick it in Speechless, and
pick the same cable as the **microphone** in the call app. Typed text now comes out as
your voice in the call. Tick your headphones as well to hear it yourself. The first
ticked device is the main output, the one the volume slider boosts; the rest play at
normal volume. Works in Chrome and Edge on a computer; Safari and phones cannot choose
an output device, so there the system default is used. Turn off noise suppression in the
call app if words get clipped.

**Hearing the other side of the call.** *Listen with* has three modes:

- *Browser recogniser* (default): free and instant, but it can only hear the system
  default microphone, so it is for in-person conversations.
- *A microphone, via ElevenLabs*: a chosen mic, transcribed by ElevenLabs Scribe.
- *What this computer plays, via ElevenLabs*: for calls. Tapping **Listen** opens
  Chrome's share dialog; pick "Entire screen" and tick "Also share system audio". The
  app cuts the audio into utterances and sends each to Scribe (`POST /api/transcribe`,
  same key handling as speech). Your own voice is muted out while it plays.
  Chrome shows its "sharing" bar for as long as Listen is on, but the screen is never
  recorded: the video track is stopped the moment sharing starts and only the audio
  of someone speaking leaves the computer, for transcription.

Both ElevenLabs modes need an ElevenLabs key and cost Scribe minutes. The browser
cannot hear a call on phones or Safari; use a computer with Chrome or Edge.

## Typo fixing, speed and volume

Typed messages get an instant dictionary spelling pass before they are spoken ("hwllo
tehre" → "hello there"). It is not an LLM: it swaps a misspelt word for the real one and
never rephrases, and leaves names, slang, numbers and anything it is unsure about as typed.
Add your own words under Settings → "Never change these words". Speed and volume sliders
live next to it; speed works with every voice, and volume above 100% boosts the output
for calls that hear it quietly through a virtual cable.

## Quick replies

Tap **Listen** and the phone transcribes the other person with the browser's own speech
recognition (free; Safari on iPhone, Chrome on Android). After each thing they say, the
server asks the configured LLM for 3–4 short replies, shown as orange chips: tap to speak,
or the pencil to edit first. Recent phrases follow as grey chips. Without an LLM the chips
fall back to Yes / No / One moment.

The LLM is any OpenAI-compatible chat-completions endpoint (Azure AI Foundry, OpenAI, a
proxy); see the config table. Reasoning is off by default because the human picks the
reply, so latency beats cleverness.

## Run it (single process, production-ish)

```bash
cd web && npm run build
cd ../api && uv run fastapi run src/speechless_api/main.py   # serves app + API on :8000
```

After a new `npm run build`, phones already running the app show an **Update** banner (or use
Settings → *Check for updates*); nothing switches silently. Settings shows the build's git hash
and time so you can tell which version a device is on.

## Checks

```bash
cd api && uv run pytest
cd web && npm run lint && npm run build
```

## Config (`.env`)

| Variable | Required | Default |
| --- | --- | --- |
| `TTS_BACKEND` | no | `auto` (`elevenlabs` / `edge` / `none`) |
| `ELEVENLABS_API_KEY` | no, the app can supply one | — (auto falls back to Edge) |
| `EDGE_TTS_VOICE` | no | `en-US-AriaNeural` |
| `ELEVENLABS_VOICE_ID` | no | `21m00Tcm4TlvDq8ikWAM` (Rachel) |
| `ELEVENLABS_MODEL_ID` | no | `eleven_flash_v2_5` |
| `ANTHROPIC_API_KEY` | for quick replies (simplest) | — (uses Claude; nothing else needed) |
| `LLM_BASE_URL` | for an OpenAI-compatible LLM instead | — (e.g. `https://<resource>.openai.azure.com/openai/v1`; selects this provider) |
| `LLM_API_KEY` | with `LLM_BASE_URL` | — |
| `LLM_MODEL` | no | `claude-haiku-5-5` (Azure: deployment name, e.g. `gpt-6-luna`) |
| `LLM_REASONING_EFFORT` | no | `none` (reasoning off for speed; Claude also takes `low`/`medium`/`high`) |
