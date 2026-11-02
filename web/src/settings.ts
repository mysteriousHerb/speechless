/**
 * Per-device settings, kept in localStorage. This is a single-user app: the
 * ElevenLabs key is the person's own and lives only on their phone, sent to our
 * server per request and never stored there.
 */

export type BackendMode = 'auto' | 'elevenlabs' | 'edge'
export type ServerBackend = 'elevenlabs' | 'edge'
/**
 * How we hear the other person:
 *  - browser: the browser's own recogniser (free, default microphone only)
 *  - microphone: a chosen microphone, transcribed by ElevenLabs Scribe
 *  - system: what this computer plays (a Teams/Zoom call), transcribed by Scribe
 */
export type ListenSource = 'browser' | 'microphone' | 'system'

export type Settings = {
  elevenLabsKey: string
  backend: BackendMode
  /** Chosen voice per backend; empty means the server default. */
  voices: Partial<Record<ServerBackend, string>>
  /** Output devices (MediaDeviceInfo.deviceId) the voice plays on, all at once: e.g. a
   * virtual cable into a call plus the person's own headphones. Empty means the system
   * default. The first one is the "main" output the volume slider boosts. */
  outputDeviceIds: string[]
  /** Microphone (MediaDeviceInfo.deviceId); empty means the system default. */
  inputDeviceId: string
  listenSource: ListenSource
  /** Run typed messages through the LLM to fix typos before speaking (needs a server LLM). */
  fixTypos: boolean
  /** Abbreviations and names the typo fix must never change, comma- or space-separated. */
  keepWords: string
  /** Speaking rate multiplier, 0.7 (slow) to 1.2 (fast); 1 is the voice's natural pace. */
  speed: number
  /** Output gain, 0.2 to 2; 1 is unchanged, above 1 boosts (useful into a virtual cable). */
  volume: number
}

export const MIN_SPEED = 0.7
export const MAX_SPEED = 1.2
export const MIN_VOLUME = 0.2
export const MAX_VOLUME = 2

const KEY = 'speechless.settings.v1'

export const DEFAULT_SETTINGS: Settings = {
  elevenLabsKey: '',
  backend: 'auto',
  voices: {},
  outputDeviceIds: [],
  inputDeviceId: '',
  listenSource: 'browser',
  fixTypos: true,
  keepWords: '',
  speed: 1,
  volume: 1,
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

/** The keep-words setting as a clean list for the server. */
export function keepWordList(settings: Settings): string[] {
  return settings.keepWords
    .split(/[\s,]+/)
    .map((w) => w.trim())
    .filter(Boolean)
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULT_SETTINGS
    const parsed = JSON.parse(raw) as Partial<Settings>
    return {
      elevenLabsKey: typeof parsed.elevenLabsKey === 'string' ? parsed.elevenLabsKey : '',
      backend: parsed.backend === 'elevenlabs' || parsed.backend === 'edge' ? parsed.backend : 'auto',
      voices: typeof parsed.voices === 'object' && parsed.voices ? parsed.voices : {},
      outputDeviceIds: readOutputDevices(parsed as Record<string, unknown>),
      inputDeviceId: typeof parsed.inputDeviceId === 'string' ? parsed.inputDeviceId : '',
      listenSource:
        parsed.listenSource === 'microphone' || parsed.listenSource === 'system' ? parsed.listenSource : 'browser',
      fixTypos: typeof parsed.fixTypos === 'boolean' ? parsed.fixTypos : true,
      keepWords: typeof parsed.keepWords === 'string' ? parsed.keepWords : '',
      speed: clampNumber(parsed.speed, MIN_SPEED, MAX_SPEED, 1),
      volume: clampNumber(parsed.volume, MIN_VOLUME, MAX_VOLUME, 1),
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

function readOutputDevices(parsed: Record<string, unknown>): string[] {
  const ids = parsed.outputDeviceIds
  if (Array.isArray(ids)) return ids.filter((x): x is string => typeof x === 'string' && x !== '')
  // Older settings had one main output and one optional headphone mirror.
  const legacy = [parsed.outputDeviceId, parsed.monitorDeviceId]
  return legacy.filter((x): x is string => typeof x === 'string' && x !== '')
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings))
  } catch {
    /* private mode etc.; settings just won't persist */
  }
}

/** Which server backend the current settings will end up using. */
export function effectiveBackend(settings: Settings, serverHasKey: boolean): ServerBackend | 'none' {
  const hasKey = Boolean(settings.elevenLabsKey.trim()) || serverHasKey
  if (settings.backend === 'auto') return hasKey ? 'elevenlabs' : 'edge'
  if (settings.backend === 'elevenlabs') return hasKey ? 'elevenlabs' : 'none'
  return 'edge'
}
