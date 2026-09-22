import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { isSignedIn, requireAdmin } from "./adminAuth";
import { awardCoins, revokeCoins, PIT_DUTY_REWARD } from "./betting";

const positionValidator = v.union(
  v.literal("red1"), v.literal("red2"), v.literal("red3"),
  v.literal("blue1"), v.literal("blue2"), v.literal("blue3")
);

/** Upper bound on a manually-entered qual count. The largest FRC events run
 *  well under this; the cap exists so a typo can't spawn a 100k-row grid. */
const MAX_PLANNED_QUALS = 400;

// ── Match Plan ────────────────────────────────────────────────────────────────
// TBA usually publishes the qual schedule only hours before the event starts,
// which used to leave the scheduling grid empty and un-assignable until then.
// An admin can instead enter the qual match count up front and assign against
// plain match numbers; once TBA publishes, the real matches take over the grid
// and the already-saved assignments resolve against them by match number.

/** The admin-entered qual match count for an event (null if never set). */
export const getMatchPlan = query({
  args: { eventKey: v.string() },
  handler: async (ctx, { eventKey }) => {
    if (!(await isSignedIn(ctx))) return null;
    return await ctx.db
      .query("eventMatchPlans")
      .withIndex("by_event", (q) => q.eq("eventKey", eventKey))
      .first();
  },
});

/** Set the qual match count for an event. Passing 0 clears the plan. */
export const setMatchPlan = mutation({
  args: {
    eventKey: v.string(),
    qualMatchCount: v.number(),
    adminKey: v.optional(v.string()),
  },
  handler: async (ctx, { eventKey, qualMatchCount, adminKey }) => {
    await requireAdmin(ctx, adminKey);
    if (!Number.isInteger(qualMatchCount) || qualMatchCount < 0 || qualMatchCount > MAX_PLANNED_QUALS) {
      throw new Error(`Match count must be a whole number between 0 and ${MAX_PLANNED_QUALS}`);
    }
    const existing = await ctx.db
      .query("eventMatchPlans")
      .withIndex("by_event", (q) => q.eq("eventKey", eventKey))
      .first();

    // 0 means "no plan" — drop the row rather than storing a count that would
    // render an empty grid indistinguishable from a real zero-match event.
    if (qualMatchCount === 0) {
      if (existing) await ctx.db.delete(existing._id);
      return;
    }

    if (existing) {
      await ctx.db.patch(existing._id, { qualMatchCount, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("eventMatchPlans", { eventKey, qualMatchCount, updatedAt: Date.now() });
    }
  },
});

/** Delete every assignment for an event above `maxMatchNumber`.
 *
 *  Used when TBA publishes a schedule shorter than the planned count: those
 *  assignments reference matches that will never exist, so the grid can no
 *  longer show them and they'd otherwise be stranded in the table forever.
 *  Admin-triggered, never automatic — they represent real planning work.
 */
export const clearMatchAssignmentsAbove = mutation({
  args: {
    eventKey: v.string(),
    maxMatchNumber: v.number(),
    adminKey: v.optional(v.string()),
  },
  handler: async (ctx, { eventKey, maxMatchNumber, adminKey }) => {
    await requireAdmin(ctx, adminKey);
    const all = await ctx.db
      .query("matchAssignments")
      .withIndex("by_event", (q) => q.eq("eventKey", eventKey))
      .collect();
    const orphans = all.filter((a) => a.matchNumber > maxMatchNumber);
    await Promise.all(orphans.map((a) => ctx.db.delete(a._id)));
    return orphans.length;
  },
});

// ── Match Assignments ─────────────────────────────────────────────────────────

/** All assignments for an event (admin view) */
export const listMatchAssignments = query({
  args: { eventKey: v.string() },
  handler: async (ctx, { eventKey }) => {
    if (!(await isSignedIn(ctx))) return [];
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
    adminKey: v.optional(v.string()),
  },
  handler: async (ctx, { eventKey, matchNumber, matchLabel, position, scoutId, adminKey }) => {
    await requireAdmin(ctx, adminKey);
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
    adminKey: v.optional(v.string()),
  },
  handler: async (ctx, { eventKey, matchNumber, position, adminKey }) => {
    await requireAdmin(ctx, adminKey);
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
    adminKey: v.optional(v.string()),
  },
  handler: async (ctx, { eventKey, assignments, adminKey }) => {
    await requireAdmin(ctx, adminKey);
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

/**
 * Batch-clear many position slots in one mutation.
 * Used to unassign an entire scouting cycle (block of matches) at once.
 */
export const batchClearMatchAssignments = mutation({
  args: {
    eventKey: v.string(),
    slots: v.array(v.object({
      matchNumber: v.number(),
      position: positionValidator,
    })),
    adminKey: v.optional(v.string()),
  },
  handler: async (ctx, { eventKey, slots, adminKey }) => {
    await requireAdmin(ctx, adminKey);
    for (const { matchNumber, position } of slots) {
      const existing = await ctx.db
        .query("matchAssignments")
        .withIndex("by_event_match", (q) =>
          q.eq("eventKey", eventKey).eq("matchNumber", matchNumber)
        )
        .filter((q) => q.eq(q.field("position"), position))
        .first();

      if (existing) await ctx.db.delete(existing._id);
    }
  },
});

/** Delete every match assignment for an event — used by the "Clear All" button */
export const clearAllMatchAssignments = mutation({
  args: { eventKey: v.string(), adminKey: v.optional(v.string()) },
  handler: async (ctx, { eventKey, adminKey }) => {
    await requireAdmin(ctx, adminKey);
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
    if (!(await isSignedIn(ctx))) return [];
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
    adminKey: v.optional(v.string()),
  },
  handler: async (ctx, { id, eventKey, label, startMatch, endMatch, isElims, scoutIds, adminKey }) => {
    await requireAdmin(ctx, adminKey);
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
  args: { id: v.id("pitRotations"), adminKey: v.optional(v.string()) },
  handler: async (ctx, { id, adminKey }) => {
    await requireAdmin(ctx, adminKey);
    await ctx.db.delete(id);
  },
});

// ── Scout Preferences ─────────────────────────────────────────────────────────

/** Current user's preferences for an event (null if never set) */
// ── Pit duty check-ins ────────────────────────────────────────────────────────

/** The signed-in scout's pit-duty check-ins at an event. */
export const getMyPitDutyCheckIns = query({
  args: { eventKey: v.string() },
  handler: async (ctx, { eventKey }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const rows = await ctx.db
      .query("pitDutyCheckIns")
      .withIndex("by_scout_event", (q) => q.eq("scoutId", userId).eq("eventKey", eventKey))
      .collect();
    return rows.map((r) => ({ rotationId: r.rotationId, reportedAt: r.reportedAt }));
  },
});

/** Report for a pit-duty shift. Idempotent — reporting twice keeps the first
 *  timestamp rather than inserting a second row.
 *
 *  A scout may only check in to a rotation they are actually rostered on, and
 *  the roster is read from the rotation row here rather than trusted from the
 *  client. Hiding the button is not a gate.
 */
export const reportPitDuty = mutation({
  args: { eventKey: v.string(), rotationId: v.id("pitRotations") },
  handler: async (ctx, { eventKey, rotationId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const rotation = await ctx.db.get(rotationId);
    if (!rotation || rotation.eventKey !== eventKey) {
      throw new Error("Pit rotation not found at this event");
    }
    if (!rotation.scoutIds.includes(userId)) {
      throw new Error("You are not assigned to this pit rotation");
    }

    const existing = await ctx.db
      .query("pitDutyCheckIns")
      .withIndex("by_scout_rotation", (q) => q.eq("scoutId", userId).eq("rotationId", rotationId))
      .first();
    if (existing) return existing._id;

    const id = await ctx.db.insert("pitDutyCheckIns", {
      scoutId: userId, eventKey, rotationId, reportedAt: Date.now(),
    });
    // Pit duty produces no form submission, so this is its own payout —
    // paid once per rotation since a repeat report short-circuits above.
    await awardCoins(
      ctx, userId, eventKey, PIT_DUTY_REWARD, "pit_duty_reward",
      "Pit duty", rotationId,
    );
    return id;
  },
});

/** Undo a check-in — a mis-tap on a phone mid-event has to be recoverable.
 *  Only ever deletes the caller's own row. */
export const unreportPitDuty = mutation({
  args: { rotationId: v.id("pitRotations") },
  handler: async (ctx, { rotationId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const existing = await ctx.db
      .query("pitDutyCheckIns")
      .withIndex("by_scout_rotation", (q) => q.eq("scoutId", userId).eq("rotationId", rotationId))
      .first();
    if (existing) {
      await ctx.db.delete(existing._id);
      // Reverse the reportPitDuty payout — otherwise report→undo→report
      // repeated farms unlimited coins.
      await revokeCoins(
        ctx, userId, existing.eventKey, PIT_DUTY_REWARD, "pit_duty_revoked",
        "Pit duty undone", rotationId,
      );
    }
  },
});

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
    if (!(await isSignedIn(ctx))) return [];
    return await ctx.db
      .query("scoutPreferences")
      .withIndex("by_event", (q) => q.eq("eventKey", eventKey))
      .collect();
  },
});

/**
 * Admin override: set (create or replace) another scout's preferences for an
 * event. Used in Manage Scouts so admins can correct/bias preferences when
 * too many scouts pick the same option or a job is short-staffed.
 */
export const adminSetPreferences = mutation({
  args: {
    scoutId:           v.id("users"),
    eventKey:          v.string(),
    preferredPartners: v.array(v.id("users")),
    wantsMoreMatches:  v.boolean(),
    wantsPitRotation:  v.boolean(),
    wantsPitScouting:  v.boolean(),
  },
  handler: async (ctx, { scoutId, eventKey, preferredPartners, wantsMoreMatches, wantsPitRotation, wantsPitScouting }) => {
    await requireAdmin(ctx);
    const existing = await ctx.db
      .query("scoutPreferences")
      .withIndex("by_scout_event", (q) => q.eq("scoutId", scoutId).eq("eventKey", eventKey))
      .first();
    const data = { preferredPartners, wantsMoreMatches, wantsPitRotation, wantsPitScouting, updatedAt: Date.now() };
    if (existing) {
      await ctx.db.patch(existing._id, data);
    } else {
      await ctx.db.insert("scoutPreferences", { scoutId, eventKey, ...data });
    }
  },
});

// ── Schedule Exclusions ───────────────────────────────────────────────────────

/** Get the permanently excluded scout IDs for an event */
export const getScheduleExclusions = query({
  args: { eventKey: v.string() },
  handler: async (ctx, { eventKey }) => {
    if (!(await isSignedIn(ctx))) return null;
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
    adminKey: v.optional(v.string()),
  },
  handler: async (ctx, { eventKey, excludedScoutIds, adminKey }) => {
    await requireAdmin(ctx, adminKey);
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
