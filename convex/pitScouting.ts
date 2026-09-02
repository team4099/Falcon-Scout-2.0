import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { requireAdmin } from "./adminAuth";

// -- Pit Scouting Assignments -------------------------------------------------
// Maps individual TBA team numbers to the scouts assigned to pit-scout them.

/** All pit scouting assignments for an event (admin view) */
export const listPitScoutingTeams = query({
  args: { eventKey: v.string() },
  handler: async (ctx, { eventKey }) => {
    return await ctx.db
      .query("pitScoutingTeams")
      .withIndex("by_event", (q) => q.eq("eventKey", eventKey))
      .collect();
  },
});

/** All TBA team assignments for the current user at this event */
export const getMyPitScoutingTeam = query({
  args: { eventKey: v.string() },
  handler: async (ctx, { eventKey }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const all = await ctx.db
      .query("pitScoutingTeams")
      .withIndex("by_event", (q) => q.eq("eventKey", eventKey))
      .collect();
    // Return all teams this user is assigned to (may be more than one)
    const mine = all.filter((t) => t.scoutIds.includes(userId));
    return mine.length > 0 ? mine : null;
  },
});

/** Upsert the scout list for a single TBA team number.
 *  If no assignment row exists for that team, creates one.
 *  Passing an empty scoutIds array deletes the row instead. */
export const upsertPitScoutingAssignment = mutation({
  args: {
    eventKey:   v.string(),
    teamNumber: v.number(),
    scoutIds:   v.array(v.id("users")),
    adminKey:   v.optional(v.string()),
  },
  handler: async (ctx, { eventKey, teamNumber, scoutIds, adminKey }) => {
    await requireAdmin(ctx, adminKey);
    const existing = await ctx.db
      .query("pitScoutingTeams")
      .withIndex("by_event_team", (q) =>
        q.eq("eventKey", eventKey).eq("teamNumber", teamNumber)
      )
      .first();

    if (scoutIds.length === 0) {
      // Empty assignment -> delete the row
      if (existing) await ctx.db.delete(existing._id);
      return;
    }

    if (existing) {
      await ctx.db.patch(existing._id, { scoutIds });
    } else {
      await ctx.db.insert("pitScoutingTeams", { eventKey, teamNumber, scoutIds });
    }
  },
});

/** Batch-set assignments for multiple teams at once (used by "assign scout to all" etc.) */
export const batchUpsertPitScoutingAssignments = mutation({
  args: {
    eventKey: v.string(),
    assignments: v.array(v.object({
      teamNumber: v.number(),
      scoutIds:   v.array(v.id("users")),
    })),
    adminKey: v.optional(v.string()),
  },
  handler: async (ctx, { eventKey, assignments, adminKey }) => {
    await requireAdmin(ctx, adminKey);
    for (const { teamNumber, scoutIds } of assignments) {
      const existing = await ctx.db
        .query("pitScoutingTeams")
        .withIndex("by_event_team", (q) =>
          q.eq("eventKey", eventKey).eq("teamNumber", teamNumber)
        )
        .first();

      if (scoutIds.length === 0) {
        if (existing) await ctx.db.delete(existing._id);
      } else if (existing) {
        await ctx.db.patch(existing._id, { scoutIds });
      } else {
        await ctx.db.insert("pitScoutingTeams", { eventKey, teamNumber, scoutIds });
      }
    }
  },
});

/** Clear all pit scouting assignments for an event */
export const clearAllPitScoutingAssignments = mutation({
  args: { eventKey: v.string(), adminKey: v.optional(v.string()) },
  handler: async (ctx, { eventKey, adminKey }) => {
    await requireAdmin(ctx, adminKey);
    const all = await ctx.db
      .query("pitScoutingTeams")
      .withIndex("by_event", (q) => q.eq("eventKey", eventKey))
      .collect();
    await Promise.all(all.map((a) => ctx.db.delete(a._id)));
  },
});
