// All calls to our own API go through here so a login proxy in front of the deploy
// (Cloudflare Access) is handled in one place. When its session expires, Access answers
// every request with a redirect to its login page. Plain fetch would follow that and hand
// back HTML (or fail CORS on the cross-origin hop), which each caller would misread as a
// broken voice or LLM. Redirects are left unfollowed instead, and one means "signed out":
// reload so the login page shows and the app comes back signed in.
//
// Only a redirect, or a 200 that is HTML (the service worker handing back the cached app
// shell), counts as signed out. An HTML error page (Cloudflare's 502 while the API is
// down) is a normal failure, and reloads are rate-limited so a stuck proxy cannot loop
// the page forever and lock the person out of Settings and the browser voice.
const RELOAD_KEY = 'speechless.signed-out-reload'
const RELOAD_EVERY_MS = 30_000

export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, { ...init, redirect: 'manual' })
  const isHtml = (res.headers.get('content-type') ?? '').includes('text/html')
  if (res.type === 'opaqueredirect' || (res.ok && isHtml)) {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0)
    if (Date.now() - last > RELOAD_EVERY_MS) {
      sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
      window.location.reload()
    }
    throw new TypeError('Signed out; reload to sign in again')
  }
  return res
}
