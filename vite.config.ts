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
      },
      workbox: {
        // Cache ALL static build output
        globPatterns: ['**/*.{js,ts,css,html,ico,png,jpg,jpeg,gif,svg,woff,woff2,ttf,eot,webp,json}'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024, // 4 MiB (default is 2 MiB)

        // SPA navigation fallback — any document request that misses the cache
        // is served the cached index.html so routes work offline.
        navigateFallback: 'index.html',
        // Don't intercept Convex websocket upgrades or /api calls
        navigateFallbackDenylist: [/^\/convex/, /^\/api/, /^\/__convex/],

        // ── Runtime caching strategies ──────────────────────────────────────
        runtimeCaching: [
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
