import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { isSignedIn, requireUser } from "./adminAuth";

// ──────────────────────────────────────────────
// Checklist Templates
// ──────────────────────────────────────────────

/** All active checklist-type form templates */
export const listActiveChecklistTemplates = query({
  args: {},
  handler: async (ctx) => {
    if (!(await isSignedIn(ctx))) return [];
    return await ctx.db
      .query("formTemplates")
      .filter((q) =>
        q.and(
          q.eq(q.field("isActive"), true),
          q.eq(q.field("formType"), "checklist")
        )
      )
      .collect();
  },
});

// ──────────────────────────────────────────────
// Checklist Submissions
// ──────────────────────────────────────────────

/** Submit a completed checklist — idempotent via offlineId */
export const submitChecklist = mutation({
  args: {
    templateId: v.id("formTemplates"),
    eventKey: v.string(),
    matchNumber: v.number(),
    assignedScoutId: v.id("users"),
    data: v.string(),
    offlineId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // This was the one write mutation with no auth check: getAuthUserId was
    // read but never enforced, so an anonymous caller could insert checklist
    // rows with completedById left blank.
    const userId = await requireUser(ctx);

    // Idempotency check
    if (args.offlineId) {
      const existing = await ctx.db
        .query("checklistSubmissions")
        .withIndex("by_offline_id", (q) => q.eq("offlineId", args.offlineId))
        .first();
      if (existing) return existing._id;
    }

    return await ctx.db.insert("checklistSubmissions", {
      templateId: args.templateId,
      eventKey: args.eventKey,
      matchNumber: args.matchNumber,
      assignedScoutId: args.assignedScoutId,
      completedById: userId,
      data: args.data,
      completedAt: Date.now(),
      offlineId: args.offlineId,
    });
  },
});

/** All checklist submissions for the current user's event */
export const getMyChecklistSubmissions = query({
  args: { eventKey: v.string() },
  handler: async (ctx, { eventKey }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    return await ctx.db
      .query("checklistSubmissions")
      .withIndex("by_assigned_event", (q) =>
        q.eq("assignedScoutId", userId).eq("eventKey", eventKey)
      )
      .collect();
  },
});

/** All checklist submissions for an event (admin view) */
export const listAllChecklistSubmissions = query({
  args: { eventKey: v.string() },
  handler: async (ctx, { eventKey }) => {
    if (!(await isSignedIn(ctx))) return [];
    return await ctx.db
      .query("checklistSubmissions")
      .withIndex("by_event_match", (q) => q.eq("eventKey", eventKey))
      .collect();
  },
});

/** Checklist submissions for a specific match */
export const getChecklistSubmissionsForMatch = query({
  args: { eventKey: v.string(), matchNumber: v.number() },
  handler: async (ctx, { eventKey, matchNumber }) => {
    if (!(await isSignedIn(ctx))) return [];
    return await ctx.db
      .query("checklistSubmissions")
      .withIndex("by_event_match", (q) =>
        q.eq("eventKey", eventKey).eq("matchNumber", matchNumber)
      )
      .collect();
  },
});
