/**
 * App updates. The service worker is registered in "prompt" mode: a new build is
 * downloaded in the background but only takes over when the person taps Update (or
 * reloads twice). This hook exposes that state, a manual "check now", and a force
 * reload for when a phone is stuck on an old build (there is no Ctrl+Shift+R on a phone).
 */

import { useCallback, useRef, useState } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'

/** Short git hash and build time, injected by vite.config.ts. */
export const APP_VERSION: string = __APP_VERSION__

// Re-check for a new build this often while the app stays open (PWAs can live for days).
const CHECK_INTERVAL_MS = 60 * 60 * 1000

/**
 * What a manual check found. `ready`: a new build is waiting (tap Update). `latest`: the
 * server has the same build. `unavailable`: no service worker here (the dev server, or a
 * browser that refused to register one), so there is nothing to check. `failed`: the check
 * itself errored, e.g. the login expired and the worker script came back as a login page.
 */
export type CheckResult = 'ready' | 'latest' | 'unavailable' | 'failed'

export type AppUpdate = {
  /** A newer build is installed and waiting; `update()` switches to it. */
  needRefresh: boolean
  /** Activate the waiting build and reload. */
  update: () => Promise<void>
  /** Ask the server whether a newer build exists. */
  checkNow: () => Promise<CheckResult>
  checking: boolean
  /**
   * Drop every cached copy of the app (service workers and their caches, never
   * localStorage) and reload from the server. The phone equivalent of a hard refresh.
   */
  forceReload: () => Promise<void>
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

  const checkNow = useCallback(async (): Promise<CheckResult> => {
    const reg = registration.current ?? (await navigator.serviceWorker?.getRegistration())
    if (!reg) return 'unavailable'
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
      if (!reg.waiting) return 'latest'
      setNeedRefresh(true)
      return 'ready'
    } catch {
      return 'failed'
    } finally {
      setChecking(false)
    }
  }, [setNeedRefresh])

  const forceReload = useCallback(async () => {
    try {
      const regs = (await navigator.serviceWorker?.getRegistrations()) ?? []
      await Promise.all(regs.map((r) => r.unregister()))
      if ('caches' in window) {
        const keys = await caches.keys()
        await Promise.all(keys.map((k) => caches.delete(k)))
      }
    } catch {
      // Whatever survived, the reload below still bypasses the (now unregistered) worker.
    }
    // A cache-busting query so the HTML itself is not served from the HTTP cache either;
    // the app ignores it. The service worker re-registers on this load.
    const url = new URL(window.location.href)
    url.searchParams.set('reload', Date.now().toString(36))
    window.location.replace(url.toString())
  }, [])

  return { needRefresh, update, checkNow, checking, forceReload }
}
