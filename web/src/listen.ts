/**
 * Listening to the other person with the browser's own speech recognition
 * (Web Speech API). Zero cost and low latency; on iOS it uses Siri's recogniser,
 * on Android Chrome it uses Google's. Not every browser has it, so callers must
 * check `listeningSupported()` and degrade gracefully.
 */

type SpeechRecognitionLike = {
  lang: string
  continuous: boolean
  interimResults: boolean
  start(): void
  stop(): void
  abort(): void
  onresult: ((e: SpeechRecognitionEventLike) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
}

type SpeechRecognitionEventLike = {
  resultIndex: number
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>
}

type Ctor = new () => SpeechRecognitionLike

function ctor(): Ctor | null {
  const w = window as unknown as { SpeechRecognition?: Ctor; webkitSpeechRecognition?: Ctor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export function listeningSupported(): boolean {
  return ctor() !== null
}

/** What App needs from any listener, browser or server based. */
export type AnyListener = {
  readonly listening: boolean
  start(): void
  stop(): void
  /** Ignore input while we are speaking ourselves (matters when hearing the computer's audio). */
  setMuted(muted: boolean): void
}

export type ListenerCallbacks = {
  onInterim: (text: string) => void
  onFinal: (text: string) => void
  onError: (message: string) => void
  onStateChange: (listening: boolean) => void
}

/**
 * Continuous recogniser that restarts itself when the browser stops it (which
 * mobile browsers do after a pause), until `stop()` is called.
 */
export class Listener {
  private rec: SpeechRecognitionLike | null = null
  private wanted = false
  private cb: ListenerCallbacks
  private lang: string

  constructor(cb: ListenerCallbacks, lang = navigator.language || 'en-US') {
    this.cb = cb
    this.lang = lang
  }

  get listening(): boolean {
    return this.wanted
  }

  setMuted(): void {
    /* the browser recogniser only hears the microphone, so our own voice is not a problem */
  }

  start(): void {
    const C = ctor()
    if (!C) {
      this.cb.onError('This browser cannot listen. Try Safari on iPhone or Chrome on Android.')
      return
    }
    this.wanted = true
    this.spin(C)
    this.cb.onStateChange(true)
  }

  stop(): void {
    this.wanted = false
    this.rec?.stop()
    this.rec = null
    this.cb.onStateChange(false)
  }

  private spin(C: Ctor): void {
    const rec = new C()
    rec.lang = this.lang
    rec.continuous = true
    rec.interimResults = true
    rec.onresult = (e) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        const text = r[0].transcript.trim()
        if (!text) continue
        if (r.isFinal) this.cb.onFinal(text)
        else interim += (interim ? ' ' : '') + text
      }
      this.cb.onInterim(interim)
    }
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return // routine on mobile
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.wanted = false
        this.cb.onError('Microphone access was blocked. Allow it in the browser settings.')
        this.cb.onStateChange(false)
        return
      }
      this.cb.onError(`Listening hiccup: ${e.error}`)
    }
    rec.onend = () => {
      this.cb.onInterim('')
      if (this.wanted && this.rec === rec) {
        // Mobile browsers end recognition after silence; keep going.
        setTimeout(() => this.wanted && this.rec === rec && this.spin(C), 150)
      }
    }
    this.rec = rec
    try {
      rec.start()
    } catch {
      /* start() throws if already started; the onend restart will handle it */
    }
  }
}
