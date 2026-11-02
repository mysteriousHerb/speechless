# Speechless

A speak-for-me app for when you've lost your voice. Phone first.

Type (or tap) what you want to say and Speechless says it out loud in a natural voice
(ElevenLabs TTS). An LLM listens to the conversation around you and offers quick
replies so you can answer in one tap instead of typing every sentence.

See `PLAN.md` for the product shape, stack and milestones.

## License

MIT, see `LICENSE`.

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

Typed messages get a quick spelling pass from the LLM before they are spoken ("hwo are we
doing" → "how are we doing"). It fixes only obvious slips and is told that anything in
CAPITALS and the words you list under Settings → "Your abbreviations and names" are not
typos. If the model takes longer than two seconds, the text is spoken as typed. Speed and
volume sliders live in the same screen; speed works with every voice, and volume above 100%
boosts the output for calls that hear it quietly through a virtual cable.

## Quick replies

Tap **Listen** and the phone transcribes the other person with the browser's own speech
recognition (free; Safari on iPhone, Chrome on Android). After each thing they say, the
server asks the configured LLM for 3–4 short replies, shown as orange chips: tap to speak,
or the pencil to edit first. Anything you already said can be replayed or edited from its
bubble in the conversation. Without an LLM the chips
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

## Put it on the internet (Cloudflare Tunnel + Access)

The deploy is one hostname in front of the single process above. Nothing on the box is
exposed directly: a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
dials out to Cloudflare, and [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
makes everyone log in before a single request reaches the app. That matters because the
app holds API keys (the ElevenLabs key lives in each phone's local storage, the server's
own keys in `.env`) and the server spends them on whoever can reach it. Both products are
free for a handful of users; you need a domain on Cloudflare DNS.

Order matters: put Access in front **before** the hostname serves anything.

1. **Access application** (Zero Trust → Access → Applications → self-hosted): the hostname,
   e.g. `speechless.example.com`; session duration 1 month; one Allow policy whose rule is
   your email. One-time PIN is enough for one person; add Google for a one-tap login.
2. **Tunnel** (Zero Trust → Networks → Tunnels): create one, install `cloudflared` as a
   service on the box with the token it shows, then add a public hostname
   `speechless.example.com` → `http://localhost:8000`. Cloudflare creates the DNS record.
3. Run the single process from the section above (a `systemd` unit keeps it up).

When the Access session expires, every API call turns into a redirect to the login page.
The app notices (`web/src/api.ts`) and reloads itself so the login shows, rather than
muttering about a broken voice. A home-screen app on iPhone keeps its own cookies, so you
log in once inside it as well.

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
| `ANTHROPIC_API_KEY` | for quick replies and the pre-speech typo fix (simplest) | — (uses Claude; nothing else needed) |
| `LLM_BASE_URL` | for an OpenAI-compatible LLM instead | — (e.g. `https://<resource>.openai.azure.com/openai/v1`; selects this provider) |
| `LLM_API_KEY` | with `LLM_BASE_URL` | — |
| `LLM_MODEL` | no | `claude-haiku-5-5` (Azure: deployment name, e.g. `gpt-6-luna`) |
| `LLM_REASONING_EFFORT` | no | `none` (reasoning off for speed; Claude also takes `low`/`medium`/`high`) |
