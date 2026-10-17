import { query, mutation, internalMutation } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import {
  getApprovedUserId,
  hasAccess,
  nameFromEmail,
  requireAdmin,
  requireUser,
} from "./adminAuth";
import { currentRosterIds } from "./roster";

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
 * All users with access, minus anyone an admin has soft-deleted (see
 * convex/admin.ts's deactivateUser), so deactivation applies everywhere.
 * Each is stamped `onRoster` for the current event (convex/roster.ts):
 * scout-picking (scheduling, Manage Scouts' roster, partner picker) filters
 * on it, while name lookups use the whole list. Cached clients from before
 * the roster ignore the flag and keep seeing everyone.
 */
export const listUsers = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    const [allUsers, deactivated, guests, roster, nicknames] = await Promise.all([
      ctx.db.query("users").collect(),
      ctx.db.query("deactivatedUsers").collect(),
      ctx.db
        .query("guestAccess")
        .withIndex("by_status", (q) => q.eq("status", "approved"))
        .collect(),
      currentRosterIds(ctx),
      ctx.db.query("scoutNicknames").collect(),
    ]);
    const guestTeam = new Map(guests.map((g) => [g.email, g.teamNumber]));
    const approved = new Set(guestTeam.keys());
    const deactivatedSet = new Set(deactivated.map((d) => d.userId));
    const nicknameOf = new Map(nicknames.map((n) => [n.userId, n.nickname]));
    // Pending/denied guests have a user row (they signed in) but no access,
    // so they must not show up as schedulable scouts. Approved guests carry
    // their FRC team (guestTeamNumber) so the UI can tag them. `nickname` is
    // only present when an admin set one (see setScoutNickname).
    return allUsers
      .filter((u) => hasAccess(u, approved) && !deactivatedSet.has(u._id))
      .map((u) => {
        const email = u.email?.trim().toLowerCase();
        const onRoster = roster.has(u._id);
        const nickname = nicknameOf.get(u._id);
        const base = { ...u, onRoster, ...(nickname !== undefined && { nickname }) };
        if (!email || !guestTeam.has(email)) return base;
        const team = guestTeam.get(email);
        return team === undefined ? { ...base, isGuest: true } : { ...base, isGuest: true, guestTeamNumber: team };
      });
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

/** Longest nickname accepted; it has to fit a scheduling grid cell on a phone. */
const NICKNAME_MAX_LENGTH = 24;

/**
 * Give a scout a short label that replaces their name everywhere the app
 * shows them (see listUsers). Empty clears it. Admin-only, like renaming.
 */
export const setScoutNickname = mutation({
  args: { userId: v.id("users"), nickname: v.string() },
  handler: async (ctx, { userId, nickname }) => {
    await requireAdmin(ctx);
    if (!(await ctx.db.get(userId))) throw new Error("That scout doesn't exist.");
    const trimmed = nickname.trim();
    if (trimmed.length > NICKNAME_MAX_LENGTH) {
      throw new Error(`Nickname must be ${NICKNAME_MAX_LENGTH} characters or fewer.`);
    }
    const existing = await ctx.db
      .query("scoutNicknames")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const row of existing) await ctx.db.delete(row._id);
    if (trimmed) await ctx.db.insert("scoutNicknames", { userId, nickname: trimmed });
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
    return await ctx.db.insert("users", {
      email: normalized,
      name: nameFromEmail(normalized),
      emailVerificationTime: Date.now(),
    });
  },
});

/**
 * Called once per session by the client right after a successful sign-in
 * (see App.tsx). Clears a soft-delete so a deactivated user who signs back
 * in is immediately restored everywhere, per the "until they sign in again"
 * rule — a no-op for everyone else. Deliberately not requireUser: a
 * deactivated pending/denied guest signing back in should reappear in the
 * admin's guest panel too. It only ever touches the caller's own row.
 */
export const reactivateSelf = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return;
    const existing = await ctx.db
      .query("deactivatedUsers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (existing) await ctx.db.delete(existing._id);
  },
});

/**
 * Returns the current user's synced settings (null if not logged in).
 *
 * Never includes `tbaApiKey`: the TBA key is a server secret now (see
 * convex/tba.ts), and rows written by older builds may still hold one.
 */
export const getUserSettings = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getApprovedUserId(ctx);
    if (!userId) return null;
    const row = await ctx.db
      .query("userSettings")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (!row) return null;
    const { tbaApiKey: _omit, ...safe } = row;
    return safe;
  },
});

/**
 * Retired: the TBA key is no longer user-supplied. Kept as a no-op so a cached
 * client that still calls it at an event doesn't throw. It stores nothing.
 */
export const setTbaApiKey = mutation({
  args: { key: v.string() },
  handler: async (ctx) => {
    await requireUser(ctx);
  },
});

/**
 * One-off cleanup: erase every per-user TBA key still sitting in userSettings.
 * Internal, so it can't be called from a client — run it from the Convex
 * dashboard (Functions → users:scrubStoredTbaKeys → Run) on each deployment.
 */
export const scrubStoredTbaKeys = internalMutation({
  args: {},
  handler: async (ctx) => {
    let scrubbed = 0;
    for (const row of await ctx.db.query("userSettings").collect()) {
      if (row.tbaApiKey !== undefined) {
        await ctx.db.patch(row._id, { tbaApiKey: undefined });
        scrubbed++;
      }
    }
    return scrubbed;
  },
});
