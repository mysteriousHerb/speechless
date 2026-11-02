# Speechless — project facts

Product and milestones: `PLAN.md`. How to run: `README.md`.

- Mobile-first single-user web app. No auth, no database; state lives in `localStorage`.
- `api/` is the uv project (FastAPI, Python 3.12). Run Python only as `cd api && uv run ...`.
  Tests: `cd api && uv run pytest`.
- `web/` is Vite + React + TypeScript, PWA via `vite-plugin-pwa`.
  Checks: `cd web && npm run lint && npm run build`.
- Dev ports: API 8000, web 5173 (Vite proxies `/api` to the API).
- Listening uses the browser Web Speech API (`web/src/listen.ts`), not a server STT, so it cannot be
  exercised from the dev box; verify on a real phone. Server STT (ElevenLabs Scribe) is a follow-up.
- Voice backends live in `api/src/speechless_api/tts.py`: ElevenLabs (paid, keyed) and Microsoft
  Edge via the unofficial `edge-tts` package (free, may break without notice). The client
  falls back to the browser voice on 502/503, so a broken backend must surface as a 502,
  never as a 200 with no audio.
- The ElevenLabs key is user-supplied from the app's Settings screen (`web/src/settings.ts`, localStorage)
  and sent per request as `X-ElevenLabs-Key`; the server never stores or logs it. `.env` holds
  optional server defaults. The LLM (`api/src/speechless_api/llm.py`, quick replies only) is server-side only: Anthropic via the
  official SDK when `ANTHROPIC_API_KEY` is set (default model `claude-haiku-5-5`), or an
  OpenAI-compatible chat-completions endpoint when `LLM_BASE_URL` is set. Latency over accuracy: reasoning off, tiny output, no tools. The browser never talks
  to ElevenLabs / Anthropic directly except to play ElevenLabs' public preview clips.
- The pre-speech typo fix (`/api/tidy`, `api/src/speechless_api/tidy.py`) is dictionary-based
  (`symspellpy`), not an LLM: word-by-word, bounded edit distance, never rephrases. Known gap:
  real-word slips ("form"/"from") are not caught, and "hwo" becomes "who". Speaking speed
  (0.7 to 1.2) travels in the speak request; volume is a client-side gain node in `web/src/speech.ts`.
- Audio on mobile must start from a user gesture: `web/src/speech.ts` resumes one shared
  `AudioContext` synchronously in the tap handler before any `await`. Keep it that way.
