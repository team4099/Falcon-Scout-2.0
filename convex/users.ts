import { query, mutation } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { requireAdmin, requireUser } from "./adminAuth";

export const viewer = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    return await ctx.db.get(userId);
  },
});

export const getUser = query({
  args: { id: v.id("users") },
  handler: async (ctx, { id }) => {
    await requireUser(ctx);
    return await ctx.db.get(id);
  },
});

/**
 * All users, minus anyone an admin has soft-deleted (see
 * convex/admin.ts's deactivateUser). This is the single pool every
 * scout-picking process (Manage Scouts, scheduling, pit assignment, ...)
 * draws from, so filtering here is what makes deactivation apply everywhere.
 */
export const listUsers = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    const [users, deactivated] = await Promise.all([
      ctx.db.query("users").collect(),
      ctx.db.query("deactivatedUsers").collect(),
    ]);
    if (deactivated.length === 0) return users;
    const deactivatedSet = new Set(deactivated.map((d) => d.userId));
    return users.filter((u) => !deactivatedSet.has(u._id));
  },
});

/** Rename a user. Admin-only. */
export const setUserName = mutation({
  args: { userId: v.id("users"), name: v.string() },
  handler: async (ctx, { userId, name }) => {
    await requireAdmin(ctx);
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Name can't be empty.");
    await ctx.db.patch(userId, { name: trimmed });
  },
});

/**
 * Admin-only: pre-add a scout by email so they show up in Manage Scouts,
 * scheduling, and pit assignment before they've ever signed in. Google
 * sign-in is restricted to @team4099.com (see convex/auth.ts), so only those
 * addresses are accepted here.
 *
 * Stamping `emailVerificationTime` matters, not just cosmetically: Convex
 * Auth's default account-linking (see uniqueUserWithVerifiedEmail in
 * @convex-dev/auth) only merges a new Google sign-in into an *existing* user
 * row when that row's email is marked verified. Without this, the real
 * sign-in would create a second, disconnected user instead of claiming this
 * placeholder.
 */
export const addScoutByEmail = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    await requireAdmin(ctx);
    const normalized = email.trim().toLowerCase();
    if (!normalized.endsWith("@team4099.com")) {
      throw new Error("Only team4099.com emails can be added.");
    }
    const existing = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", normalized))
      .first();
    if (existing) throw new Error("A scout with that email already exists.");
    const name = normalized.slice(0, normalized.indexOf("@"));
    return await ctx.db.insert("users", {
      email: normalized,
      name,
      emailVerificationTime: Date.now(),
    });
  },
});

/**
 * Called once per session by the client right after a successful sign-in
 * (see App.tsx). Clears a soft-delete so a deactivated user who signs back
 * in is immediately restored everywhere, per the "until they sign in again"
 * rule — a no-op for everyone else.
 */
export const reactivateSelf = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const existing = await ctx.db
      .query("deactivatedUsers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (existing) await ctx.db.delete(existing._id);
  },
});

/** Returns the current user's synced settings (null if not logged in). */
export const getUserSettings = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    return (
      (await ctx.db
        .query("userSettings")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .unique()) ?? null
    );
  },
});

/** Upserts the TBA API key for the current user. Pass an empty string to clear it. */
export const setTbaApiKey = mutation({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const existing = await ctx.db
      .query("userSettings")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    const tbaApiKey = key.trim() || undefined;
    if (existing) {
      await ctx.db.patch(existing._id, { tbaApiKey });
    } else {
      await ctx.db.insert("userSettings", { userId, tbaApiKey });
    }
  },
});
