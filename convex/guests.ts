import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query } from "./_generated/server";
import { isCurrentUserAdminEligible, isTeamEmail, requireAdmin } from "./adminAuth";
import { currentRosterIds } from "./roster";

const MAX_MESSAGE_LENGTH = 500;
const MAX_TEAM_NUMBER = 99999;

/** FRC team numbers are positive integers; reject anything else. */
function checkTeamNumber(teamNumber: number) {
  if (!Number.isInteger(teamNumber) || teamNumber < 1 || teamNumber > MAX_TEAM_NUMBER) {
    throw new Error("Enter a valid FRC team number.");
  }
  return teamNumber;
}

/**
 * The caller's access state, for the client gate in App.tsx. Deliberately
 * uses the raw getAuthUserId — pending guests are signed in but not approved,
 * and they need to be able to ask "what's my status?".
 *
 *   team     — @team4099.com, full access
 *   approved — guest an admin approved, full access
 *   pending  — applied, waiting on an admin
 *   denied   — an admin declined
 *   none     — signed in as a non-team account that hasn't applied yet
 */
export const myAccess = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const user = await ctx.db.get(userId);
    const email = user?.email?.trim().toLowerCase();
    if (!email) return { status: "none" as const };
    if (isTeamEmail(email)) return { status: "team" as const };
    const row = await ctx.db
      .query("guestAccess")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();
    return { status: row?.status ?? ("none" as const) };
  },
});

/**
 * A signed-in non-team user applies for guest access. Idempotent.
 * `teamNumber` is optional in the validator only so a cached older client can
 * still apply; the current UI always sends it.
 */
export const requestAccess = mutation({
  args: { message: v.optional(v.string()), teamNumber: v.optional(v.number()) },
  handler: async (ctx, { message, teamNumber }) => {
    if (teamNumber !== undefined) checkTeamNumber(teamNumber);
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("You must be signed in to do that.");
    const user = await ctx.db.get(userId);
    const email = user?.email?.trim().toLowerCase();
    if (!email) throw new Error("Your account has no email address.");
    if (isTeamEmail(email)) throw new Error("Team accounts don't need to apply.");

    const existing = await ctx.db
      .query("guestAccess")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();
    // Re-applying never overrides an admin's decision.
    if (existing) return existing.status;

    await ctx.db.insert("guestAccess", {
      email,
      name: user?.name,
      message: message?.trim().slice(0, MAX_MESSAGE_LENGTH) || undefined,
      teamNumber,
      status: "pending",
      requestedAt: Date.now(),
    });
    return "pending" as const;
  },
});

/**
 * Every guest application, newest first. Admin-eligible callers only — the
 * list contains applicants' emails. Returns [] rather than throwing so an
 * offline-cached UI degrades quietly (same convention as listAdminStatuses).
 *
 * Each row carries the guest's `userId` (for Add to event / Deactivate) and
 * `onRoster` for the current event. Deactivated guests are left out entirely
 * so old guests stop cluttering the panel; they reappear if they sign back in.
 */
export const listRequests = query({
  args: {},
  handler: async (ctx) => {
    if (!(await isCurrentUserAdminEligible(ctx))) return [];
    const [rows, deactivated, roster] = await Promise.all([
      ctx.db.query("guestAccess").collect(),
      ctx.db.query("deactivatedUsers").collect(),
      currentRosterIds(ctx),
    ]);
    const hidden = new Set(deactivated.map((d) => d.userId));
    const withUsers = await Promise.all(
      rows.map(async (r) => {
        const user = await ctx.db
          .query("users")
          .withIndex("email", (q) => q.eq("email", r.email))
          .first();
        return { ...r, userId: user?._id ?? null, onRoster: !!user && roster.has(user._id) };
      }),
    );
    return withUsers
      .filter((r) => !(r.userId && hidden.has(r.userId)))
      .sort((a, b) => b.requestedAt - a.requestedAt);
  },
});

/**
 * Number of guests waiting on an admin, for the red dot on the Manage Scouts
 * nav item. 0 for anyone not admin-eligible. Deactivated applicants don't
 * count — they're hidden from the panel, so a dot for them couldn't be cleared.
 */
export const pendingCount = query({
  args: {},
  handler: async (ctx) => {
    if (!(await isCurrentUserAdminEligible(ctx))) return 0;
    const pending = await ctx.db
      .query("guestAccess")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .collect();
    const deactivated = new Set((await ctx.db.query("deactivatedUsers").collect()).map((d) => d.userId));
    let count = 0;
    for (const r of pending) {
      const user = await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", r.email))
        .first();
      if (!user || !deactivated.has(user._id)) count++;
    }
    return count;
  },
});

/** Approve, deny or revoke a guest. Takes effect on their very next call. */
export const decideRequest = mutation({
  args: {
    id: v.id("guestAccess"),
    decision: v.union(v.literal("approved"), v.literal("denied")),
  },
  handler: async (ctx, { id, decision }) => {
    const adminId = await requireAdmin(ctx);
    const row = await ctx.db.get(id);
    if (!row) throw new Error("That request no longer exists.");
    await ctx.db.patch(id, { status: decision, decidedAt: Date.now(), decidedBy: adminId });
  },
});

/** Set or clear (null) the FRC team a guest is from. Admin-only. */
export const setTeamNumber = mutation({
  args: { id: v.id("guestAccess"), teamNumber: v.union(v.number(), v.null()) },
  handler: async (ctx, { id, teamNumber }) => {
    await requireAdmin(ctx);
    const row = await ctx.db.get(id);
    if (!row) throw new Error("That request no longer exists.");
    await ctx.db.patch(id, {
      teamNumber: teamNumber === null ? undefined : checkTeamNumber(teamNumber),
    });
  },
});
