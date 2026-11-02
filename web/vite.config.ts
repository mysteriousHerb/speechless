import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { execSync } from 'node:child_process'

function gitShortHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return 'dev'
  }
}

// Shown in Settings so you can tell which build a phone is running.
const appVersion = `${gitShortHash()} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  plugins: [
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
        theme_color: '#1b1f3b',
        background_color: '#1b1f3b',
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
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [{ urlPattern: /^\/api\//, handler: 'NetworkOnly' }],
      },
    }),
  ],
  server: {
    host: true, // reachable from a phone on the same network / tailnet
    port: 5173,
    allowedHosts: ['.ts.net'], // Tailscale MagicDNS names, so the dev server opens from a phone on the tailnet
    proxy: { '/api': 'http://localhost:8000' },
  },
})
