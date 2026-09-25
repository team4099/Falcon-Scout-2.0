// ── Event roster ──────────────────────────────────────────────────────────────
//
// Who is attending the current event. Signing in no longer makes someone a
// schedulable scout: an admin adds them here (from the "Not on roster" pool,
// the guest panel, or by email before they've ever signed in). Scheduling and
// the Manage Scouts "Event Roster" only draw from these rows; users.listUsers
// stamps each user with `onRoster` so name lookups elsewhere still see
// everyone.
//
// Rosters are per event key, so switching the current event starts a fresh
// (empty) roster and the previous event's stays intact.

import { v } from "convex/values";
import { mutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { approvedGuestEmails, hasAccess, isTeamEmail, requireAdmin } from "./adminAuth";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function currentEventKey(ctx: QueryCtx | MutationCtx): Promise<string | null> {
  const row = await ctx.db
    .query("eventSettings")
    .withIndex("by_key", (q) => q.eq("key", "current_event"))
    .first();
  return row?.eventKey || null;
}

async function requireCurrentEvent(ctx: MutationCtx) {
  const eventKey = await currentEventKey(ctx);
  if (!eventKey) throw new Error("Set a current event in Settings first.");
  return eventKey;
}

export async function rosterRow(ctx: QueryCtx | MutationCtx, eventKey: string, userId: Id<"users">) {
  return ctx.db
    .query("eventRoster")
    .withIndex("by_event_user", (q) => q.eq("eventKey", eventKey).eq("userId", userId))
    .first();
}

/** User ids on the current event's roster (empty when no event is set). */
export async function currentRosterIds(ctx: QueryCtx | MutationCtx): Promise<Set<Id<"users">>> {
  const eventKey = await currentEventKey(ctx);
  if (!eventKey) return new Set();
  const rows = await ctx.db
    .query("eventRoster")
    .withIndex("by_event", (q) => q.eq("eventKey", eventKey))
    .collect();
  return new Set(rows.map((r) => r.userId));
}

/**
 * Add existing users to the current event's roster. Idempotent. Each user
 * must already have access (team email or approved guest) — a pending guest
 * has to be approved first so the roster never holds someone locked out.
 */
export const addToRoster = mutation({
  args: { userIds: v.array(v.id("users")) },
  handler: async (ctx, { userIds }) => {
    const adminId = await requireAdmin(ctx);
    const eventKey = await requireCurrentEvent(ctx);
    const approved = await approvedGuestEmails(ctx);
    let added = 0;
    for (const userId of new Set(userIds)) {
      const user = await ctx.db.get(userId);
      if (!user) throw new Error("That user no longer exists.");
      if (!hasAccess(user, approved)) {
        throw new Error(`${user.name ?? user.email ?? "That guest"} needs guest access approved first.`);
      }
      if (await rosterRow(ctx, eventKey, userId)) continue;
      await ctx.db.insert("eventRoster", { eventKey, userId, addedAt: Date.now(), addedBy: adminId });
      added++;
    }
    return added;
  },
});

/**
 * Add someone to the current event by email, whether or not they've signed
 * in. Creates a placeholder user row if needed (stamped verified so their
 * first Google sign-in links into it — see users.addScoutByEmail). A
 * non-team email is a guest: an admin typing it in counts as approving them.
 * Also undoes a deactivation, since the admin is explicitly asking for them.
 */
export const addToRosterByEmail = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const adminId = await requireAdmin(ctx);
    const eventKey = await requireCurrentEvent(ctx);
    const normalized = email.trim().toLowerCase();
    if (!EMAIL_RE.test(normalized)) throw new Error("Enter a valid email address.");

    const existing = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", normalized))
      .first();
    const name = existing?.name ?? normalized.slice(0, normalized.indexOf("@"));
    const userId =
      existing?._id ??
      (await ctx.db.insert("users", { email: normalized, name, emailVerificationTime: Date.now() }));

    if (!isTeamEmail(normalized)) {
      const guest = await ctx.db
        .query("guestAccess")
        .withIndex("by_email", (q) => q.eq("email", normalized))
        .first();
      const decided = { status: "approved" as const, decidedAt: Date.now(), decidedBy: adminId };
      if (!guest) {
        await ctx.db.insert("guestAccess", { email: normalized, name, requestedAt: Date.now(), ...decided });
      } else if (guest.status !== "approved") {
        await ctx.db.patch(guest._id, decided);
      }
    }

    const deactivated = await ctx.db
      .query("deactivatedUsers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (deactivated) await ctx.db.delete(deactivated._id);

    if (await rosterRow(ctx, eventKey, userId)) throw new Error("They're already on the roster.");
    await ctx.db.insert("eventRoster", { eventKey, userId, addedAt: Date.now(), addedBy: adminId });
    return userId;
  },
});

/** Take someone off the current event's roster. They stay in "Not on roster". */
export const removeFromRoster = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    await requireAdmin(ctx);
    const eventKey = await requireCurrentEvent(ctx);
    const row = await rosterRow(ctx, eventKey, userId);
    if (row) await ctx.db.delete(row._id);
  },
});
