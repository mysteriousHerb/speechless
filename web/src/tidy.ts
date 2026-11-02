import { keepWordList, type Settings } from './settings'

/**
 * Fix typos in a typed message before it is spoken, so the voice says "hello there"
 * rather than reading "hwllo tehre" letter-perfect. The server does a dictionary pass
 * (about a millisecond, never rephrases). Best effort: on any failure or a slow network
 * the original text is returned unchanged.
 */

// Hard cap on the extra wait before speech starts. Beyond this, speak what was typed.
export const TIDY_TIMEOUT_MS = 1500

export type TidyResult = { text: string; changed: boolean }

export async function tidyText(text: string, settings: Settings, timeoutMs = TIDY_TIMEOUT_MS): Promise<TidyResult> {
  const unchanged: TidyResult = { text, changed: false }
  if (!text.trim()) return unchanged
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch('/api/tidy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, keep: keepWordList(settings) }),
      signal: controller.signal,
    })
    if (!res.ok) return unchanged
    const body = (await res.json()) as { text?: unknown }
    const fixed = typeof body.text === 'string' ? body.text.trim() : ''
    if (!fixed) return unchanged
    return { text: fixed, changed: fixed !== text.trim() }
  } catch {
    return unchanged
  } finally {
    clearTimeout(timer)
  }
}
