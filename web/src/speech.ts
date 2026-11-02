/**
 * Speaking: our API (ElevenLabs or Microsoft Edge voices), with the browser's own
 * speech synthesis as a fallback when the server has no voice or it is failing.
 *
 * Mobile browsers only allow audio that starts from a user gesture. We keep one
 * AudioContext and resume it synchronously inside the tap handler; after that,
 * audio decoded later (post-fetch) is allowed to play.
 */

import type { Settings } from './settings'

export type TtsBackend = 'elevenlabs' | 'edge' | 'browser'

export type Voice = { id: string; name: string; description: string; preview_url: string | null }

export type ServerHealth = { tts: 'elevenlabs' | 'edge' | 'none'; serverHasKey: boolean; llm: boolean }

let audioContext: AudioContext | null = null
// One gain stage for everything we play, so the volume slider covers every backend
// (ElevenLabs has no volume parameter) and cached clips alike, and can boost above 1.
let gainNode: GainNode | null = null
let wantedGain = 1
let currentSource: AudioBufferSourceNode | null = null
let previewElement: HTMLAudioElement | null = null
let wantedSinkId = ''
// Further outputs (e.g. the person's own headphones while the main output feeds a
// call) that mirror what we play. One AudioContext per device, keyed by device id.
const mirrorContexts = new Map<string, AudioContext>()
let mirrorSources: AudioBufferSourceNode[] = []

type Sinkable = { setSinkId?: (id: string) => Promise<void> }

/** Whether this browser can send our audio to a chosen output device (Chrome / Edge; not Safari). */
export function outputSelectionSupported(): boolean {
  return typeof (AudioContext.prototype as Sinkable).setSinkId === 'function'
}

/**
 * Play everything on these devices at once ([] = system default). The first is the main
 * output (volume slider applies, previews play there); the rest mirror it. Typical use:
 * a virtual audio cable so a call (Teams, Zoom...) hears the voice as a microphone, plus
 * the person's own headphones. The browser's speechSynthesis fallback cannot be routed.
 */
export function setOutputDevices(deviceIds: string[]): void {
  const [main = '', ...mirrors] = deviceIds
  wantedSinkId = main
  applySink(audioContext)
  applySink(previewElement)

  for (const [id, ctx] of mirrorContexts) {
    if (!mirrors.includes(id)) {
      mirrorContexts.delete(id)
      void ctx.close()
    }
  }
  for (const id of mirrors) {
    if (mirrorContexts.has(id)) continue
    const ctx = new AudioContext()
    applySink(ctx, id)
    mirrorContexts.set(id, ctx)
  }
}

function applySink(target: object | null, sinkId = wantedSinkId): void {
  const sink = target as Sinkable | null
  if (!sink || typeof sink.setSinkId !== 'function') return
  sink.setSinkId(sinkId).catch(() => {
    /* device unplugged or not permitted: keep playing on whatever is current */
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
 * Output gain for the main output: 1 is unchanged, above 1 boosts (handy when a call
 * hears the voice too quietly through a virtual cable). The headphone monitor stays at 1.
 */
export function setVolume(volume: number): void {
  wantedGain = volume
  if (gainNode && audioContext) gainNode.gain.setValueAtTime(volume, audioContext.currentTime)
}

/** Call synchronously inside a user gesture (tap / Enter) before any awaits. */
export function unlockAudio(): void {
  if (!audioContext) {
    audioContext = new AudioContext()
    gainNode = audioContext.createGain()
    gainNode.gain.value = wantedGain
    gainNode.connect(audioContext.destination)
    if (wantedSinkId) applySink(audioContext)
  }
  if (audioContext.state === 'suspended') void audioContext.resume()
  for (const ctx of mirrorContexts.values()) if (ctx.state === 'suspended') void ctx.resume()
}

export function stopSpeaking(): void {
  currentSource?.stop()
  currentSource = null
  mirrorSources.forEach((s) => s.stop())
  mirrorSources = []
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

/** Speak `text`; resolves when playback finishes. Returns which backend spoke. */
export async function speak(text: string, settings: Settings, opts: SpeakOptions = {}): Promise<TtsBackend> {
  unlockAudio()
  stopSpeaking()

  const backend = opts.backend ?? settings.backend
  const voiceId = opts.voiceId ?? (backend === 'auto' ? undefined : settings.voices[backend])

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
    res = await fetch('/api/speak', {
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
  const buffer = await audioContext!.decodeAudioData(bytes)
  const used: TtsBackend = res.headers.get('x-tts-backend') === 'edge' ? 'edge' : 'elevenlabs'
  cacheClip(cacheKey, { buffer, backend: used })
  await playBuffer(buffer)
  return used
}

/** Play a hosted preview clip (ElevenLabs gives one per voice). Call inside a gesture. */
export function playPreviewUrl(url: string): void {
  stopSpeaking()
  if (!previewElement) {
    previewElement = new Audio()
    if (wantedSinkId) applySink(previewElement)
  }
  previewElement.src = url
  void previewElement.play().catch(() => {})
}

async function playBuffer(buffer: AudioBuffer): Promise<void> {
  const ctx = audioContext!
  await new Promise<void>((resolve) => {
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(gainNode ?? ctx.destination)
    source.onended = () => {
      if (currentSource === source) currentSource = null
      resolve()
    }
    currentSource = source
    source.start()

    // Mirror onto the other outputs (headphones...). The main output is what resolves;
    // mirrors play alongside at unity gain and are stopped with it. Each context has its
    // own clock, so a few ms of drift between devices is normal.
    mirrorSources = [...mirrorContexts.values()].map((mctx) => {
      const mirror = mctx.createBufferSource()
      mirror.buffer = buffer
      mirror.connect(mctx.destination)
      mirror.start()
      return mirror
    })
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
    const res = await fetch('/api/health')
    const body = (await res.json()) as { tts?: string; server_has_elevenlabs_key?: boolean; llm?: boolean }
    const tts = body.tts === 'elevenlabs' || body.tts === 'edge' ? body.tts : 'none'
    return { tts, serverHasKey: Boolean(body.server_has_elevenlabs_key), llm: Boolean(body.llm) }
  } catch {
    return { tts: 'none', serverHasKey: false, llm: false }
  }
}

export async function fetchVoices(backend: 'elevenlabs' | 'edge', settings: Settings): Promise<Voice[]> {
  const res = await fetch(`/api/voices?backend=${backend}`, { headers: headersFor(settings) })
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
