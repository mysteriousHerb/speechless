/**
 * Listening through the server (ElevenLabs Scribe) instead of the browser's recogniser,
 * so we can hear a chosen microphone or, more usefully, what this computer is playing:
 * the other side of a Teams / Zoom call.
 *
 * The browser gives us a raw audio stream. We watch its level, cut it into utterances
 * (speech, then ~0.9 s of quiet), encode each as 16 kHz WAV and post it to /api/transcribe.
 */

import type { ListenerCallbacks } from './listen'
import type { Settings } from './settings'
import { apiFetch } from './api'

export type CaptureSource = 'microphone' | 'system'

const SAMPLE_RATE = 16_000
const PRE_ROLL_S = 0.4 // keep a little audio from before speech was detected
const END_SILENCE_S = 0.9
const MIN_SPEECH_S = 0.35
const MAX_UTTERANCE_S = 25
const MIN_THRESHOLD = 0.012 // RMS; below this is always "quiet"

export function systemCaptureSupported(): boolean {
  return typeof navigator.mediaDevices?.getDisplayMedia === 'function'
}

export function microphoneCaptureSupported(): boolean {
  return typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof AudioWorkletNode === 'function'
}

// Tiny worklet that ships raw samples to the main thread in ~128 ms batches.
const TAP_WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = []; this.n = 0 }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) {
      this.buf.push(ch.slice()); this.n += ch.length
      if (this.n >= 2048) {
        const out = new Float32Array(this.n); let o = 0
        for (const b of this.buf) { out.set(b, o); o += b.length }
        this.port.postMessage(out, [out.buffer]); this.buf = []; this.n = 0
      }
    }
    return true
  }
}
registerProcessor('speechless-tap', Tap)
`

type Options = { source: CaptureSource; deviceId: string; settings: () => Settings }

export class ServerListener {
  private cb: ListenerCallbacks
  private opts: Options
  private wanted = false
  private muted = false
  private stream: MediaStream | null = null
  private ctx: AudioContext | null = null
  private node: AudioWorkletNode | null = null

  // Utterance state
  private preRoll: Float32Array[] = []
  private preRollLen = 0
  private speech: Float32Array[] | null = null
  private speechLen = 0
  private voicedLen = 0
  private silentLen = 0
  private noiseFloor = MIN_THRESHOLD
  private uploads: Promise<void> = Promise.resolve()

  constructor(cb: ListenerCallbacks, opts: Options) {
    this.cb = cb
    this.opts = opts
  }

  get listening(): boolean {
    return this.wanted
  }

  /** While we are speaking ourselves, ignore input so our own voice is not transcribed. */
  setMuted(muted: boolean): void {
    this.muted = muted
    if (muted) this.dropUtterance()
  }

  start(): void {
    if (this.wanted) return
    this.wanted = true
    this.cb.onStateChange(true)
    void this.open().catch((err: unknown) => {
      this.wanted = false
      this.cb.onStateChange(false)
      this.cb.onError(err instanceof Error ? err.message : 'Could not start listening')
      this.teardown()
    })
  }

  stop(): void {
    this.wanted = false
    this.flushUtterance()
    this.teardown()
    this.cb.onInterim('')
    this.cb.onStateChange(false)
  }

  private async open(): Promise<void> {
    const stream = await this.acquire()
    if (!this.wanted) {
      stream.getTracks().forEach((t) => t.stop())
      return
    }
    this.stream = stream
    const [track] = stream.getAudioTracks()
    track.addEventListener('ended', () => this.wanted && this.stop()) // "Stop sharing" in Chrome's bar

    // A 16 kHz context: the browser resamples the stream for us, Scribe gets small files.
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
    this.ctx = ctx
    const url = URL.createObjectURL(new Blob([TAP_WORKLET], { type: 'application/javascript' }))
    try {
      await ctx.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }
    const node = new AudioWorkletNode(ctx, 'speechless-tap', { numberOfOutputs: 0 })
    node.port.onmessage = (e: MessageEvent<Float32Array>) => this.onSamples(e.data)
    ctx.createMediaStreamSource(stream).connect(node)
    this.node = node
  }

  private async acquire(): Promise<MediaStream> {
    const md = navigator.mediaDevices
    if (this.opts.source === 'system') {
      if (!systemCaptureSupported()) {
        throw new Error('This browser cannot capture what the computer plays. Use Chrome or Edge on a computer.')
      }
      let stream: MediaStream
      try {
        stream = await md.getDisplayMedia({
          video: true, // Chrome insists on video; we drop it right away
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          // Chrome-only hints: offer system audio and skip this tab.
          ...({ systemAudio: 'include', selfBrowserSurface: 'exclude', preferCurrentTab: false } as object),
        })
      } catch {
        throw new Error('Sharing was cancelled. To hear a call, share the screen and tick "Also share system audio".')
      }
      stream.getVideoTracks().forEach((t) => t.stop())
      if (stream.getAudioTracks().length === 0) {
        stream.getTracks().forEach((t) => t.stop())
        throw new Error('No audio was shared. Choose "Entire screen" and tick "Also share system audio".')
      }
      return stream
    }
    const deviceId = this.opts.deviceId
    try {
      return await md.getUserMedia({
        audio: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          echoCancellation: true,
          noiseSuppression: true,
        },
      })
    } catch {
      throw new Error('Microphone access was blocked or the device is gone. Check the browser and Settings.')
    }
  }

  private teardown(): void {
    this.node?.disconnect()
    this.node = null
    void this.ctx?.close()
    this.ctx = null
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.dropUtterance()
  }

  // --- utterance detection -----------------------------------------------------

  private onSamples(samples: Float32Array): void {
    if (!this.wanted || this.muted) return
    let sum = 0
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
    const rms = Math.sqrt(sum / samples.length)
    const threshold = Math.max(MIN_THRESHOLD, this.noiseFloor * 3.5)
    const voiced = rms > threshold

    if (this.speech) {
      this.speech.push(samples)
      this.speechLen += samples.length
      if (voiced) {
        this.voicedLen += samples.length
        this.silentLen = 0
      } else {
        this.silentLen += samples.length
        this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05
      }
      if (this.silentLen >= END_SILENCE_S * SAMPLE_RATE || this.speechLen >= MAX_UTTERANCE_S * SAMPLE_RATE) {
        this.flushUtterance()
      }
      return
    }

    if (voiced) {
      this.speech = [...this.preRoll, samples]
      this.speechLen = this.preRollLen + samples.length
      this.voicedLen = samples.length
      this.silentLen = 0
      this.cb.onInterim('…')
      return
    }

    // Quiet: track the room's noise floor and keep a short pre-roll.
    this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05
    this.preRoll.push(samples)
    this.preRollLen += samples.length
    while (this.preRollLen > PRE_ROLL_S * SAMPLE_RATE && this.preRoll.length > 1) {
      this.preRollLen -= this.preRoll.shift()!.length
    }
  }

  private dropUtterance(): void {
    this.speech = null
    this.speechLen = this.voicedLen = this.silentLen = 0
    this.preRoll = []
    this.preRollLen = 0
    this.cb.onInterim('')
  }

  private flushUtterance(): void {
    const chunks = this.speech
    const voiced = this.voicedLen
    this.speech = null
    this.speechLen = this.voicedLen = this.silentLen = 0
    this.cb.onInterim('')
    if (!chunks || voiced < MIN_SPEECH_S * SAMPLE_RATE) return // a click, not a sentence
    const wav = encodeWav(chunks, SAMPLE_RATE)
    // Serialise uploads so turns arrive in the order they were spoken.
    this.uploads = this.uploads.then(() => this.upload(wav)).catch(() => {})
  }

  private async upload(wav: Blob): Promise<void> {
    const settings = this.opts.settings()
    const form = new FormData()
    form.append('audio', wav, 'utterance.wav')
    form.append('language', navigator.language || 'en')
    const headers: Record<string, string> = {}
    const key = settings.elevenLabsKey.trim()
    if (key) headers['X-ElevenLabs-Key'] = key
    let res: Response
    try {
      res = await apiFetch('/api/transcribe', { method: 'POST', headers, body: form })
    } catch {
      this.cb.onError('Could not reach the server to transcribe.')
      return
    }
    if (res.status === 503) {
      this.cb.onError('Listening through ElevenLabs needs an ElevenLabs key. Add one in Settings → Voice.')
      this.stop()
      return
    }
    if (!res.ok) {
      const detail = await res
        .json()
        .then((j) => j?.detail)
        .catch(() => null)
      this.cb.onError(typeof detail === 'string' ? detail : `Transcription failed (${res.status})`)
      return
    }
    const body = (await res.json()) as { text?: string }
    const text = (body.text ?? '').trim()
    // Scribe answers "……" for a near-silent clip; a transcript with no letters is not a turn.
    if (text && /\p{L}/u.test(text) && this.wanted) this.cb.onFinal(text)
  }
}

/** 16-bit mono PCM WAV. */
function encodeWav(chunks: Float32Array[], sampleRate: number): Blob {
  const length = chunks.reduce((n, c) => n + c.length, 0)
  const buffer = new ArrayBuffer(44 + length * 2)
  const view = new DataView(buffer)
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }
  str(0, 'RIFF')
  view.setUint32(4, 36 + length * 2, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  str(36, 'data')
  view.setUint32(40, length * 2, true)
  let off = 44
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++, off += 2) {
      const v = Math.max(-1, Math.min(1, c[i]))
      view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true)
    }
  }
  return new Blob([buffer], { type: 'audio/wav' })
}
