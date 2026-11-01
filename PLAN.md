# Speechless — plan

## What it is

A single-user web app (phone first) that lets someone who cannot speak hold a
face-to-face conversation:

1. **Say it** — a big text box; what you type is spoken aloud through the phone speaker
   with an ElevenLabs voice. Enter sends. Recent phrases are one tap to repeat.
2. **Quick replies** — the mic listens to the other person (speech-to-text), and an LLM
   proposes 3–4 short replies (yes / no / "give me a sec" / something contextual). Tap
   one and it is spoken immediately. You can edit before sending.
3. **Phrasebook** — pinned phrases (my name, "I've lost my voice, I'm typing", "water
   please", etc.) for zero-typing moments.

## Stack (proposed, to confirm)

- Frontend: Vite + React, PWA so it installs on the phone home screen.
- Backend: small FastAPI service (Python, `uv`) that holds the API keys and proxies:
  - ElevenLabs text-to-speech (streaming audio back to the client).
  - Speech-to-text for the other party (ElevenLabs Scribe or browser Web Speech API
    as the zero-cost fallback).
  - LLM for quick-reply suggestions (Claude, cheap/fast model) with the last few turns
    as context.
- No database for MVP: phrasebook and history live in `localStorage`.

## Milestones

- **M0 — speak**: text box → ElevenLabs → audio plays. Repeat-last button. Deployable.
- **M1 — quick replies**: mic transcript → LLM suggestions → tap to speak.
- **M2 — phrasebook + polish**: pinned phrases, voice picker, latency tuning.

## MVP trims (deliberate)

- Single user, no auth, no accounts.
- No conversation storage beyond the current session.
- One voice, one language, until M2.

## Secrets

`ELEVENLABS_API_KEY` and `ANTHROPIC_API_KEY` live in an ignored `.env` (see
`.env.example`); they never reach the browser.
