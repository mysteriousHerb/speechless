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
  - LLM for quick-reply suggestions: Anthropic (default `claude-haiku-5-5`) or any
    OpenAI-compatible chat-completions endpoint, reasoning off; latency matters more
    than accuracy because the human picks the reply. The last few turns are the context.
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

The ElevenLabs key is the user's own: entered in the app's Settings screen, kept in the
phone's `localStorage`, sent to the Speechless server per request and never stored there.
The server can also carry a default key in an ignored `.env` (see `.env.example`).
The LLM key (`ANTHROPIC_API_KEY`, or `LLM_API_KEY` for an OpenAI-compatible endpoint)
is server-side only for now; an in-app override can come later.
