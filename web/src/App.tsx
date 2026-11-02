import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import SettingsPanel from './SettingsPanel'
import { clearHistory, loadHistory, pushHistory } from './history'
import { Listener, listeningSupported, type AnyListener } from './listen'
import { ServerListener, microphoneCaptureSupported, systemCaptureSupported } from './capture'
import { effectiveBackend, loadSettings, saveSettings, type Settings } from './settings'
import {
  clearClipCache,
  fetchHealth,
  setOutputDevices,
  setVolume,
  speak,
  stopSpeaking,
  unlockAudio,
  type TtsBackend,
} from './speech'
import { FALLBACK_REPLIES, fetchSuggestions, type Turn } from './suggest'
import { tidyText } from './tidy'
import { useAppUpdate } from './update'

const BACKEND_LABEL: Record<TtsBackend | 'none', string> = {
  elevenlabs: 'ElevenLabs voice',
  edge: 'Microsoft voice',
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
  const [history, setHistory] = useState<string[]>(() => loadHistory())
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
    if (typed && settings.fixTypos) {
      setStatus({ kind: 'tidying', text: trimmed })
      trimmed = (await tidyText(trimmed, settings)).text
      if (sayGen.current !== gen) return // stopped while checking
    }
    if (!replay) {
      setHistory((h) => pushHistory(h, trimmed))
      addTurn({ speaker: 'me', text: trimmed })
      setSuggestions([])
      turn = turnsRef.current.length - 1
    }
    setStatus({ kind: 'speaking', text: trimmed, turn })
    try {
      const used = await speak(trimmed, settings)
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

  const last = history[0]
  const speaking = status.kind === 'speaking' || status.kind === 'tidying'
  const badge = BACKEND_LABEL[lastUsed ?? effectiveBackend(settings, serverHasKey)]
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

  // Chips: LLM suggestions first (or fixed fallbacks while listening), then recents.
  const chips = useMemo(() => {
    const base = suggestions.length > 0 ? suggestions : listening ? FALLBACK_REPLIES : []
    const recents = history.filter((h) => !base.includes(h)).slice(0, 8)
    return [
      ...base.map((t) => ({ text: t, kind: 'suggestion' as const })),
      ...recents.map((t) => ({ text: t, kind: 'recent' as const })),
    ]
  }, [suggestions, listening, history])

  if (showSettings) {
    return (
      <div className="app">
        <SettingsPanel
          settings={settings}
          serverHasKey={serverHasKey}
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
        <h1>Speechless</h1>
        <button type="button" className="link" onClick={() => setShowSettings(true)} aria-label="Settings">
          {badge} · Settings
        </button>
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
          <p className="empty">
            Type below and press <b>Speak</b>.
            {canListen ? (
              <>
                {' '}
                Tap <b>Listen</b> so the phone hears the other person and offers quick replies.
              </>
            ) : (
              ' Listening to the other person is not supported in this browser.'
            )}
          </p>
        ) : (
          <ul>
            {turns.map((t, i) => {
              const playing = status.kind === 'speaking' && status.turn === i
              return (
                <li key={i} className={`turn ${t.speaker}`}>
                  {t.speaker === 'me' ? (
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
                  ) : (
                    <span className="bubble them">{t.text}</span>
                  )}
                </li>
              )
            })}
            {interim && (
              <li className="turn them">
                <span className="bubble them interim">{interim}…</span>
              </li>
            )}
          </ul>
        )}
        {turns.length > 0 && (
          <button type="button" className="link" onClick={clearConversation}>
            Clear conversation
          </button>
        )}
        {history.length > 0 && turns.length === 0 && (
          <button
            type="button"
            className="link"
            onClick={() => {
              clearHistory()
              setHistory([])
            }}
          >
            Clear recent phrases
          </button>
        )}
      </main>

      <div className="status" role="status" aria-live="polite">
        {status.kind === 'tidying' && <span>Checking spelling…</span>}
        {status.kind === 'speaking' && <span>Speaking: “{status.text}”</span>}
        {status.kind === 'error' && <span className="error">{status.message}</span>}
        {status.kind === 'idle' && listening && <span>{thinking ? 'Thinking of replies…' : 'Listening…'}</span>}
        {status.kind === 'idle' && !listening && !hasLlm && turns.some((t) => t.speaker === 'them') && (
          <span>No reply AI configured on the server.</span>
        )}
      </div>

      {chips.length > 0 && (
        <div className="chips" aria-label="Quick replies">
          {chips.map((c) => (
            <span key={`${c.kind}:${c.text}`} className={`chip ${c.kind}`}>
              <button type="button" className="chip-say" onClick={() => void say(c.text)} disabled={speaking}>
                {c.text}
              </button>
              <button
                type="button"
                className="chip-edit"
                aria-label={`Edit "${c.text}" before speaking`}
                onClick={() => {
                  setText(c.text)
                  inputRef.current?.focus()
                }}
              >
                ✎
              </button>
            </span>
          ))}
        </div>
      )}

      <form className="composer" onSubmit={onSubmit}>
        <textarea
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="What do you want to say?"
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
            >
              {listening ? '● Listening' : 'Listen'}
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
