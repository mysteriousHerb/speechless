import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

function gitShortHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return 'dev'
  }
}

// A worktree slot has its own API port in the root .env.dev (written by the harness, read by
// start-dev too); the canonical checkout has no such file and proxies to the default 8000.
function apiPort(): string {
  if (process.env.API_PORT) return process.env.API_PORT
  const envDev = new URL('../.env.dev', import.meta.url)
  if (existsSync(envDev)) {
    const m = readFileSync(envDev, 'utf8').match(/^API_PORT=(\d+)/m)
    if (m) return m[1]
  }
  return '8000'
}

// Shown in Settings so you can tell which build a phone is running.
const appVersion = `${gitShortHash()} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  plugins: [
    // Dev only: serve the static landing page at /welcome/ instead of the app shell, as a
    // static host does for the built output.
    {
      name: 'landing-page',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          const page = /^\/welcome(\/[a-z-]+)?\/?$/.exec(req.url ?? '')
          if (page) req.url = `/welcome${page[1] ?? ''}/index.html`
          next()
        })
      },
    },
    react(),
    // Self-signed HTTPS in dev: the microphone and the PWA need a secure context on a phone.
    basicSsl(),
    VitePWA({
      // A new build downloads in the background; the app shows an Update banner and
      // Settings has an Update button (web/src/update.ts). Nothing switches silently.
      registerType: 'prompt',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Speechless',
        short_name: 'Speechless',
        description: 'Type it, and your phone says it out loud.',
        theme_color: '#f7f7f8',
        background_color: '#f7f7f8',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Never cache speech audio; always go to the network for the API.
        // The landing page at /welcome/ is its own document, not the app shell.
        navigateFallbackDenylist: [/^\/api\//, /^\/welcome/],
        runtimeCaching: [{ urlPattern: /^\/api\//, handler: 'NetworkOnly' }],
      },
    }),
  ],
  server: {
    host: true, // reachable from a phone on the same network / tailnet
    port: 5173,
    allowedHosts: ['.ts.net'], // Tailscale MagicDNS names, so the dev server opens from a phone on the tailnet
    proxy: { '/api': `http://localhost:${apiPort()}` },
  },
})
