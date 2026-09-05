// ── Server-side admin enforcement ─────────────────────────────────────────────
//
// FalconScout uses a single shared admin password that the team knows, rather
// than per-user roles. Previously that password was checked only in the browser
// (src/lib/adminAuth.ts) and the Convex mutations behind it had no check at all,
// so anyone could call them directly.
//
// The client stores the SHA-256 hash of the password and sends that hash as
// `adminKey` on every privileged mutation. The server compares it against the
// hash held in the `adminConfig` table. The plaintext password is never sent and
// never stored.
//
// Bootstrapping: the adminConfig row is created on first use from the
// ADMIN_PASSWORD_HASH environment variable, falling back to the hash of
// "passw0rd" so an un-configured deployment behaves as it did before. Set
// ADMIN_PASSWORD_HASH in the Convex dashboard to choose your own.

import { getAuthUserId } from "@convex-dev/auth/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";

/** SHA-256 of "passw0rd" — the historical default. */
const FALLBACK_HASH =
  "8f0e2f76e22b43e2855189877e7dc1e1e7d98c226c95db247cd1d547928334a9";

function configuredHash(): string {
  return (process.env.ADMIN_PASSWORD_HASH ?? "").trim().toLowerCase() || FALLBACK_HASH;
}

/** Length-independent constant-time-ish comparison of two hex strings. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Read the current admin hash, seeding the row from env on first use. */
export async function getAdminHash(ctx: MutationCtx): Promise<string> {
  const row = await ctx.db.query("adminConfig").first();
  if (row) return row.passwordHash;
  const seeded = configuredHash();
  await ctx.db.insert("adminConfig", { passwordHash: seeded, updatedAt: Date.now() });
  return seeded;
}

/** Read-only variant for queries — cannot seed, so falls back to env. */
export async function peekAdminHash(ctx: QueryCtx): Promise<string> {
  const row = await ctx.db.query("adminConfig").first();
  return row?.passwordHash ?? configuredHash();
}

/**
 * True when the admin credential is still the shipped default ("passw0rd").
 *
 * The default exists so an un-configured deployment keeps working, but it is
 * public knowledge — it was hardcoded in the client for the whole life of the
 * app. Anything relying on this must surface it loudly rather than let a
 * deployment sit on it unnoticed.
 */
export async function isUsingDefaultAdminPassword(ctx: QueryCtx): Promise<boolean> {
  return safeEqual(await peekAdminHash(ctx), FALLBACK_HASH);
}

/**
 * Require that the caller is signed in. Returns the user id.
 * Use on anything that writes data but is not admin-only (scouts submitting
 * forms, syncing their own queue, moving picklist cards).
 */
export async function requireUser(ctx: QueryCtx | MutationCtx) {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("You must be signed in to do that.");
  return userId;
}

/**
 * Require that the caller is signed in AND presented the correct admin key.
 * Use on destructive or team-wide operations.
 */
export async function requireAdmin(ctx: MutationCtx, adminKey: string | undefined) {
  const userId = await requireUser(ctx);
  const expected = await getAdminHash(ctx);
  if (!adminKey || !safeEqual(adminKey.trim().toLowerCase(), expected)) {
    throw new Error(
      "Admin access required. Enable Admin Mode in Settings with the team password."
    );
  }
  return userId;
}

/**
 * Non-throwing sign-in check for read queries.
 *
 * Reads are gated by returning nothing rather than by throwing: convex/react
 * surfaces a query error during render, and App.tsx deliberately renders the
 * app from cache while auth is unresolved (the offline escape hatches), so a
 * throwing query there would replace a working offline session with a crash.
 * An empty result degrades into the cached value instead.
 */
export async function isSignedIn(ctx: QueryCtx): Promise<boolean> {
  return (await getAuthUserId(ctx)) !== null;
}
