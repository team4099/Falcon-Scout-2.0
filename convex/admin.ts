import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  MAX_TEMP_ADMIN_HOURS,
  MIN_TEMP_ADMIN_HOURS,
  TEMP_ADMIN_DURATION_MS,
  approvedGuestEmails,
  hasAccess,
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
    const [allUsers, grants, labels, approved] = await Promise.all([
      ctx.db.query("users").collect(),
      ctx.db.query("temporaryAdminGrants").collect(),
      ctx.db.query("adminLabels").collect(),
      approvedGuestEmails(ctx),
    ]);
    const users = allUsers.filter((u) => hasAccess(u, approved));
    const grantByUser = new Map(grants.map((g) => [g.userId, g]));
    const labelByUser = new Map(labels.map((l) => [l.userId, l.label]));

    return users.map((u) => {
      const grant = grantByUser.get(u._id);
      return {
        userId: u._id,
        isInherentAdmin: isAdminEmail(u.email),
        tempAdminExpiresAt: grant && grant.expiresAt > now ? grant.expiresAt : null,
        label: labelByUser.get(u._id) ?? null,
      };
    });
  },
});

/**
 * Set (or clear, with an empty string) the admin-status label shown in
 * Manage Scouts for a user — overrides the default "Permanent team lead"/
 * "Temporary Admin" wording. Admin-only.
 */
export const setAdminLabel = mutation({
  args: { userId: v.id("users"), label: v.string() },
  handler: async (ctx, { userId, label }) => {
    await requireAdmin(ctx);
    const trimmed = label.trim();
    const existing = await ctx.db
      .query("adminLabels")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (!trimmed) {
      if (existing) await ctx.db.delete(existing._id);
      return;
    }
    if (existing) {
      await ctx.db.patch(existing._id, { label: trimmed });
    } else {
      await ctx.db.insert("adminLabels", { userId, label: trimmed });
    }
  },
});

/**
 * Grant a user temporary admin for a caller-chosen number of hours (default
 * 12 if omitted, clamped to [MIN_TEMP_ADMIN_HOURS, MAX_TEMP_ADMIN_HOURS]).
 * Inherent-admin only — a temporary admin cannot call this, so they can
 * never bootstrap another one. Re-granting an existing active grant simply
 * replaces its expiry with a fresh one starting now.
 */
export const grantTemporaryAdmin = mutation({
  args: { userId: v.id("users"), hours: v.optional(v.number()) },
  handler: async (ctx, { userId, hours }) => {
    const granterId = await requireInherentAdmin(ctx);
    if (userId === granterId) {
      throw new Error("You already have admin access.");
    }
    const target = await ctx.db.get(userId);
    if (target && isAdminEmail(target.email)) {
      throw new Error("This account is already a designated team lead.");
    }

    const durationMs =
      hours === undefined || !Number.isFinite(hours)
        ? TEMP_ADMIN_DURATION_MS
        : Math.min(MAX_TEMP_ADMIN_HOURS, Math.max(MIN_TEMP_ADMIN_HOURS, hours)) * 60 * 60 * 1000;
    const expiresAt = Date.now() + durationMs;
    const existing = await ctx.db
      .query("temporaryAdminGrants")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { expiresAt, grantedBy: granterId });
    } else {
      await ctx.db.insert("temporaryAdminGrants", { userId, grantedBy: granterId, expiresAt });
      // Seed a default status label on a fresh grant only — renewing an
      // active grant shouldn't clobber a label the admin already customized.
      const existingLabel = await ctx.db
        .query("adminLabels")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .first();
      if (!existingLabel) await ctx.db.insert("adminLabels", { userId, label: "Temporary Admin" });
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

/**
 * Full user docs for every currently-deactivated (soft-deleted) user, for
 * the "Deactivated" restore list in Manage Scouts. Deactivated users are
 * filtered out of users.listUsers, so this is the only place their name is
 * still resolvable while they're hidden.
 */
export const listDeactivatedUsers = query({
  args: {},
  handler: async (ctx) => {
    if (!(await isCurrentUserAdminEligible(ctx))) return [];
    const rows = await ctx.db.query("deactivatedUsers").collect();
    const users = await Promise.all(rows.map((r) => ctx.db.get(r.userId)));
    return rows.map((r, i) => ({
      userId: r.userId,
      deactivatedAt: r.deactivatedAt,
      user: users[i],
    }));
  },
});

/**
 * Soft-delete a user: hides them from Manage Scouts and every scout pool
 * (schedule generation, pit assignment, ...) without touching their account
 * or past submissions. Automatically reversed the next time they sign back
 * in (see users.reactivateSelf). Can't be used on an inherent admin.
 */
export const deactivateUser = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const callerId = await requireAdmin(ctx);
    if (userId === callerId) throw new Error("You can't deactivate your own account.");
    const target = await ctx.db.get(userId);
    if (target && isAdminEmail(target.email)) {
      throw new Error("This account is a designated team lead and can't be deactivated.");
    }
    const existing = await ctx.db
      .query("deactivatedUsers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (!existing) {
      await ctx.db.insert("deactivatedUsers", { userId, deactivatedAt: Date.now(), deactivatedBy: callerId });
    }
  },
});

/** Manually restore a deactivated user before they sign back in themselves. */
export const reactivateUser = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    await requireAdmin(ctx);
    const existing = await ctx.db
      .query("deactivatedUsers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (existing) await ctx.db.delete(existing._id);
  },
});
