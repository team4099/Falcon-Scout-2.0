import { describe, expect, test } from "vitest";
import { resolveAuthGate, type AuthGateInput } from "./authGate";

/** Signed out, online, nothing cached — the baseline every case tweaks. */
const base: AuthGateInput = {
  online: true,
  offlineReady: false,
  isLoading: false,
  isAuthenticated: false,
  backendTimedOut: false,
  viewer: null,
  access: null,
};

const gate = (o: Partial<AuthGateInput>) => resolveAuthGate({ ...base, ...o });

const signedIn = { isAuthenticated: true, viewer: { email: "x@example.org" } } as const;

describe("resolveAuthGate", () => {
  test("signed out shows the login screen", () => {
    expect(gate({})).toBe("login");
  });

  test("auth still resolving shows the spinner, not the login screen", () => {
    expect(gate({ isLoading: true })).toBe("loading");
  });

  // ── The guest-login regression ────────────────────────────────────────────
  // For a render or two after sign-in, useConvexAuth reports authenticated
  // while viewer/access still hold the results they resolved to while signed
  // out (null). Reading that as "no account" bounced a freshly signed-in guest
  // back to the login screen, where they'd sign in again and loop.
  test("authenticated but queries still on the signed-out result waits", () => {
    expect(gate({ isAuthenticated: true, viewer: null, access: null })).toBe("loading");
    expect(gate({ isAuthenticated: true, viewer: undefined, access: undefined })).toBe("loading");
    // Half-settled, either way round.
    expect(gate({ ...signedIn, access: null })).toBe("loading");
    expect(gate({ isAuthenticated: true, viewer: null, access: { status: "approved" } })).toBe(
      "loading",
    );
  });

  test("a session that never settles still falls back to login", () => {
    expect(gate({ isAuthenticated: true, viewer: null, access: null, backendTimedOut: true })).toBe(
      "login",
    );
  });

  test("team members and approved guests get the app", () => {
    expect(gate({ ...signedIn, access: { status: "team" } })).toBe("app");
    expect(gate({ ...signedIn, access: { status: "approved" } })).toBe("app");
  });

  test("unapproved guests get the guest screen, never the app", () => {
    for (const status of ["none", "pending", "denied"] as const) {
      expect(gate({ ...signedIn, access: { status } })).toBe("guest");
    }
  });

  // ── Offline behaviour must not regress ────────────────────────────────────
  test("offline with a cached session renders the app even if Convex says signed out", () => {
    expect(gate({ online: false, offlineReady: true })).toBe("cached");
  });

  test("offline without a cached session still shows login", () => {
    expect(gate({ online: false, offlineReady: false })).toBe("login");
  });

  test("online but backend silent falls back to the cache while auth is unresolved", () => {
    expect(gate({ isLoading: true, backendTimedOut: true, offlineReady: true })).toBe("cached");
  });

  test("an explicit signed-out from Convex beats the cache when online", () => {
    expect(gate({ backendTimedOut: true, offlineReady: true })).toBe("login");
  });

  test("a pending guest never reaches the cached-session escape hatch while online", () => {
    expect(
      gate({ ...signedIn, access: { status: "pending" }, backendTimedOut: true, offlineReady: true }),
    ).toBe("guest");
  });
});
