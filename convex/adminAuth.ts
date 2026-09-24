// ── Server-side admin enforcement ─────────────────────────────────────────────
//
// FalconScout previously gated privileged mutations behind a single shared
// password known to the whole team. That meant anyone who knew (or guessed,
// since the default shipped in the client source) the password could act as
// admin. Admin access is now tied to identity instead, two ways:
//
//   1. Inherent admins — the two emails in ADMIN_EMAILS below. Permanent,
//      hard-coded, and the only accounts that can grant #2.
//   2. Temporary admins — any user an inherent admin has granted a 12-hour
//      grant to (temporaryAdminGrants table). They pass requireAdmin like an
//      inherent admin, but cannot call requireInherentAdmin, so they cannot
//      grant admin to anyone else.
//
// "Admin Mode" in Settings is a client-side toggle, but it can only be turned
// on by an account that is actually eligible (see isCurrentUserAdminEligible)
// — every privileged mutation re-checks the caller's identity here on the
// server regardless of what the client sends, so the toggle alone grants
// nothing even if that check were ever bypassed.

import { getAuthUserId } from "@convex-dev/auth/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

/**
 * The only accounts that may exercise permanent admin privileges, including
 * granting/revoking temporary admin. Google sign-in is restricted to
 * @team4099.com already (see convex/auth.ts); this narrows it further to two
 * people.
 */
const ADMIN_EMAILS = new Set(["czhao@team4099.com", "yabdulkadir@team4099.com"]);

/**
 * The email stamped on the "Dev login (Admin)" anonymous account in
 * convex/auth.ts, so devs can exercise admin-only screens on localhost
 * without a real @team4099.com Google account. Only counts as an admin when
 * ALLOW_DEV_LOGIN is set, which per convex/auth.ts should only ever be true
 * on a local `convex dev` deployment — never on the production deployment
 * Vercel talks to — so this grants nothing on a real deployment even if the
 * email somehow ended up there.
 */
const DEV_ADMIN_EMAIL = "devadmin@team4099.com";

/** Default/fallback duration for a temporary admin grant, in ms. */
export const TEMP_ADMIN_DURATION_MS = 12 * 60 * 60 * 1000;

/** Bounds on how many hours an inherent admin can grant in one go. */
export const MIN_TEMP_ADMIN_HOURS = 1;
export const MAX_TEMP_ADMIN_HOURS = 720; // 30 days

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  if (ADMIN_EMAILS.has(normalized)) return true;
  return normalized === DEV_ADMIN_EMAIL && process.env.ALLOW_DEV_LOGIN === "true";
}

/** Whether `userId` currently holds an unexpired temporary admin grant. */
export async function hasActiveTemporaryGrant(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<boolean> {
  const grant = await ctx.db
    .query("temporaryAdminGrants")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  return !!grant && grant.expiresAt > Date.now();
}

export const TEAM_EMAIL_DOMAIN = "@team4099.com";

export function isTeamEmail(email: string | null | undefined): boolean {
  return !!email && email.trim().toLowerCase().endsWith(TEAM_EMAIL_DOMAIN);
}

/**
 * Whether the signed-in caller may touch team data: any @team4099.com account,
 * or a guest an admin has approved (guestAccess table). Reads the email from
 * the signed JWT claim (see authCustomClaims in convex/auth.ts), falling back
 * to the user row for a token minted before that claim existed.
 */
async function isCallerApproved(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  const identity = await ctx.auth.getUserIdentity();
  let email = identity?.email;
  if (!email) email = (await ctx.db.get(userId))?.email;
  if (!email) return false;
  if (isTeamEmail(email)) return true;
  const normalized = email.trim().toLowerCase();
  const row = await ctx.db
    .query("guestAccess")
    .withIndex("by_email", (q) => q.eq("email", normalized))
    .first();
  return row?.status === "approved";
}

/**
 * Like getAuthUserId, but null unless the caller is approved (team member or
 * approved guest). Use instead of getAuthUserId in any function that reads or
 * writes team data, so a pending guest can't slip past requireUser.
 */
export async function getApprovedUserId(ctx: QueryCtx | MutationCtx) {
  const userId = await getAuthUserId(ctx);
  if (!userId) return null;
  return (await isCallerApproved(ctx, userId)) ? userId : null;
}

/**
 * Require that the caller is signed in and approved. Returns the user id.
 * Use on anything that writes data but is not admin-only (scouts submitting
 * forms, syncing their own queue, moving picklist cards).
 */
export async function requireUser(ctx: QueryCtx | MutationCtx) {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("You must be signed in to do that.");
  if (!(await isCallerApproved(ctx, userId))) {
    throw new Error("Your guest access hasn't been approved yet.");
  }
  return userId;
}

/** Emails of approved guests, for filtering user lists down to people with access. */
export async function approvedGuestEmails(ctx: QueryCtx | MutationCtx): Promise<Set<string>> {
  const rows = await ctx.db
    .query("guestAccess")
    .withIndex("by_status", (q) => q.eq("status", "approved"))
    .collect();
  return new Set(rows.map((r) => r.email));
}

/** Whether `user` has team-data access (team email or approved guest). */
export function hasAccess(user: { email?: string }, approved: Set<string>): boolean {
  return isTeamEmail(user.email) || (!!user.email && approved.has(user.email.trim().toLowerCase()));
}

/**
 * Require that the caller is signed in AND is either an inherent admin or
 * currently holds an active temporary admin grant. Use on destructive or
 * team-wide operations.
 *
 * The second parameter is accepted-but-ignored for backward compatibility
 * with call sites and clients still sending the retired `adminKey` field.
 */
export async function requireAdmin(ctx: MutationCtx, _adminKey?: string) {
  const userId = await requireUser(ctx);
  const identity = await ctx.auth.getUserIdentity();
  if (isAdminEmail(identity?.email)) return userId;
  if (await hasActiveTemporaryGrant(ctx, userId)) return userId;
  throw new Error(
    "Admin access required. Admin mode is restricted to designated team leads."
  );
}

/**
 * Require that the caller is an inherent admin — not merely a temporary
 * grant holder. Use on anything that manages admin access itself (granting
 * or revoking temporary admin), so a temporary admin can never bootstrap
 * another one.
 */
export async function requireInherentAdmin(ctx: MutationCtx) {
  const userId = await requireUser(ctx);
  const identity = await ctx.auth.getUserIdentity();
  if (!isAdminEmail(identity?.email)) {
    throw new Error("Only designated team leads can do that.");
  }
  return userId;
}

/** Whether the signed-in caller is currently eligible for admin mode (inherent or temporary). */
export async function isCurrentUserAdminEligible(ctx: QueryCtx): Promise<boolean> {
  const identity = await ctx.auth.getUserIdentity();
  if (isAdminEmail(identity?.email)) return true;
  const userId = await getAuthUserId(ctx);
  if (!userId) return false;
  return hasActiveTemporaryGrant(ctx, userId);
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
  return (await getApprovedUserId(ctx)) !== null;
}
