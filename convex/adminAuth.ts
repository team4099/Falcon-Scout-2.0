// ── Server-side admin enforcement ─────────────────────────────────────────────
//
// FalconScout previously gated privileged mutations behind a single shared
// password known to the whole team. That meant anyone who knew (or guessed,
// since the default shipped in the client source) the password could act as
// admin. Admin access is now tied to the caller's signed-in Google identity
// instead: only the emails in ADMIN_EMAILS below can pass requireAdmin, no
// matter what the client sends.
//
// "Admin Mode" in Settings is still just a client-side UI toggle — anyone can
// flip it to preview the admin UI — but every privileged mutation re-checks
// the caller's email here on the server, so the toggle alone grants nothing.

import { getAuthUserId } from "@convex-dev/auth/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";

/**
 * The only accounts that may exercise real admin privileges.
 * Google sign-in is restricted to @team4099.com already (see convex/auth.ts);
 * this narrows it further to two people.
 */
const ADMIN_EMAILS = new Set(["czhao@team4099.com", "yabdulkadir@team4099.com"]);

export function isAdminEmail(email: string | null | undefined): boolean {
  return !!email && ADMIN_EMAILS.has(email.trim().toLowerCase());
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
 * Require that the caller is signed in AND their account email is on the
 * admin allowlist. Use on destructive or team-wide operations.
 *
 * The second parameter is accepted-but-ignored for backward compatibility
 * with call sites and clients still sending the retired `adminKey` field.
 */
export async function requireAdmin(ctx: MutationCtx, _adminKey?: string) {
  const userId = await requireUser(ctx);
  const identity = await ctx.auth.getUserIdentity();
  if (!isAdminEmail(identity?.email)) {
    throw new Error(
      "Admin access required. Admin mode is restricted to designated team leads."
    );
  }
  return userId;
}

/** Whether the signed-in caller's email is on the admin allowlist. */
export async function isCurrentUserAdminEligible(ctx: QueryCtx): Promise<boolean> {
  const identity = await ctx.auth.getUserIdentity();
  return isAdminEmail(identity?.email);
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
