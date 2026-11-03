/**
 * Speaking: our API (ElevenLabs or Microsoft Edge voices), with the browser's own
 * speech synthesis as a fallback when the server has no voice or it is failing.
 *
 * Mobile browsers only allow audio that starts from a user gesture. We create and
 * resume our AudioContexts synchronously inside the tap handler; after that,
 * audio decoded later (post-fetch) is allowed to play.
 */

import { effectiveBackend, type Settings } from './settings'
import { apiFetch } from './api'

export type TtsBackend = 'elevenlabs' | 'edge' | 'browser'

export type Voice = { id: string; name: string; description: string; preview_url: string | null }

export type ServerHealth = { tts: 'elevenlabs' | 'edge' | 'none'; serverHasKey: boolean; llm: boolean }

type Sinkable = { setSinkId?: (id: string) => Promise<void> }

/**
 * One output per device the voice plays on ('' = system default). Each has its own
 * AudioContext (a context has one sink) and its own gain stage, so the volume slider
 * covers every backend (ElevenLabs has no volume parameter) and every device alike, and
 * can boost above 1. Outputs are equal: a virtual cable into a call and the person's
 * own headphones both get the slider.
 */
type Output = { ctx: AudioContext; gain: GainNode; sources: AudioBufferSourceNode[] }
const outputs = new Map<string, Output>()
let wantedSinkIds: string[] = ['']
let wantedGain = 1
let unlocked = false
let previewElement: HTMLAudioElement | null = null
let onOutputProblem: (message: string) => void = () => {}

/** Whether this browser can send our audio to a chosen output device (Chrome / Edge; not Safari). */
export function outputSelectionSupported(): boolean {
  return typeof (AudioContext.prototype as Sinkable).setSinkId === 'function'
}

/** Where to report an output device that could not be used (the voice then plays on the default). */
export function setOutputProblemHandler(handler: (message: string) => void): void {
  onOutputProblem = handler
}

/**
 * Play everything on these devices at once ([] = system default), all at the slider's
 * volume. Typical use: a virtual audio cable so a call (Teams, Zoom...) hears the voice
 * as a microphone, plus the person's own headphones. Contexts are only created once a
 * gesture has unlocked audio (mobile browsers refuse otherwise), so before the first tap
 * this just records the wish. The browser's speechSynthesis fallback cannot be routed.
 */
export function setOutputDevices(deviceIds: string[]): void {
  wantedSinkIds = deviceIds.length ? [...new Set(deviceIds)] : ['']
  if (unlocked) syncOutputs()
  applySink(previewElement, wantedSinkIds[0])
}

function syncOutputs(): void {
  for (const [id, out] of outputs) {
    if (!wantedSinkIds.includes(id)) {
      outputs.delete(id)
      void out.ctx.close()
    }
  }
  for (const id of wantedSinkIds) {
    if (outputs.has(id)) continue
    const ctx = new AudioContext()
    const gain = ctx.createGain()
    gain.gain.value = wantedGain
    gain.connect(ctx.destination)
    applySink(ctx, id)
    outputs.set(id, { ctx, gain, sources: [] })
  }
}

function applySink(target: object | null, sinkId: string): void {
  const sink = target as Sinkable | null
  if (!sink || typeof sink.setSinkId !== 'function' || !sinkId) return
  sink.setSinkId(sinkId).catch((err: unknown) => {
    // Device unplugged, id stale or not permitted: the audio plays on the default
    // instead, which the person must know about (a call may now hear nothing).
    const why = err instanceof Error && err.name ? ` (${err.name})` : ''
    onOutputProblem(`One of the outputs ticked in Settings cannot be used${why}; playing on the system default instead.`)
  })
}

// Decoded clips from this session, keyed by text + voice, so repeating a phrase
// (tapping its bubble, "Repeat") plays instantly instead of re-generating it.
const CLIP_CACHE_LIMIT = 40
const clipCache = new Map<string, { buffer: AudioBuffer; backend: TtsBackend }>()

function cacheClip(key: string, clip: { buffer: AudioBuffer; backend: TtsBackend }): void {
  clipCache.delete(key)
  clipCache.set(key, clip)
  if (clipCache.size > CLIP_CACHE_LIMIT) clipCache.delete(clipCache.keys().next().value!)
}

/** Forget cached clips (call when the voice settings change). */
export function clearClipCache(): void {
  clipCache.clear()
}

/**
 * Output gain on every output: 1 is unchanged, above 1 boosts (handy when a call hears
 * the voice too quietly through a virtual cable).
 */
export function setVolume(volume: number): void {
  wantedGain = volume
  for (const { ctx, gain } of outputs.values()) gain.gain.setValueAtTime(volume, ctx.currentTime)
}

/** Call synchronously inside a user gesture (tap / Enter) before any awaits. */
export function unlockAudio(): void {
  unlocked = true
  syncOutputs()
  for (const { ctx } of outputs.values()) if (ctx.state === 'suspended') void ctx.resume()
}

/** Any live context, for decoding (an AudioBuffer plays on every context alike). */
function decoder(): AudioContext {
  if (outputs.size === 0) unlockAudio()
  return outputs.values().next().value!.ctx
}

export function stopSpeaking(): void {
  for (const out of outputs.values()) {
    out.sources.forEach((s) => s.stop())
    out.sources = []
  }
  previewElement?.pause()
  if ('speechSynthesis' in window) window.speechSynthesis.cancel()
}

export class SpeakError extends Error {}

export class ApiError extends Error {
  status: number
  constructor(status: number, detail: string) {
    super(detail)
    this.status = status
  }
}

function headersFor(settings: Settings): HeadersInit {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const key = settings.elevenLabsKey.trim()
  if (key) headers['X-ElevenLabs-Key'] = key
  return headers
}

type SpeakOptions = { backend?: 'elevenlabs' | 'edge'; voiceId?: string }

/**
 * The voice to ask the server for. On 'auto' the chosen voice belongs to whichever
 * backend auto resolves to (the same resolution Settings shows), not to no backend at all.
 */
export function chosenVoice(settings: Settings, serverHasKey: boolean, opts: SpeakOptions = {}): string | undefined {
  if (opts.voiceId !== undefined) return opts.voiceId
  const backend = opts.backend ?? settings.backend
  const resolved = backend === 'auto' ? effectiveBackend(settings, serverHasKey) : backend
  return resolved === 'none' ? undefined : settings.voices[resolved]
}

/** Speak `text`; resolves when playback finishes. Returns which backend spoke. */
export async function speak(
  text: string,
  settings: Settings,
  serverHasKey: boolean,
  opts: SpeakOptions = {},
): Promise<TtsBackend> {
  unlockAudio()
  stopSpeaking()

  const backend = opts.backend ?? settings.backend
  const voiceId = chosenVoice(settings, serverHasKey, opts)

  const speed = settings.speed
  setVolume(settings.volume)

  const cacheKey = JSON.stringify([text, backend, voiceId ?? '', speed, settings.elevenLabsKey.trim() ? 1 : 0])
  const cached = clipCache.get(cacheKey)
  if (cached) {
    await playBuffer(cached.buffer)
    return cached.backend
  }

  let res: Response
  try {
    res = await apiFetch('/api/speak', {
      method: 'POST',
      headers: headersFor(settings),
      body: JSON.stringify({ text, backend, voice_id: voiceId || undefined, speed }),
    })
  } catch {
    await speakWithBrowser(text, settings)
    return 'browser'
  }

  // 503: server has no voice. 502: the server voice is down right now (ElevenLabs
  // quota, Edge endpoint changed...). Either way the person still needs to talk,
  // so use the browser voice rather than showing an error.
  if (res.status === 503 || res.status === 502) {
    await speakWithBrowser(text, settings)
    return 'browser'
  }
  if (!res.ok) {
    const detail = await res
      .json()
      .then((j) => j?.detail)
      .catch(() => null)
    throw new SpeakError(typeof detail === 'string' ? detail : `Speech failed (${res.status})`)
  }

  const bytes = await res.arrayBuffer()
  const buffer = await decoder().decodeAudioData(bytes)
  const used: TtsBackend = res.headers.get('x-tts-backend') === 'edge' ? 'edge' : 'elevenlabs'
  cacheClip(cacheKey, { buffer, backend: used })
  await playBuffer(buffer)
  return used
}

/** Play a hosted preview clip (ElevenLabs gives one per voice). Call inside a gesture. */
export function playPreviewUrl(url: string): void {
  stopSpeaking()
  if (!previewElement) {
    previewElement = new Audio() // a media element has one sink: previews use the first ticked output
    applySink(previewElement, wantedSinkIds[0])
  }
  previewElement.src = url
  void previewElement.play().catch(() => {})
}

async function playBuffer(buffer: AudioBuffer): Promise<void> {
  if (outputs.size === 0) unlockAudio()
  // The same clip on every output. Each context has its own clock, so a few ms of drift
  // between devices is normal; the first output to finish resolves (they are equal length).
  await new Promise<void>((resolve) => {
    for (const out of outputs.values()) {
      const source = out.ctx.createBufferSource()
      source.buffer = buffer
      source.connect(out.gain)
      source.onended = () => {
        out.sources = out.sources.filter((s) => s !== source)
        resolve()
      }
      out.sources.push(source)
      source.start()
    }
  })
}

function speakWithBrowser(text: string, settings: Settings): Promise<void> {
  if (!('speechSynthesis' in window)) {
    throw new SpeakError('No speech available: the server has no voice and this browser cannot speak.')
  }
  return new Promise((resolve, reject) => {
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.rate = settings.speed
    utterance.volume = Math.min(1, settings.volume) // the browser voice cannot boost
    utterance.onend = () => resolve()
    utterance.onerror = (e) =>
      e.error === 'interrupted' || e.error === 'canceled'
        ? resolve()
        : reject(new SpeakError(`Browser speech failed: ${e.error}`))
    window.speechSynthesis.speak(utterance)
  })
}

export async function fetchHealth(): Promise<ServerHealth> {
  try {
    const res = await apiFetch('/api/health')
    const body = (await res.json()) as { tts?: string; server_has_elevenlabs_key?: boolean; llm?: boolean }
    const tts = body.tts === 'elevenlabs' || body.tts === 'edge' ? body.tts : 'none'
    return { tts, serverHasKey: Boolean(body.server_has_elevenlabs_key), llm: Boolean(body.llm) }
  } catch {
    return { tts: 'none', serverHasKey: false, llm: false }
  }
}

export async function fetchVoices(backend: 'elevenlabs' | 'edge', settings: Settings): Promise<Voice[]> {
  const res = await apiFetch(`/api/voices?backend=${backend}`, { headers: headersFor(settings) })
  if (!res.ok) {
    const detail = await res
      .json()
      .then((j) => j?.detail)
      .catch(() => null)
    throw new ApiError(res.status, typeof detail === 'string' ? detail : `Could not load voices (${res.status})`)
  }
  const body = (await res.json()) as { voices: Voice[] }
  return body.voices
}
