import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

const positionValidator = v.union(
  v.literal("red1"), v.literal("red2"), v.literal("red3"),
  v.literal("blue1"), v.literal("blue2"), v.literal("blue3")
);

// ── Match Assignments ─────────────────────────────────────────────────────────

/** All assignments for an event (admin view) */
export const listMatchAssignments = query({
  args: { eventKey: v.string() },
  handler: async (ctx, { eventKey }) => {
    return await ctx.db
      .query("matchAssignments")
      .withIndex("by_event", (q) => q.eq("eventKey", eventKey))
      .collect();
  },
});

/** Current user's match assignments for an event */
export const getMyMatchAssignments = query({
  args: { eventKey: v.string() },
  handler: async (ctx, { eventKey }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    return await ctx.db
      .query("matchAssignments")
      .withIndex("by_scout_event", (q) => q.eq("scoutId", userId).eq("eventKey", eventKey))
      .collect();
  },
});

/** Upsert a single position slot */
export const setMatchAssignment = mutation({
  args: {
    eventKey: v.string(),
    matchNumber: v.number(),
    matchLabel: v.string(),
    position: positionValidator,
    scoutId: v.id("users"),
  },
  handler: async (ctx, { eventKey, matchNumber, matchLabel, position, scoutId }) => {
    const existing = await ctx.db
      .query("matchAssignments")
      .withIndex("by_event_match", (q) =>
        q.eq("eventKey", eventKey).eq("matchNumber", matchNumber)
      )
      .filter((q) => q.eq(q.field("position"), position))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, { scoutId, matchLabel });
    } else {
      await ctx.db.insert("matchAssignments", {
        eventKey, matchNumber, matchLabel, position, scoutId,
      });
    }
  },
});

/** Clear a single position slot */
export const clearMatchAssignment = mutation({
  args: {
    eventKey: v.string(),
    matchNumber: v.number(),
    position: positionValidator,
  },
  handler: async (ctx, { eventKey, matchNumber, position }) => {
    const existing = await ctx.db
      .query("matchAssignments")
      .withIndex("by_event_match", (q) =>
        q.eq("eventKey", eventKey).eq("matchNumber", matchNumber)
      )
      .filter((q) => q.eq(q.field("position"), position))
      .first();

    if (existing) await ctx.db.delete(existing._id);
  },
});

/**
 * Batch-upsert many assignments in one mutation.
 * Used by the "Apply to range" bulk-assign feature on the admin scheduling page.
 */
export const batchSetMatchAssignments = mutation({
  args: {
    eventKey: v.string(),
    assignments: v.array(v.object({
      matchNumber: v.number(),
      matchLabel: v.string(),
      position: positionValidator,
      scoutId: v.id("users"),
    })),
  },
  handler: async (ctx, { eventKey, assignments }) => {
    for (const { matchNumber, matchLabel, position, scoutId } of assignments) {
      const existing = await ctx.db
        .query("matchAssignments")
        .withIndex("by_event_match", (q) =>
          q.eq("eventKey", eventKey).eq("matchNumber", matchNumber)
        )
        .filter((q) => q.eq(q.field("position"), position))
        .first();

      if (existing) {
        await ctx.db.patch(existing._id, { scoutId, matchLabel });
      } else {
        await ctx.db.insert("matchAssignments", {
          eventKey, matchNumber, matchLabel, position, scoutId,
        });
      }
    }
  },
});

/** Delete every match assignment for an event — used by the "Clear All" button */
export const clearAllMatchAssignments = mutation({
  args: { eventKey: v.string() },
  handler: async (ctx, { eventKey }) => {
    const all = await ctx.db
      .query("matchAssignments")
      .withIndex("by_event", (q) => q.eq("eventKey", eventKey))
      .collect();
    await Promise.all(all.map((a) => ctx.db.delete(a._id)));
  },
});

// ── Pit Rotations ─────────────────────────────────────────────────────────────

/** All pit rotation ranges for an event */
export const listPitRotations = query({
  args: { eventKey: v.string() },
  handler: async (ctx, { eventKey }) => {
    return await ctx.db
      .query("pitRotations")
      .withIndex("by_event", (q) => q.eq("eventKey", eventKey))
      .collect();
  },
});

/** Pit rotations that include the current user */
export const getMyPitRotations = query({
  args: { eventKey: v.string() },
  handler: async (ctx, { eventKey }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const all = await ctx.db
      .query("pitRotations")
      .withIndex("by_event", (q) => q.eq("eventKey", eventKey))
      .collect();
    return all.filter((r) => r.scoutIds.includes(userId));
  },
});

/** Create or update a pit rotation (qual range or elims).
 *
 * For qual rotations (startMatch + endMatch present), any match assignments
 * the newly-assigned scouts have within that match range are automatically
 * deleted to keep the schedule self-consistent.
 */
export const upsertPitRotation = mutation({
  args: {
    id: v.optional(v.id("pitRotations")),
    eventKey: v.string(),
    label: v.optional(v.string()),
    startMatch: v.optional(v.number()),
    endMatch: v.optional(v.number()),
    isElims: v.optional(v.boolean()),
    scoutIds: v.array(v.id("users")),
  },
  handler: async (ctx, { id, eventKey, label, startMatch, endMatch, isElims, scoutIds }) => {
    // ── Determine which scouts are being newly added ───────────────────────────
    let prevScoutIds: string[] = [];
    if (id) {
      const existing = await ctx.db.get(id);
      prevScoutIds = existing?.scoutIds ?? [];
    }
    const prevSet = new Set(prevScoutIds);
    const newlyAdded = scoutIds.filter((sid) => !prevSet.has(sid));

    // ── Save the rotation ──────────────────────────────────────────────────────
    if (id) {
      await ctx.db.patch(id, { label, startMatch, endMatch, isElims, scoutIds });
    } else {
      await ctx.db.insert("pitRotations", { eventKey, label, startMatch, endMatch, isElims, scoutIds });
    }

    // ── Clear conflicting match assignments (qual rotations only) ─────────────
    // Elims rotations don't have a fixed match-number range, so skip them.
    if (!isElims && startMatch != null && endMatch != null && newlyAdded.length > 0) {
      // Fetch all assignments in the event for efficiency (by_event index covers all matches)
      const allAssignments = await ctx.db
        .query("matchAssignments")
        .withIndex("by_event", (q) => q.eq("eventKey", eventKey))
        .collect();

      const newlyAddedSet = new Set(newlyAdded);

      const toDelete = allAssignments.filter(
        (a) =>
          newlyAddedSet.has(a.scoutId) &&
          a.matchNumber >= startMatch &&
          a.matchNumber <= endMatch
      );

      await Promise.all(toDelete.map((a) => ctx.db.delete(a._id)));
    }
  },
});

/** Delete a pit rotation */
export const deletePitRotation = mutation({
  args: { id: v.id("pitRotations") },
  handler: async (ctx, { id }) => {
    await ctx.db.delete(id);
  },
});

// ── Scout Preferences ─────────────────────────────────────────────────────────

/** Current user's preferences for an event (null if never set) */
export const getMyPreferences = query({
  args: { eventKey: v.string() },
  handler: async (ctx, { eventKey }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    return await ctx.db
      .query("scoutPreferences")
      .withIndex("by_scout_event", (q) => q.eq("scoutId", userId).eq("eventKey", eventKey))
      .first();
  },
});

/** Save (create or update) the current user's preferences for an event */
export const upsertMyPreferences = mutation({
  args: {
    eventKey:          v.string(),
    preferredPartners: v.array(v.id("users")),
    wantsMoreMatches:  v.boolean(),
    wantsPitRotation:  v.boolean(),
    wantsPitScouting:  v.optional(v.boolean()),
  },
  handler: async (ctx, { eventKey, preferredPartners, wantsMoreMatches, wantsPitRotation, wantsPitScouting }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const existing = await ctx.db
      .query("scoutPreferences")
      .withIndex("by_scout_event", (q) => q.eq("scoutId", userId).eq("eventKey", eventKey))
      .first();
    const data = { preferredPartners, wantsMoreMatches, wantsPitRotation, wantsPitScouting, updatedAt: Date.now() };
    if (existing) {
      await ctx.db.patch(existing._id, data);
    } else {
      await ctx.db.insert("scoutPreferences", { scoutId: userId, eventKey, ...data });
    }
  },
});

/** All scout preferences for an event — for admin use in ManageScouts */
export const listAllPreferences = query({
  args: { eventKey: v.string() },
  handler: async (ctx, { eventKey }) => {
    return await ctx.db
      .query("scoutPreferences")
      .withIndex("by_event", (q) => q.eq("eventKey", eventKey))
      .collect();
  },
});

// ── Schedule Exclusions ───────────────────────────────────────────────────────

/** Get the permanently excluded scout IDs for an event */
export const getScheduleExclusions = query({
  args: { eventKey: v.string() },
  handler: async (ctx, { eventKey }) => {
    const row = await ctx.db
      .query("scheduleExclusions")
      .withIndex("by_event", (q) => q.eq("eventKey", eventKey))
      .first();
    return row?.excludedScoutIds ?? [];
  },
});

/** Set the excluded scout IDs for an event (admin action — replaces the full list) */
export const setScheduleExclusions = mutation({
  args: {
    eventKey: v.string(),
    excludedScoutIds: v.array(v.id("users")),
  },
  handler: async (ctx, { eventKey, excludedScoutIds }) => {
    const existing = await ctx.db
      .query("scheduleExclusions")
      .withIndex("by_event", (q) => q.eq("eventKey", eventKey))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { excludedScoutIds, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("scheduleExclusions", { eventKey, excludedScoutIds, updatedAt: Date.now() });
    }
  },
});
