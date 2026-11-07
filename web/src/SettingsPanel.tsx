import { useEffect, useMemo, useState } from 'react'
import {
  effectiveBackend,
  MAX_SPEED,
  MAX_VOLUME,
  MIN_SPEED,
  MIN_VOLUME,
  type BackendMode,
  type ListenSource,
  type ServerBackend,
  type Settings,
} from './settings'
import { microphoneCaptureSupported, systemCaptureSupported } from './capture'
import {
  ApiError,
  fetchVoices,
  outputSelectionSupported,
  playPreviewUrl,
  speak,
  stopSpeaking,
  unlockAudio,
  type Voice,
} from './speech'
import { deviceListingSupported, listAudioDevices, requestDeviceLabels, type AudioDevices } from './devices'
import { APP_VERSION, type AppUpdate } from './update'
import { ChevronLeftIcon, PlayIcon, StopIcon } from './icons'

const PREVIEW_TEXT = "Hi, I've lost my voice, so I'm typing. This is how I sound."

function speedLabel(speed: number): string {
  if (Math.abs(speed - 1) < 0.001) return 'normal'
  return `${speed < 1 ? '−' : '+'}${Math.round(Math.abs(speed - 1) * 100)}%`
}

type Props = {
  settings: Settings
  serverHasKey: boolean
  hasLlm: boolean
  appUpdate: AppUpdate
  onChange: (next: Settings) => void
  onClose: () => void
}

export default function SettingsPanel({ settings, serverHasKey, hasLlm, appUpdate, onChange, onClose }: Props) {
  const [updateNote, setUpdateNote] = useState<string | null>(null)
  const checkForUpdate = async () => {
    setUpdateNote(null)
    const result = await appUpdate.checkNow()
    setUpdateNote(
      {
        ready: 'New version found.',
        latest: 'The server has this same build. Still looks old? Force reload.',
        unavailable: 'No offline copy to update here (dev server). Force reload gets the latest.',
        failed: 'Could not reach the server to check. Try Force reload.',
      }[result],
    )
  }
  const backend = effectiveBackend(settings, serverHasKey)
  const [catalogue, setCatalogue] = useState<ServerBackend>(backend === 'none' ? 'edge' : backend)
  const [voices, setVoices] = useState<Voice[] | null>(null)
  const [voicesError, setVoicesError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [previewing, setPreviewing] = useState<string | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [tab, setTab] = useState<'voice' | 'devices'>('voice')
  const [devices, setDevices] = useState<AudioDevices | null>(null)
  const [devicesDenied, setDevicesDenied] = useState(false)

  // Audio devices: list on open and re-list when something is (un)plugged.
  useEffect(() => {
    if (!deviceListingSupported()) return
    let cancelled = false
    const refresh = () => void listAudioDevices().then((d) => !cancelled && setDevices(d))
    refresh()
    navigator.mediaDevices.addEventListener('devicechange', refresh)
    return () => {
      cancelled = true
      navigator.mediaDevices.removeEventListener('devicechange', refresh)
    }
  }, [])

  const unlockDeviceNames = async () => {
    const ok = await requestDeviceLabels()
    setDevicesDenied(!ok)
    setDevices(await listAudioDevices())
  }

  // Keep the catalogue on whatever the settings will actually use.
  useEffect(() => {
    if (backend !== 'none') setCatalogue(backend)
  }, [backend])

  const keyForFetch = settings.elevenLabsKey.trim()
  useEffect(() => {
    let cancelled = false
    setVoices(null)
    setVoicesError(null)
    if (catalogue === 'elevenlabs' && !keyForFetch && !serverHasKey) {
      setVoicesError('Add your ElevenLabs API key to browse its voices.')
      return
    }
    const timer = setTimeout(() => {
      fetchVoices(catalogue, settings)
        .then((v) => !cancelled && setVoices(v))
        .catch((err: unknown) => {
          if (cancelled) return
          if (err instanceof ApiError && err.status === 401) setVoicesError('ElevenLabs rejected that key.')
          else if (err instanceof ApiError && err.status === 503)
            setVoicesError('Add your ElevenLabs API key to browse its voices.')
          else setVoicesError(err instanceof Error ? err.message : 'Could not load voices')
        })
    }, 400) // debounce while the key is being typed/pasted
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogue, keyForFetch, serverHasKey])

  const shown = useMemo(() => {
    if (!voices) return []
    const q = filter.trim().toLowerCase()
    if (!q) return voices
    return voices.filter((v) => `${v.name} ${v.description} ${v.id}`.toLowerCase().includes(q))
  }, [voices, filter])

  const selected = settings.voices[catalogue] ?? ''

  const choose = (voiceId: string) => onChange({ ...settings, voices: { ...settings.voices, [catalogue]: voiceId } })

  const preview = (voice: Voice) => {
    unlockAudio()
    if (previewing === voice.id) {
      stopSpeaking()
      setPreviewing(null)
      return
    }
    setPreviewing(voice.id)
    if (voice.preview_url) {
      playPreviewUrl(voice.preview_url)
      setTimeout(() => setPreviewing((p) => (p === voice.id ? null : p)), 6000)
      return
    }
    speak(PREVIEW_TEXT, settings, serverHasKey, { backend: catalogue, voiceId: voice.id })
      .catch(() => {})
      .finally(() => setPreviewing((p) => (p === voice.id ? null : p)))
  }

  const setMode = (mode: BackendMode) => onChange({ ...settings, backend: mode })

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header className="top">
        <button type="button" className="icon-button" onClick={onClose} aria-label="Done, back to the conversation">
          <ChevronLeftIcon />
        </button>
        <h1 id="settings-title">Settings</h1>
      </header>

      <div className="sheet-tabs">
        <div className="segmented" role="tablist" aria-label="Settings pages">
          {(
            [
              ['voice', 'Voice'],
              ['devices', 'Devices'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? 'on' : ''}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="sheet-body" hidden={tab !== 'voice'}>
        <section>
          <h2>ElevenLabs API key</h2>
          <div className="row">
            <input
              type={showKey ? 'text' : 'password'}
              value={settings.elevenLabsKey}
              onChange={(e) => onChange({ ...settings, elevenLabsKey: e.target.value })}
              placeholder={serverHasKey ? 'Using the server’s key' : 'sk_…'}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-label="ElevenLabs API key"
            />
            <button type="button" className="secondary small" onClick={() => setShowKey((s) => !s)}>
              {showKey ? 'Hide' : 'Show'}
            </button>
          </div>
          <p className="hint">
            Stored only on this device and sent straight to your own Speechless server. Leave empty to use the free
            Microsoft voices{serverHasKey ? ' or the server’s key' : ''}.
          </p>
        </section>

        <section>
          <h2>Voice service</h2>
          <div className="segmented" role="radiogroup" aria-label="Voice service">
            {(
              [
                ['auto', 'Auto'],
                ['elevenlabs', 'ElevenLabs'],
                ['edge', 'Microsoft'],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={settings.backend === mode}
                className={settings.backend === mode ? 'on' : ''}
                onClick={() => setMode(mode)}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="hint">
            {backend === 'elevenlabs' && 'Speaking with ElevenLabs.'}
            {backend === 'edge' && 'Speaking with the free Microsoft voices.'}
            {backend === 'none' && 'ElevenLabs needs a key; until then the browser voice is used.'}
          </p>
        </section>

        <section>
          <div className="row between">
            <h2>Voice</h2>
            <div className="segmented small" role="tablist" aria-label="Voice catalogue">
              {(
                [
                  ['elevenlabs', 'ElevenLabs'],
                  ['edge', 'Microsoft'],
                ] as const
              ).map(([b, label]) => (
                <button
                  key={b}
                  type="button"
                  role="tab"
                  aria-selected={catalogue === b}
                  className={catalogue === b ? 'on' : ''}
                  onClick={() => setCatalogue(b)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={catalogue === 'edge' ? 'Search, e.g. "English (United Kingdom)"' : 'Search voices'}
            aria-label="Search voices"
          />
          {voicesError && <p className="hint error">{voicesError}</p>}
          {!voicesError && voices === null && <p className="hint">Loading voices…</p>}
          {voices && (
            <ul className="voices" role="radiogroup" aria-label="Voices">
              <li>
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected === ''}
                  className={`voice ${selected === '' ? 'on' : ''}`}
                  onClick={() => choose('')}
                >
                  <span className="voice-body">
                    <span className="voice-name">Default</span>
                    <span className="voice-desc">Whatever the server is set to</span>
                  </span>
                </button>
              </li>
              {shown.map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selected === v.id}
                    className={`voice ${selected === v.id ? 'on' : ''}`}
                    onClick={() => choose(v.id)}
                  >
                    <span className="voice-body">
                      <span className="voice-name">{v.name}</span>
                      <span className="voice-desc">{v.description || v.id}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`play${previewing === v.id ? ' on' : ''}`}
                    aria-label={previewing === v.id ? `Stop ${v.name}` : `Preview ${v.name}`}
                    aria-pressed={previewing === v.id}
                    onClick={() => preview(v)}
                  >
                    {previewing === v.id ? <StopIcon /> : <PlayIcon />}
                  </button>
                </li>
              ))}
              {shown.length === 0 && <li className="hint">No voices match.</li>}
            </ul>
          )}
        </section>

        <section>
          <h2>Fix typos before speaking</h2>
          <div className="segmented" role="radiogroup" aria-label="Fix typos before speaking">
            {(
              [
                [true, 'On'],
                [false, 'Off'],
              ] as const
            ).map(([on, label]) => (
              <button
                key={label}
                type="button"
                role="radio"
                aria-checked={settings.fixTypos === on}
                className={settings.fixTypos === on ? 'on' : ''}
                onClick={() => onChange({ ...settings, fixTypos: on })}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="hint">
            {hasLlm
              ? 'Typed messages get a quick spelling pass so the voice says “how are we doing”, not “hwo are we doing”. Only obvious slips are fixed; your words, slang and anything in CAPITALS stay as typed. If it takes too long, the text is spoken as typed.'
              : 'Needs the server’s quick-reply model, which is not configured right now.'}
          </p>
          <label className="field">
            <span>Your abbreviations and names (never changed)</span>
            <input
              type="text"
              value={settings.keepWords}
              onChange={(e) => onChange({ ...settings, keepWords: e.target.value })}
              placeholder="e.g. Sam, Acme, innit"
              autoCapitalize="off"
              spellCheck={false}
            />
          </label>
        </section>

        <section>
          <h2>Pace and volume</h2>
          <label className="field slider">
            <span>
              Speed <output>{speedLabel(settings.speed)}</output>
            </span>
            <input
              type="range"
              min={MIN_SPEED}
              max={MAX_SPEED}
              step={0.05}
              value={settings.speed}
              onChange={(e) => onChange({ ...settings, speed: Number(e.target.value) })}
              aria-label="Speaking speed"
            />
          </label>
          <label className="field slider">
            <span>
              Volume <output>{Math.round(settings.volume * 100)}%</output>
            </span>
            <input
              type="range"
              min={MIN_VOLUME}
              max={MAX_VOLUME}
              step={0.1}
              value={settings.volume}
              onChange={(e) => onChange({ ...settings, volume: Number(e.target.value) })}
              aria-label="Output volume"
            />
          </label>
          <p className="hint">
            Speed works with every voice. Above 100% volume boosts the voice beyond the device’s own maximum, which
            helps when a call hears it quietly through a virtual cable; the browser fallback voice cannot boost.
          </p>
          <button
            type="button"
            className="secondary small"
            onClick={() => {
              unlockAudio()
              speak(PREVIEW_TEXT, settings, serverHasKey).catch(() => {})
            }}
          >
            Try it
          </button>
        </section>
      </div>

      <div className="sheet-body" hidden={tab !== 'devices'}>
        <section>
          <h2>Audio devices</h2>
          {!deviceListingSupported() && <p className="hint">This browser cannot list audio devices.</p>}
          {devices && !devices.labelled && (
            <p className="hint">
              Device names are hidden until the microphone is allowed once.{' '}
              <button type="button" className="link" onClick={() => void unlockDeviceNames()}>
                Show names
              </button>
              {devicesDenied && ' Microphone access was refused; names stay hidden.'}
            </p>
          )}
          {devices && (
            <>
              <div className="field">
                <span id="outputs-label">Speak through</span>
                <ul className="checklist" role="group" aria-labelledby="outputs-label">
                  <li>
                    <label>
                      <input
                        type="checkbox"
                        checked={settings.outputDeviceIds.length === 0}
                        disabled={!outputSelectionSupported()}
                        onChange={() => onChange({ ...settings, outputDeviceIds: [] })}
                      />
                      <span>System default</span>
                    </label>
                  </li>
                  {devices.outputs
                    .filter((d) => d.id && d.id !== 'default')
                    .map((d) => {
                      const ticked = settings.outputDeviceIds.includes(d.id)
                      return (
                        <li key={d.id}>
                          <label>
                            <input
                              type="checkbox"
                              checked={ticked}
                              disabled={!outputSelectionSupported()}
                              onChange={() =>
                                onChange({
                                  ...settings,
                                  outputDeviceIds: ticked
                                    ? settings.outputDeviceIds.filter((id) => id !== d.id)
                                    : [...settings.outputDeviceIds, d.id],
                                })
                              }
                            />
                            <span>{d.label}</span>
                          </label>
                        </li>
                      )
                    })}
                </ul>
              </div>
              <p className="hint">
                {outputSelectionSupported() ? (
                  <>
                    Tick every output the voice should play on. For a call, tick a virtual audio cable (and set it as the
                    microphone in Teams or Zoom) plus your own headphones so you hear it too. The volume slider applies
                    to every ticked output. The browser’s own fallback voice always uses the system default.{' '}
                    <a className="link" href="/welcome/calls/">
                      Step-by-step guide
                    </a>
                  </>
                ) : (
                  'This browser cannot choose an output device (Chrome or Edge on a computer can). Change the output in the system settings instead.'
                )}
              </p>
              <label className="field">
                <span>Listen with</span>
                <select
                  value={settings.listenSource}
                  onChange={(e) => onChange({ ...settings, listenSource: e.target.value as ListenSource })}
                  aria-label="Listening source"
                >
                  <option value="browser">Browser recogniser (default microphone, free)</option>
                  <option value="microphone" disabled={!microphoneCaptureSupported()}>
                    A microphone, via ElevenLabs
                  </option>
                  <option value="system" disabled={!systemCaptureSupported()}>
                    What this computer plays (Teams, Zoom), via ElevenLabs
                  </option>
                </select>
              </label>
              {settings.listenSource === 'microphone' && (
                <label className="field">
                  <span>Microphone</span>
                  <select
                    value={settings.inputDeviceId}
                    onChange={(e) => onChange({ ...settings, inputDeviceId: e.target.value })}
                    aria-label="Microphone"
                  >
                    <option value="">System default</option>
                    {devices.inputs
                      .filter((d) => d.id && d.id !== 'default')
                      .map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.label}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              <p className="hint">
                {settings.listenSource === 'browser' &&
                  'Free and instant, but it can only hear the system default microphone, so it cannot hear a call.'}
                {settings.listenSource === 'microphone' &&
                  'Each thing they say is sent to ElevenLabs Scribe to transcribe (needs an ElevenLabs key).'}
                {settings.listenSource === 'system' &&
                  'When you tap Listen, Chrome asks what to share: choose “Entire screen” and tick “Also share system audio”. The other side of the call is then transcribed by ElevenLabs Scribe (needs an ElevenLabs key). Your own voice is ignored while it plays. Chrome will say the screen is being shared, but the app never looks at it: the video is dropped the instant sharing starts, and the only thing that leaves this computer is the audio of someone speaking, sent for transcription.'}
                {settings.listenSource !== 'browser' &&
                  !(settings.elevenLabsKey.trim() || serverHasKey) &&
                  ' No ElevenLabs key is set yet: add one on the Voice tab.'}
              </p>
            </>
          )}
        </section>
      </div>

      <footer className="sheet-footer">
        <span className="hint">
          Version {APP_VERSION} ·{' '}
          <a className="link" href="/welcome/">
            About
          </a>
        </span>
        <span className="footer-actions">
          {appUpdate.needRefresh ? (
            <button type="button" className="secondary small" onClick={() => void appUpdate.update()}>
              Update now
            </button>
          ) : (
            <button
              type="button"
              className="secondary small"
              onClick={() => void checkForUpdate()}
              disabled={appUpdate.checking}
            >
              {appUpdate.checking ? 'Checking…' : 'Check for updates'}
            </button>
          )}
          {/* The phone's Ctrl+Shift+R: drops the cached app and reloads from the server. */}
          <button
            type="button"
            className="secondary small"
            onClick={() => void appUpdate.forceReload()}
            title="Clear the cached app and reload it from the server. Your settings stay."
          >
            Force reload
          </button>
        </span>
        {updateNote && !appUpdate.needRefresh && <span className="hint">{updateNote}</span>}
      </footer>
    </div>
  )
}
