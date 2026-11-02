const KEY = 'speechless.history.v1'
export const HISTORY_LIMIT = 30

export function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** Newest first, de-duplicated, capped. */
export function pushHistory(history: string[], phrase: string): string[] {
  const next = [phrase, ...history.filter((p) => p !== phrase)].slice(0, HISTORY_LIMIT)
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* storage may be unavailable (private mode); history is a convenience */
  }
  return next
}

export function clearHistory(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}
