import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { ConvexHttpClient } from 'convex/browser'
import { AppProviders } from './providers'
import { Toaster } from "@/components/ui/sonner"
import { idbEvictExpired, lsEvictExpired } from '@/lib/persistentCache'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { toast } from 'sonner'
import './index.css'

// Evict expired cache entries on every app start (runs async, non-blocking)
lsEvictExpired();
idbEvictExpired();

// ── PWA update prompt component ──────────────────────────────────────────────
function PWAUpdatePrompt() {
  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW({
    onRegistered(r) {
      console.log('[FalconScout] SW registered:', r);
    },
    onRegisterError(err) {
      console.warn('[FalconScout] SW registration error:', err);
    },
  });

  useEffect(() => {
    if (needRefresh) {
      toast('A new version is available', {
        description: 'Reload to get the latest FalconScout update.',
        action: {
          label: 'Update',
          onClick: () => updateServiceWorker(true),
        },
        duration: Infinity,
      });
    }
  }, [needRefresh, updateServiceWorker]);

  return null;
}


import App from './App.tsx'

// ─── Pre-exchange OAuth code via HTTP before React mounts ────────────────────
//
// Problem: The Convex Auth React library exchanges the ?code= via WebSocket
// (client.authenticatedCall). If the WebSocket drops or reconnects during the
// exchange (common on first page load), the action response is lost and the
// void IIFE silently swallows the rejection → user stays logged out.
//
// Fix: Detect the ?code= BEFORE React mounts, exchange it via ConvexHttpClient
// (plain HTTP — no WebSocket, no reconnection issues), store the resulting JWT
// and refresh token in localStorage using the same keys the library expects,
// then remove ?code= from the URL so ConvexAuthProvider simply reads the stored
// tokens on mount instead of trying to re-exchange a code.
// ─────────────────────────────────────────────────────────────────────────────

// Guarded with ?? "" — this module runs before React mounts, so an unset var
// used to throw at module evaluation and leave a blank white page with no
// error boundary and no message. A deploy that lost its env var looked exactly
// like a dead site. renderConfigError below says what's actually wrong.
const CONVEX_URL = (import.meta.env.VITE_CONVEX_URL ?? "") as string;

// Must match the library's key-escaping logic exactly:
// namespace = client.address (the Convex URL)
// escapedNamespace = namespace.replace(/[^a-zA-Z0-9]/g, "")
const escapedNs   = CONVEX_URL.replace(/[^a-zA-Z0-9]/g, '');
const VERIFIER_KEY = `__convexAuthOAuthVerifier_${escapedNs}`;
const JWT_KEY      = `__convexAuthJWT_${escapedNs}`;
const REFRESH_KEY  = `__convexAuthRefreshToken_${escapedNs}`;

const urlParams  = new URLSearchParams(window.location.search);
const oauthCode  = urlParams.get('code');

if (oauthCode) {
  console.log('[FalconScout] OAuth code detected – pre-exchanging via HTTP...');

  const verifier = localStorage.getItem(VERIFIER_KEY) ?? undefined;
  console.log('[FalconScout] Verifier in localStorage:', verifier ? 'present ✓' : 'MISSING ⚠️');

  // Strip ?code= from the URL immediately so ConvexAuthProvider won't try
  // to handle it again when it mounts (it reads window.location.search).
  urlParams.delete('code');
  window.history.replaceState(
    {},
    '',
    window.location.pathname + (urlParams.toString() ? `?${urlParams}` : ''),
  );

  if (verifier) {
    // Remove verifier from storage (same as the library would do).
    localStorage.removeItem(VERIFIER_KEY);

    try {
      const httpClient = new ConvexHttpClient(CONVEX_URL);

      // Call auth:signIn via HTTP — identical to what the library does via
      // WebSocket but without any reconnection risk.
      const result = await (httpClient as any).action('auth:signIn', {
        params:   { code: oauthCode },
        verifier,
      });

      console.log('[FalconScout] HTTP exchange result:', result);

      if (result?.tokens?.token && result?.tokens?.refreshToken) {
        // Store tokens under the exact keys ConvexAuthProvider reads on mount.
        localStorage.setItem(JWT_KEY,     result.tokens.token);
        localStorage.setItem(REFRESH_KEY, result.tokens.refreshToken);
        console.log('[FalconScout] ✅ Tokens stored – user will be authenticated on mount.');
      } else {
        console.warn('[FalconScout] ⚠️ Exchange returned no tokens:', result);
      }
    } catch (err) {
      console.error('[FalconScout] ❌ HTTP code exchange failed:', err);
    }
  } else {
    console.warn(
      '[FalconScout] ⚠️ Verifier missing from localStorage – cannot complete sign-in.\n' +
      'This can happen if localStorage was cleared between clicking "Sign in" and the OAuth redirect.',
    );
  }
}

// ─── Mount React ─────────────────────────────────────────────────────────────
// ConvexAuthProvider will find the JWT in localStorage (stored above) and
// authenticate the user immediately without needing to exchange any code.

const router = createBrowserRouter([
  {
    path: '/*',
    element: <App />,
  },
])

const rootEl = document.getElementById('root')!;

// Without a backend URL nothing below can work. Say so plainly rather than
// rendering an app that will hang on "Verifying session..." forever.
if (!CONVEX_URL) {
  rootEl.innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;
                padding:24px;background:#0f0a1a;color:#e8e4f0;
                font-family:system-ui,-apple-system,sans-serif;text-align:center">
      <div style="max-width:30rem">
        <div style="font-size:2rem;margin-bottom:12px">⚙️</div>
        <h1 style="font-size:1.25rem;font-weight:700;margin:0 0 10px">
          FalconScout isn't configured
        </h1>
        <p style="margin:0 0 8px;line-height:1.6;opacity:.85">
          The <code style="font-family:ui-monospace,monospace">VITE_CONVEX_URL</code>
          environment variable is missing, so the app can't reach its backend.
        </p>
        <p style="margin:0;line-height:1.6;opacity:.6;font-size:.875rem">
          If you're running locally, add it to <code
          style="font-family:ui-monospace,monospace">.env.local</code>. If you're
          seeing this on the deployed site, the build didn't receive the variable.
        </p>
      </div>
    </div>`;
  throw new Error('VITE_CONVEX_URL is not set');
}

// Guard against HMR re-executing this module and calling createRoot() twice
// on the same container (which corrupts React's fiber tree).
type RootContainer = HTMLElement & { _reactRoot?: ReturnType<typeof createRoot> };
const container = rootEl as RootContainer;
if (!container._reactRoot) {
  container._reactRoot = createRoot(container);
}
container._reactRoot.render(
  <StrictMode>
    <AppProviders>
      <RouterProvider router={router} />
      <Toaster />
      <PWAUpdatePrompt />
    </AppProviders>
  </StrictMode>,
)

