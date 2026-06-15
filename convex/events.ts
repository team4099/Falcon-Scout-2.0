import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const getCurrentEvent = query({
  args: {},
  handler: async (ctx) => {
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
  },
  handler: async (ctx, { eventKey, eventName }) => {
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
  },
});
