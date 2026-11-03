import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import SettingsPanel from './SettingsPanel'
import { Listener, listeningSupported, type AnyListener } from './listen'
import { ServerListener, microphoneCaptureSupported, systemCaptureSupported } from './capture'
import { effectiveBackend, loadSettings, saveSettings, type Settings } from './settings'
import {
  clearClipCache,
  fetchHealth,
  setOutputDevices,
  setOutputProblemHandler,
  setVolume,
  speak,
  stopSpeaking,
  unlockAudio,
  type TtsBackend,
} from './speech'
import { FALLBACK_REPLIES, fetchSuggestions, type Turn } from './suggest'
import { tidyText } from './tidy'
import { useAppUpdate } from './update'
import { GearIcon, Logo, MicIcon, PencilIcon, PlayIcon, RepeatIcon } from './icons'

const BACKEND_LABEL: Record<TtsBackend | 'none', string> = {
  elevenlabs: 'ElevenLabs',
  edge: 'Microsoft',
  browser: 'Browser voice',
  none: 'Browser voice',
}

type Status =
  | { kind: 'idle' }
  | { kind: 'tidying'; text: string }
  | { kind: 'speaking'; text: string; turn: number | null }
  | { kind: 'error'; message: string }

export default function App() {
  const [text, setText] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [settings, setSettings] = useState<Settings>(() => loadSettings())
  const [serverHasKey, setServerHasKey] = useState(false)
  const [hasLlm, setHasLlm] = useState(false)
  const [lastUsed, setLastUsed] = useState<TtsBackend | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const appUpdate = useAppUpdate()

  // Conversation (this session only): what they said (mic) and what I said (spoken).
  const [turns, setTurns] = useState<Turn[]>([])
  const [interim, setInterim] = useState('')
  const [listening, setListening] = useState(false)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [thinking, setThinking] = useState(false)

  const inputRef = useRef<HTMLTextAreaElement>(null)
  const feedRef = useRef<HTMLElement>(null)
  const listenerRef = useRef<AnyListener | null>(null)
  const listenerSourceRef = useRef('')
  const turnsRef = useRef<Turn[]>([])
  // Bumped by Stop so a say() still waiting on the typo check does not speak afterwards.
  const sayGen = useRef(0)
  const settingsRef = useRef(settings)
  useEffect(() => {
    settingsRef.current = settings
  }, [settings])
  useEffect(() => setOutputDevices(settings.outputDeviceIds), [settings.outputDeviceIds])
  // Kept apart from `status`: the sink rejection lands asynchronously, usually during the
  // typo check, and the next status change would wipe it before anyone read it.
  const [outputProblem, setOutputProblem] = useState<string | null>(null)
  useEffect(() => setOutputProblemHandler(setOutputProblem), [])
  useEffect(() => setOutputProblem(null), [settings.outputDeviceIds])
  useEffect(() => setVolume(settings.volume), [settings.volume])

  useEffect(() => {
    void fetchHealth().then((h) => {
      setServerHasKey(h.serverHasKey)
      setHasLlm(h.llm)
    })
  }, [])

  // Keep the feed scrolled to the newest turn.
  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight })
  }, [turns, interim])

  const addTurn = (turn: Turn) => {
    turnsRef.current = [...turnsRef.current, turn]
    setTurns(turnsRef.current)
  }

  const refreshSuggestions = async () => {
    if (!turnsRef.current.some((t) => t.speaker === 'them')) return
    setThinking(true)
    try {
      const replies = await fetchSuggestions(turnsRef.current, settingsRef.current)
      if (replies === null) return // superseded by a newer request
      setSuggestions(replies)
    } catch {
      setSuggestions([])
    } finally {
      setThinking(false)
    }
  }

  const updateSettings = (next: Settings) => {
    setSettings(next)
    saveSettings(next)
    setLastUsed(null)
    clearClipCache()
  }

  /**
   * Speak a phrase. `replay` re-plays something already in the conversation without adding
   * a bubble. `typed` marks text the person keyed in themselves, which gets a quick typo
   * pass first (chips and replays are already clean).
   */
  const say = async (phrase: string, { replay = false, typed = false, turn = null as number | null } = {}) => {
    let trimmed = phrase.trim()
    if (!trimmed) return
    unlockAudio() // must run synchronously inside the gesture
    const gen = ++sayGen.current
    if (typed && settings.fixTypos && hasLlm) {
      setStatus({ kind: 'tidying', text: trimmed })
      trimmed = (await tidyText(trimmed, settings)).text
      if (sayGen.current !== gen) return // stopped while checking
    }
    if (!replay) {
      addTurn({ speaker: 'me', text: trimmed })
      setSuggestions([])
      turn = turnsRef.current.length - 1
    }
    setStatus({ kind: 'speaking', text: trimmed, turn })
    try {
      const used = await speak(trimmed, settings, serverHasKey)
      setLastUsed(used)
      setStatus({ kind: 'idle' })
    } catch (err) {
      setStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Could not speak',
      })
    }
  }

  const stop = () => {
    sayGen.current++
    stopSpeaking()
    setStatus({ kind: 'idle' })
  }

  const toggleListening = () => {
    unlockAudio()
    if (listenerRef.current?.listening) {
      listenerRef.current.stop()
      return
    }
    const callbacks = {
      onInterim: setInterim,
      onFinal: (heard: string) => {
        addTurn({ speaker: 'them', text: heard })
        void refreshSuggestions()
      },
      onError: (message: string) => setStatus({ kind: 'error', message }),
      onStateChange: setListening,
    }
    // Rebuild the listener when the source changes in Settings.
    const source = settings.listenSource
    const sourceKey = `${source}:${settings.inputDeviceId}`
    if (listenerSourceRef.current !== sourceKey) {
      listenerRef.current = null
      listenerSourceRef.current = sourceKey
    }
    listenerRef.current ??=
      source === 'browser'
        ? new Listener(callbacks)
        : new ServerListener(callbacks, {
            source,
            deviceId: settings.inputDeviceId,
            settings: () => settingsRef.current,
          })
    listenerRef.current.start()
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    const phrase = text
    setText('')
    void say(phrase, { typed: true })
    inputRef.current?.focus()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      e.currentTarget.form?.requestSubmit()
    }
  }

  const clearConversation = () => {
    turnsRef.current = []
    setTurns([])
    setSuggestions([])
  }

  const last = [...turns].reverse().find((t) => t.speaker === 'me')?.text
  const speaking = status.kind === 'speaking' || status.kind === 'tidying'
  const backendInUse = lastUsed ?? effectiveBackend(settings, serverHasKey)
  const badge = BACKEND_LABEL[backendInUse]
  const usingBrowserVoice = backendInUse === 'browser' || backendInUse === 'none'
  const canListen = useMemo(
    () =>
      settings.listenSource === 'browser'
        ? listeningSupported()
        : settings.listenSource === 'system'
          ? systemCaptureSupported()
          : microphoneCaptureSupported(),
    [settings.listenSource],
  )
  // Hearing the computer's audio would pick up our own voice: mute the listener while
  // we speak, and a moment after, so the tail of a clip is not transcribed as "them".
  useEffect(() => {
    const listener = listenerRef.current
    if (!listener) return
    if (speaking) {
      listener.setMuted(true)
      return
    }
    const t = setTimeout(() => listener.setMuted(false), 400)
    return () => clearTimeout(t)
  }, [speaking])

  // Chips: LLM suggestions, or fixed fallbacks while listening. Past phrases live in the
  // feed itself (each bubble has replay and edit), so nothing else is stacked here.
  const chips = useMemo(
    () => (suggestions.length > 0 ? suggestions : listening ? FALLBACK_REPLIES : []),
    [suggestions, listening],
  )

  if (showSettings) {
    return (
      <div className="app">
        <SettingsPanel
          settings={settings}
          serverHasKey={serverHasKey}
          hasLlm={hasLlm}
          appUpdate={appUpdate}
          onChange={updateSettings}
          onClose={() => setShowSettings(false)}
        />
      </div>
    )
  }

  return (
    <div className="app">
      <header className="top">
        <a className="brand" href="/welcome/" aria-label="Speechless home page">
          <Logo />
          <h1>Speechless</h1>
        </a>
        <div className="top-actions">
          <span className={`badge${usingBrowserVoice ? ' fallback' : ''}`} title="Voice in use">
            {badge}
          </span>
          <button type="button" className="icon-button" onClick={() => setShowSettings(true)} aria-label="Settings">
            <GearIcon />
          </button>
        </div>
      </header>

      {appUpdate.needRefresh && (
        <div className="update-banner" role="status">
          <span>A new version is ready.</span>
          <button type="button" className="secondary small" onClick={() => void appUpdate.update()}>
            Update
          </button>
        </div>
      )}

      <main className="feed" ref={feedRef} aria-label="Conversation">
        {turns.length === 0 && !interim ? (
          <div className="empty">
            <div className="empty-copy">
              <h2>
                Say it
                <br />
                out loud.
              </h2>
              <p>Type, and your phone speaks it in the voice you pick. Nothing is stored anywhere but here.</p>
            </div>
            <ul className="empty-steps">
              <li>
                <span className="step-icon ink">
                  <PencilIcon />
                </span>
                <span>
                  <b>Type and tap Speak</b>
                  <small>{hasLlm ? 'Typos are fixed on the way out' : 'Enter sends it too'}</small>
                </span>
              </li>
              {canListen && (
                <li>
                  <span className="step-icon accent">
                    <MicIcon />
                  </span>
                  <span>
                    <b>Listen to the other person</b>
                    <small>You get quick replies to tap</small>
                  </span>
                </li>
              )}
              <li>
                <span className="step-icon">
                  <RepeatIcon />
                </span>
                <span>
                  <b>Tap anything you said to repeat it</b>
                  <small>Edit it first with the pencil</small>
                </span>
              </li>
            </ul>
            {!canListen && <p className="tip">Listening to the other person is not supported in this browser.</p>}
          </div>
        ) : (
          <ul>
            {turns.map((t, i) => {
              const playing = status.kind === 'speaking' && status.turn === i
              return (
                <li key={i} className={`turn ${t.speaker}`}>
                  {t.speaker === 'me' ? (
                    <>
                      <button
                        type="button"
                        className={`bubble me${playing ? ' playing' : ''}`}
                        onClick={() => (playing ? stop() : void say(t.text, { replay: true, turn: i }))}
                        disabled={speaking && !playing}
                        aria-label={playing ? `Stop: ${t.text}` : `Say again: ${t.text}`}
                        aria-pressed={playing}
                      >
                        {playing && (
                          <span className="playing-icon" aria-hidden="true">
                            <i />
                            <i />
                            <i />
                          </span>
                        )}
                        {t.text}
                      </button>
                      {playing ? (
                        <span className="turn-note">Speaking · tap to stop</span>
                      ) : (
                        <span className="turn-actions">
                          <button
                            type="button"
                            className="turn-action"
                            onClick={() => {
                              setText(t.text)
                              inputRef.current?.focus()
                            }}
                            aria-label={`Edit: ${t.text}`}
                          >
                            <PencilIcon />
                          </button>
                          <button
                            type="button"
                            className="turn-action"
                            onClick={() => void say(t.text, { replay: true, turn: i })}
                            disabled={speaking}
                            aria-label={`Say again: ${t.text}`}
                          >
                            <PlayIcon />
                          </button>
                        </span>
                      )}
                    </>
                  ) : (
                    <>
                      <span className="turn-label">They said</span>
                      <p className="turn-text">{t.text}</p>
                    </>
                  )}
                </li>
              )
            })}
            {interim && (
              <li className="turn them">
                <span className="turn-label">They said</span>
                <p className="turn-text interim">{interim}…</p>
              </li>
            )}
          </ul>
        )}
        {turns.length > 0 && (
          <div className="feed-actions">
            <button type="button" className="link" onClick={clearConversation}>
              Clear conversation
            </button>
          </div>
        )}
      </main>

      {chips.length > 0 && (
        <section className="chips" aria-label="Quick replies">
          <div className="chips-head">
            <span className="turn-label">Quick replies</span>
            <small>Tap to say</small>
          </div>
          <div className="chips-grid">
            {chips.map((c) => (
              <span key={c} className="chip">
                <button type="button" className="chip-say" onClick={() => void say(c)} disabled={speaking}>
                  {c}
                </button>
                <button
                  type="button"
                  className="chip-edit"
                  aria-label={`Edit "${c}" before speaking`}
                  onClick={() => {
                    setText(c)
                    inputRef.current?.focus()
                  }}
                >
                  <PencilIcon />
                </button>
              </span>
            ))}
          </div>
        </section>
      )}

      <form className="composer" onSubmit={onSubmit}>
        <div className="status" role="status" aria-live="polite">
          {status.kind === 'tidying' && <span>Checking spelling…</span>}
          {status.kind === 'speaking' && <span>Speaking: “{status.text}”</span>}
          {status.kind === 'error' && <span className="error">{status.message}</span>}
          {status.kind !== 'error' && outputProblem && <span className="error">{outputProblem}</span>}
          {status.kind === 'idle' && listening && (
            <span className="live">
              {thinking
                ? 'Thinking of replies…'
                : settings.listenSource === 'system'
                  ? 'Listening to the call… (screen is not recorded, only speech is transcribed)'
                  : 'Listening to the other person…'}
            </span>
          )}
          {status.kind === 'idle' && !listening && !hasLlm && turns.some((t) => t.speaker === 'them') && (
            <span>No reply AI configured on the server.</span>
          )}
        </div>
        <textarea
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Type what you want to say"
          rows={2}
          autoFocus
          autoComplete="off"
          autoCapitalize="sentences"
          enterKeyHint="send"
          aria-label="Text to speak"
        />
        <div className="actions">
          {canListen && (
            <button
              type="button"
              className={`secondary listen ${listening ? 'on' : ''}`}
              onClick={toggleListening}
              aria-pressed={listening}
              aria-label={listening ? 'Stop listening' : 'Listen to the other person'}
              title={listening ? 'Stop listening' : 'Listen'}
            >
              {listening ? <span className="dot" /> : <MicIcon />}
            </button>
          )}
          <button
            type="button"
            className="secondary"
            onClick={() => void say(last ?? '', { replay: true })}
            disabled={!last || speaking}
          >
            Repeat
          </button>
          {speaking ? (
            <button type="button" className="primary stop" onClick={stop}>
              Stop
            </button>
          ) : (
            <button type="submit" className="primary" disabled={!text.trim()}>
              Speak
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
