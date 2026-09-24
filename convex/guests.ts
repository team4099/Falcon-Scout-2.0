import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query } from "./_generated/server";
import { isCurrentUserAdminEligible, isTeamEmail, requireAdmin } from "./adminAuth";

const MAX_MESSAGE_LENGTH = 500;

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

/** A signed-in non-team user applies for guest access. Idempotent. */
export const requestAccess = mutation({
  args: { message: v.optional(v.string()) },
  handler: async (ctx, { message }) => {
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
 */
export const listRequests = query({
  args: {},
  handler: async (ctx) => {
    if (!(await isCurrentUserAdminEligible(ctx))) return [];
    const rows = await ctx.db.query("guestAccess").collect();
    return rows.sort((a, b) => b.requestedAt - a.requestedAt);
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
