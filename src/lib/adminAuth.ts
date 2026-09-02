// ── Admin Auth Utilities ───────────────────────────────────────────────────────
// Passwords are hashed client-side with SHA-256 (Web Crypto API) before storing
// in localStorage.
//
// The stored hash is also the credential sent to Convex as `adminKey` on every
// privileged mutation, where it is compared against the hash held in the
// adminConfig table (see convex/adminAuth.ts). Enabling admin mode in the UI is
// therefore no longer sufficient on its own — the server checks independently,
// so editing localStorage by hand gets you the admin menu items and nothing else.
//
// The plaintext password is never stored and never leaves the browser.

const ADMIN_PW_KEY = "falconscout_admin_pw_hash";

// SHA-256 of "passw0rd" — pre-computed so first run works without async init
const DEFAULT_HASH =
  "8f0e2f76e22b43e2855189877e7dc1e1e7d98c226c95db247cd1d547928334a9";

/** Hash a plaintext string with SHA-256, returning a lowercase hex string. */
export async function sha256Hex(text: string): Promise<string> {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Return the stored hash, falling back to the default if none is saved yet. */
export function getAdminPwHash(): string {
  try {
    return localStorage.getItem(ADMIN_PW_KEY) ?? DEFAULT_HASH;
  } catch {
    return DEFAULT_HASH;
  }
}

/**
 * The credential to send with privileged Convex mutations.
 * Pass as `adminKey` — the server rejects the call if it doesn't match.
 */
export function getAdminKey(): string {
  return getAdminPwHash();
}

/** Persist a new hashed password to localStorage. */
export function setAdminPwHash(hash: string): void {
  try {
    localStorage.setItem(ADMIN_PW_KEY, hash);
  } catch {}
}

/**
 * Verify a plaintext password attempt against the stored hash.
 * Returns true if it matches.
 */
export async function checkAdminPassword(attempt: string): Promise<boolean> {
  const hash = await sha256Hex(attempt);
  return hash === getAdminPwHash();
}
