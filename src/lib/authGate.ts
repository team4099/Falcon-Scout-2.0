/**
 * Which screen the app should show for a given auth/query state.
 *
 * This used to live inline in App.tsx as a run of early returns, tangled up
 * with twenty page imports — which made it effectively untestable, and a
 * guest-login bug shipped through it: for a render or two after sign-in,
 * `viewer` and `access` still hold the results the queries resolved to while
 * signed out (`null`), and the old code read viewer === null as "no account"
 * and sent the freshly signed-in guest back to the login screen.
 *
 * Keeping it pure here means the ordering (offline cache beats spinner beats
 * login beats guest gate) is pinned by authGate.test.ts.
 */
export type AuthGate =
  /** Render the authenticated shell straight from cache — offline escape hatch. */
  | "cached"
  /** Spinner: auth or the identity-scoped queries haven't settled yet. */
  | "loading"
  /** Sign-in screen. */
  | "login"
  /** Signed in, but not a team member and not (yet) an approved guest. */
  | "guest"
  /** Full access. */
  | "app";

export type AccessStatus = "team" | "approved" | "none" | "pending" | "denied";

export interface AuthGateInput {
  /** navigator.onLine. */
  online: boolean;
  /** A stored JWT *and* a cached viewer exist — this device completed a sign-in. */
  offlineReady: boolean;
  isLoading: boolean;
  isAuthenticated: boolean;
  /** True once BACKEND_TIMEOUT_MS has passed since mount. */
  backendTimedOut: boolean;
  /** api.users.viewer: undefined = in flight, null = resolved with no identity. */
  viewer: unknown;
  /** api.guests.myAccess: undefined = in flight, null = resolved with no identity. */
  access: { status: AccessStatus } | null | undefined;
}

export function resolveAuthGate({
  online,
  offlineReady,
  isLoading,
  isAuthenticated,
  backendTimedOut,
  viewer,
  access,
}: AuthGateInput): AuthGate {
  // ── Escape hatch 1: the browser knows it is offline ─────────────────────
  // Deliberately ignores isAuthenticated: offline, Convex cannot refresh the
  // token and may report "signed out", which must never lock a scout out of
  // their data mid-event.
  if (!online && offlineReady) return "cached";

  // ── Escape hatch 2: online, but the backend never answered ──────────────
  const explicitlySignedOut = !isLoading && !isAuthenticated;
  const authUnresolved = isLoading || viewer === undefined;
  if (!explicitlySignedOut && authUnresolved && backendTimedOut && offlineReady) {
    return "cached";
  }

  if (isLoading) return "loading";
  if (!isAuthenticated) return "login";

  // Authenticated, but the identity-scoped queries have not caught up.
  // `undefined` = still in flight; `null` = resolved against the *previous*
  // (signed-out) identity. Neither means "this person has no account", so we
  // wait rather than bouncing them to the login screen.
  const identityResolving = viewer == null || access == null;
  if (identityResolving) return backendTimedOut ? "login" : "loading";

  return access.status === "team" || access.status === "approved" ? "app" : "guest";
}
