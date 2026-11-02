// All calls to our own API go through here so a login proxy in front of the deploy
// (Cloudflare Access) is handled in one place. When its session expires, Access answers
// every request with a redirect to its login page. Plain fetch would follow that and hand
// back HTML (or fail CORS on the cross-origin hop), which each caller would misread as a
// broken voice or LLM. Redirects are left unfollowed instead, and one means "signed out":
// reload so the login page shows and the app comes back signed in.
export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, { ...init, redirect: 'manual' })
  if (res.type === 'opaqueredirect' || (res.headers.get('content-type') ?? '').includes('text/html')) {
    window.location.reload()
    throw new TypeError('Signed out; reloading to sign in again')
  }
  return res
}
