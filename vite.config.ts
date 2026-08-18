import path from "path"
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      // Inline the service worker registration (required for dev mode)
      injectRegister: 'auto',
      // Expose the SW for dev preview as well
      devOptions: {
        enabled: true,
        type: 'module',
        // The dev SW otherwise only falls back to index.html for "/", so
        // reloading a deep route (/scout, /settings, ...) while offline 404s.
        // Allow every path except Vite's internal endpoints (/__vite_ping).
        navigateFallback: 'index.html',
        navigateFallbackAllowlist: [/^\/(?!__).*/],
        suppressWarnings: true,
      },
      workbox: {
        // Cache ALL static build output
        globPatterns: ['**/*.{js,ts,css,html,ico,png,jpg,jpeg,gif,svg,woff,woff2,ttf,eot,webp,json}'],
        // The main bundle is already ~2.1 MiB; keep plenty of headroom so a
        // growing bundle never silently drops out of the precache manifest
        // (workbox skips oversized files with only a build-log warning).
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024, // 8 MiB (default is 2 MiB)

        // SPA navigation fallback — any document request that misses the cache
        // is served the cached index.html so routes work offline.
        navigateFallback: 'index.html',
        // Don't intercept Convex websocket upgrades or /api calls
        navigateFallbackDenylist: [/^\/convex/, /^\/api/, /^\/__convex/],

        // ── Runtime caching strategies ──────────────────────────────────────
        runtimeCaching: [
          // ── Same-origin app code ────────────────────────────────────────
          // In a *production* build these routes are effectively inert: every
          // same-origin asset is already answered by the precache route that
          // workbox registers ahead of the runtime routes.
          //
          // In *dev* they are what makes offline reload work at all. Vite
          // serves the module graph on demand (/src/*.tsx, /@vite/client,
          // /@react-refresh, /node_modules/.vite/deps/*), so none of it is in
          // the dev precache manifest and an offline reload previously failed
          // with ERR_INTERNET_DISCONNECTED for every one of them.
          //
          // Two routes, matched in order, so behaviour follows connectivity:
          //   1. network known-bad → CacheFirst, no doomed round trip.
          //   2. otherwise         → NetworkFirst, so you never debug stale
          //      code; the cache is only a fallback.
          //
          // "Known-bad" is either navigator.onLine === false, or the circuit
          // breaker below. The breaker matters because the dev module graph is
          // a ~130-request import waterfall: when the dev server is dead but
          // the machine is still online (venue wifi with no uplink — exactly
          // the case App.tsx guards against) every request pays its own
          // connection-refused delay, which serialises into ~34s of blank
          // screen. One failure now trips the breaker and the rest of the
          // graph is served straight from cache; a success clears it.
          {
            urlPattern: ({ url, request, sameOrigin }) =>
              sameOrigin &&
              request.destination !== 'document' &&
              !url.pathname.startsWith('/__') &&
              (!(globalThis as any).navigator.onLine ||
                Date.now() < ((globalThis as any).__fsNetDownUntil || 0)),
            handler: 'CacheFirst',
            options: {
              cacheName: 'app-runtime',
              plugins: [
                {
                  // Vite appends cache-busting queries (?t=…, ?v=…) that change
                  // between loads, so the raw URL is never a stable cache key.
                  // Normalising it here — rather than via matchOptions
                  // ignoreSearch — keeps the key consistent for reads, writes
                  // *and* ExpirationPlugin, which indexes entries by exact URL
                  // and would otherwise treat every hit as untracked and throw
                  // the cached response away.
                  cacheKeyWillBeUsed: async ({ request }) => {
                    const u = new URL(request.url);
                    u.search = '';
                    return u.href;
                  },
                },
              ],
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: ({ url, request, sameOrigin }) =>
              sameOrigin &&
              request.destination !== 'document' &&
              // Never cache Vite's heartbeat — a cached 200 would make the HMR
              // client believe the dev server came back and reload in a loop.
              !url.pathname.startsWith('/__'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'app-runtime',
              networkTimeoutSeconds: 3,
              plugins: [
                {
                  cacheKeyWillBeUsed: async ({ request }) => {
                    const u = new URL(request.url);
                    u.search = '';
                    return u.href;
                  },
                  // Circuit breaker: trip on a failed fetch, clear on a good
                  // one. Held on the worker global so it survives across
                  // requests, and resets whenever the browser restarts the
                  // worker — so a stale trip can never outlive the session.
                  fetchDidFail: async () => {
                    (globalThis as any).__fsNetDownUntil = Date.now() + 15000;
                  },
                  fetchDidSucceed: async ({ response }: { response: Response }) => {
                    (globalThis as any).__fsNetDownUntil = 0;
                    return response;
                  },
                },
              ],
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          // Google Fonts stylesheet — stale-while-revalidate with long expiry
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'google-fonts-stylesheets',
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24 * 365, // 1 year
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          // Google Fonts actual font files — cache-first (immutable)
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-webfonts',
              expiration: {
                maxEntries: 30,
                maxAgeSeconds: 60 * 60 * 24 * 365,
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      manifest: {
        name: 'FalconScout 2.0',
        short_name: 'FalconScout',
        description: 'Team 4099 FRC Scouting Application',
        theme_color: '#863bff',
        background_color: '#0f0a1a',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: '/pwa-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/pwa-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
          {
            src: '/pwa-192.svg',
            sizes: '192x192',
            type: 'image/svg+xml',
            purpose: 'any',
          },
          {
            src: '/pwa-512.svg',
            sizes: '512x512',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
})
