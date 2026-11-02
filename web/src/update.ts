/**
 * App updates. The service worker is registered in "prompt" mode: a new build is
 * downloaded in the background but only takes over when the person taps Update (or
 * reloads twice). This hook exposes that state plus a manual "check now".
 */

import { useCallback, useRef, useState } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'

/** Short git hash and build time, injected by vite.config.ts. */
export const APP_VERSION: string = __APP_VERSION__

// Re-check for a new build this often while the app stays open (PWAs can live for days).
const CHECK_INTERVAL_MS = 60 * 60 * 1000

export type AppUpdate = {
  /** A newer build is installed and waiting; `update()` switches to it. */
  needRefresh: boolean
  /** Activate the waiting build and reload. */
  update: () => Promise<void>
  /** Ask the server whether a newer build exists. Resolves to true if one is now waiting. */
  checkNow: () => Promise<boolean>
  checking: boolean
}

export function useAppUpdate(): AppUpdate {
  const registration = useRef<ServiceWorkerRegistration | null>(null)
  const [checking, setChecking] = useState(false)
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, reg) {
      registration.current = reg ?? null
      if (reg) setInterval(() => void reg.update().catch(() => {}), CHECK_INTERVAL_MS)
    },
  })

  const update = useCallback(async () => {
    try {
      await updateServiceWorker(true)
    } finally {
      // updateServiceWorker reloads once the new worker takes control; if there was no
      // waiting worker (or no SW support at all), a plain reload still gets fresh files.
      setTimeout(() => window.location.reload(), 1500)
    }
  }, [updateServiceWorker])

  const checkNow = useCallback(async () => {
    const reg = registration.current ?? (await navigator.serviceWorker?.getRegistration())
    if (!reg) return false
    setChecking(true)
    try {
      await reg.update()
      // If a worker is installing, wait for it to finish so the result is honest.
      const installing = reg.installing
      if (installing) {
        await new Promise<void>((resolve) => {
          const done = () => installing.state !== 'installing' && resolve()
          installing.addEventListener('statechange', done)
          setTimeout(resolve, 15000)
        })
      }
      const waiting = Boolean(reg.waiting)
      if (waiting) setNeedRefresh(true)
      return waiting
    } catch {
      return false
    } finally {
      setChecking(false)
    }
  }, [setNeedRefresh])

  return { needRefresh, update, checkNow, checking }
}
