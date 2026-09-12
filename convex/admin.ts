import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  TEMP_ADMIN_DURATION_MS,
  isAdminEmail,
  isCurrentUserAdminEligible,
  isSignedIn,
  requireAdmin,
  requireInherentAdmin,
} from "./adminAuth";

/**
 * Whether the signed-in caller is currently eligible for admin mode — either
 * an inherent admin or holding an active temporary grant.
 *
 * The Settings page uses this to decide whether "Enable" is even allowed —
 * the actual privileged mutations re-check this independently on the server,
 * so this query is purely informational (but it's what gates the toggle, so
 * a non-eligible caller can't turn admin mode on at all).
 */
export const isCurrentUserAdmin = query({
  args: {},
  handler: async (ctx) => isCurrentUserAdminEligible(ctx),
});

/** Whether the signed-in caller is one of the two hard-coded team leads (not a temporary grant). */
export const isCurrentUserInherentAdmin = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    return isAdminEmail(identity?.email);
  },
});

/**
 * Every user's admin status, for the Manage Scouts "Assign Admin" UI.
 * Only inherent admins can see this — it's who currently holds elevated
 * access, so it's restricted the same way granting it is.
 */
export const listAdminStatuses = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!isAdminEmail(identity?.email)) return [];

    const now = Date.now();
    const [users, grants] = await Promise.all([
      ctx.db.query("users").collect(),
      ctx.db.query("temporaryAdminGrants").collect(),
    ]);
    const grantByUser = new Map(grants.map((g) => [g.userId, g]));

    return users.map((u) => {
      const grant = grantByUser.get(u._id);
      return {
        userId: u._id,
        isInherentAdmin: isAdminEmail(u.email),
        tempAdminExpiresAt: grant && grant.expiresAt > now ? grant.expiresAt : null,
      };
    });
  },
});

/**
 * Grant a user temporary admin for 12 hours. Inherent-admin only — a
 * temporary admin cannot call this, so they can never bootstrap another one.
 * Re-granting an existing active grant simply extends it another 12 hours.
 */
export const grantTemporaryAdmin = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const granterId = await requireInherentAdmin(ctx);
    if (userId === granterId) {
      throw new Error("You already have admin access.");
    }
    const target = await ctx.db.get(userId);
    if (target && isAdminEmail(target.email)) {
      throw new Error("This account is already a designated team lead.");
    }

    const expiresAt = Date.now() + TEMP_ADMIN_DURATION_MS;
    const existing = await ctx.db
      .query("temporaryAdminGrants")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { expiresAt, grantedBy: granterId });
    } else {
      await ctx.db.insert("temporaryAdminGrants", { userId, grantedBy: granterId, expiresAt });
    }
    return { expiresAt };
  },
});

/** Revoke a user's temporary admin grant early. Inherent-admin only. */
export const revokeTemporaryAdmin = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    await requireInherentAdmin(ctx);
    const existing = await ctx.db
      .query("temporaryAdminGrants")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (existing) await ctx.db.delete(existing._id);
  },
});

/**
 * IDs of every user currently tagged as drive team. Used to exclude them from
 * match-scouting auto-generation and place them on every auto-generated pit
 * rotation (see src/lib/scheduleGenerator.ts).
 */
export const listDriveTeamIds = query({
  args: {},
  handler: async (ctx) => {
    if (!(await isSignedIn(ctx))) return [];
    const rows = await ctx.db.query("driveTeamMembers").collect();
    return rows.map((r) => r.userId);
  },
});

/** Tag or untag a user as drive team. Admin-only (any admin, not just inherent). */
export const setDriveTeamMember = mutation({
  args: { userId: v.id("users"), isDriveTeam: v.boolean() },
  handler: async (ctx, { userId, isDriveTeam }) => {
    await requireAdmin(ctx);
    const existing = await ctx.db
      .query("driveTeamMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (isDriveTeam) {
      if (!existing) await ctx.db.insert("driveTeamMembers", { userId });
    } else {
      if (existing) await ctx.db.delete(existing._id);
    }
  },
});
