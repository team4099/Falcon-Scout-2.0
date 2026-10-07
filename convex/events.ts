import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getApprovedUserId, isSignedIn, isTeamEmail, requireAdmin } from "./adminAuth";

export const getCurrentEvent = query({
  args: {},
  handler: async (ctx) => {
    if (!(await isSignedIn(ctx))) return null;
    return await ctx.db
      .query("eventSettings")
      .withIndex("by_key", (q) => q.eq("key", "current_event"))
      .first();
  },
});

export const setCurrentEvent = mutation({
  args: {
    eventKey: v.string(),
    eventName: v.string(),
    adminKey: v.optional(v.string()),
  },
  handler: async (ctx, { eventKey, eventName, adminKey }) => {
    await requireAdmin(ctx, adminKey);
    const existing = await ctx.db
      .query("eventSettings")
      .withIndex("by_key", (q) => q.eq("key", "current_event"))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { eventKey, eventName, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("eventSettings", {
        key: "current_event",
        eventKey,
        eventName,
        updatedAt: Date.now(),
      });
    }
    // Remember every event that was ever current so people can go back to it.
    // Nothing else happens on a switch: each event's data is keyed by event,
    // and its roster starts empty until an admin adds people.
    const key = `event:${eventKey}`;
    const known = await ctx.db
      .query("eventSettings")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
    if (known) await ctx.db.patch(known._id, { eventName, updatedAt: Date.now() });
    else await ctx.db.insert("eventSettings", { key, eventKey, eventName, updatedAt: Date.now() });
  },
});

/**
 * The events the caller can open, newest first, for the Settings event picker.
 * A guest gets only the events they were added to; a team account gets every
 * event that has been current (and may open any other by typing its key).
 */
export const listEvents = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getApprovedUserId(ctx);
    if (!userId) return null;
    const isGuest = !isTeamEmail((await ctx.db.get(userId))?.email);
    const mine = new Set(
      (await ctx.db
        .query("eventRoster")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect()
      ).map((r) => r.eventKey),
    );
    const rows = (await ctx.db.query("eventSettings").collect()).sort((a, b) => b.updatedAt - a.updatedAt);
    const current = rows.find((r) => r.key === "current_event")?.eventKey ?? null;
    const names = new Map(rows.map((r) => [r.eventKey, r.eventName]));
    const keys = isGuest ? [...mine] : [...new Set([...rows.map((r) => r.eventKey), ...mine])];
    return {
      isGuest,
      events: keys.map((eventKey) => ({
        eventKey,
        eventName: names.get(eventKey) ?? eventKey,
        isCurrent: eventKey === current,
        onRoster: mine.has(eventKey),
      })),
    };
  },
});
