import { keepWordList, type Settings } from './settings'
import { apiFetch } from './api'

/**
 * Fix typos in a typed message before it is spoken, so the voice says "how are we
 * doing" rather than reading "hwo are we doing" letter-perfect. The server asks its LLM,
 * telling it the person's own abbreviations (settings.keepWords) are not typos. Best
 * effort: on any failure, a slow LLM, or no LLM at all, the original text is returned.
 */

// Hard cap on the extra wait before speech starts. Beyond this, speak what was typed.
// The whole turn (type, fix, generate speech) is what the other person waits for, so
// this is deliberately tight; Haiku with thinking off usually answers well under it.
export const TIDY_TIMEOUT_MS = 2000

export type TidyResult = { text: string; changed: boolean }

export async function tidyText(text: string, settings: Settings, timeoutMs = TIDY_TIMEOUT_MS): Promise<TidyResult> {
  const unchanged: TidyResult = { text, changed: false }
  if (!text.trim()) return unchanged
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await apiFetch('/api/tidy', {
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
