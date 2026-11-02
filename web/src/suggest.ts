import type { Settings } from './settings'

export type Turn = { speaker: 'them' | 'me'; text: string }

/** Always-available replies when there is no LLM or it is slow/down. */
export const FALLBACK_REPLIES = ['Yes', 'No', 'One moment', 'Sorry, say that again?']

let inflight: AbortController | null = null

/**
 * Ask the server for quick replies. A newer call cancels the previous one so a
 * fast talker never leaves stale suggestions on screen. Returns null if cancelled.
 */
export async function fetchSuggestions(turns: Turn[], _settings: Settings, count = 4): Promise<string[] | null> {
  inflight?.abort()
  const controller = new AbortController()
  inflight = controller
  try {
    const res = await fetch('/api/suggest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ turns: turns.slice(-12), count }),
      signal: controller.signal,
    })
    if (res.status === 503) return [] // no LLM configured; caller shows fallbacks
    if (!res.ok) throw new Error(`Suggestions failed (${res.status})`)
    const body = (await res.json()) as { replies: string[] }
    return body.replies
  } catch (err) {
    if (controller.signal.aborted) return null
    throw err
  } finally {
    if (inflight === controller) inflight = null
  }
}
