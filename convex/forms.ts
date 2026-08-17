import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

// Shared field-type validator (keep in sync with schema.ts)
const fieldTypeValidator = v.union(
  v.literal("text"),
  v.literal("number"),
  v.literal("checkbox"),
  v.literal("select"),
  v.literal("counter"),
  v.literal("textarea"),
  v.literal("teamNumber"),
  v.literal("rating")
);

const formTypeValidator = v.optional(
  v.union(
    v.literal("default"),
    v.literal("super"),
    v.literal("pit"),
    v.literal("checklist")
  )
);

const fieldValidator = v.object({
  id: v.string(),
  type: fieldTypeValidator,
  label: v.string(),
  required: v.boolean(),
  options: v.optional(v.array(v.string())),
  section: v.optional(v.string()),
});

// ──────────────────────────────────────────────
// Form Templates
// ──────────────────────────────────────────────

export const listTemplates = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("formTemplates").collect();
  },
});

export const getTemplate = query({
  args: { id: v.id("formTemplates") },
  handler: async (ctx, { id }) => {
    return await ctx.db.get(id);
  },
});

export const getActiveTemplate = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("formTemplates")
      .filter((q) => q.eq(q.field("isActive"), true))
      .first();
  },
});

export const listActiveTemplates = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("formTemplates")
      .filter((q) => q.eq(q.field("isActive"), true))
      .collect();
  },
});

export const createTemplate = mutation({
  args: {
    name: v.string(),
    description: v.optional(v.string()),
    formType: formTypeValidator,
    fields: v.array(fieldValidator),
    isActive: v.boolean(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("formTemplates", args);
  },
});

export const updateTemplate = mutation({
  args: {
    id: v.id("formTemplates"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    formType: formTypeValidator,
    fields: v.optional(v.array(fieldValidator)),
    isActive: v.optional(v.boolean()),
  },
  handler: async (ctx, { id, ...updates }) => {
    await ctx.db.patch(id, updates);
  },
});

/**
 * Activate a template and deactivate any other template of the same formType.
 * Checklist forms are exempt — any number can be active simultaneously.
 */
export const activateTemplate = mutation({
  args: { id: v.id("formTemplates") },
  handler: async (ctx, { id }) => {
    const template = await ctx.db.get(id);
    if (!template) throw new Error("Template not found");
    const myType = template.formType ?? "default";

    // Checklists: allow multiple to be active — skip deactivating others
    if (myType !== "checklist") {
      // Deactivate all active templates of the same type
      const all = await ctx.db.query("formTemplates").collect();
      for (const t of all) {
        if (t._id !== id && (t.formType ?? "default") === myType && t.isActive) {
          await ctx.db.patch(t._id, { isActive: false });
        }
      }
    }

    await ctx.db.patch(id, { isActive: true });
  },
});

export const deactivateTemplate = mutation({
  args: { id: v.id("formTemplates") },
  handler: async (ctx, { id }) => {
    await ctx.db.patch(id, { isActive: false });
  },
});

export const deleteTemplate = mutation({
  args: { id: v.id("formTemplates") },
  handler: async (ctx, { id }) => {
    await ctx.db.delete(id);
  },
});

// ──────────────────────────────────────────────
// Form Submissions
// ──────────────────────────────────────────────

export const submitForm = mutation({
  args: {
    templateId: v.id("formTemplates"),
    eventKey: v.string(),
    matchNumber: v.number(),
    teamNumber: v.number(),
    data: v.string(),
    offlineId: v.optional(v.string()), // idempotency key — set by offline queue
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);

    // ── Idempotency check ─────────────────────────────────────────────────
    if (args.offlineId) {
      const existing = await ctx.db
        .query("formSubmissions")
        .withIndex("by_offline_id", (q) => q.eq("offlineId", args.offlineId))
        .first();
      if (existing) return existing._id;
    }

    // ── Event team roster validation ──────────────────────────────────────
    // Reject submissions whose team number is not in the cached event roster.
    if (args.teamNumber > 0) {
      const roster = await ctx.db
        .query("eventTeamRosters")
        .withIndex("by_event", (q) => q.eq("eventKey", args.eventKey))
        .first();
      if (roster && !roster.teamNumbers.includes(args.teamNumber)) {
        throw new Error(
          `Team ${args.teamNumber} is not registered at this event. Submission rejected.`
        );
      }
    }

    return await ctx.db.insert("formSubmissions", {
      templateId: args.templateId,
      eventKey: args.eventKey,
      matchNumber: args.matchNumber,
      teamNumber: args.teamNumber,
      data: args.data,
      scoutId: userId ?? undefined,
      syncedAt: Date.now(),
      offlineId: args.offlineId,
    });
  },
});

export const listSubmissions = query({
  args: {
    eventKey: v.string(),
  },
  handler: async (ctx, { eventKey }) => {
    return await ctx.db
      .query("formSubmissions")
      .withIndex("by_event_team", (q) => q.eq("eventKey", eventKey))
      .collect();
  },
});

export const getTeamSubmissions = query({
  args: {
    eventKey: v.string(),
    teamNumber: v.number(),
  },
  handler: async (ctx, { eventKey, teamNumber }) => {
    return await ctx.db
      .query("formSubmissions")
      .withIndex("by_event_team", (q) =>
        q.eq("eventKey", eventKey).eq("teamNumber", teamNumber)
      )
      .collect();
  },
});

export const deleteSubmission = mutation({
  args: { id: v.id("formSubmissions") },
  handler: async (ctx, { id }) => {
    await getAuthUserId(ctx); // must be signed in
    await ctx.db.delete(id);
  },
});

// ──────────────────────────────────────────────
// Event Team Roster (validation cache)
// ──────────────────────────────────────────────

/**
 * Sync the event team roster from the frontend (populated from TBA data).
 * Called whenever the frontend fetches teams for an event so the backend
 * can validate team numbers on form submission.
 */
export const syncEventTeamRoster = mutation({
  args: {
    eventKey: v.string(),
    teamNumbers: v.array(v.number()),
  },
  handler: async (ctx, { eventKey, teamNumbers }) => {
    const existing = await ctx.db
      .query("eventTeamRosters")
      .withIndex("by_event", (q) => q.eq("eventKey", eventKey))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { teamNumbers, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("eventTeamRosters", {
        eventKey,
        teamNumbers,
        updatedAt: Date.now(),
      });
    }
  },
});

/** Query the cached event team roster (used by frontend for validation). */
export const getEventTeamRoster = query({
  args: { eventKey: v.string() },
  handler: async (ctx, { eventKey }) => {
    const roster = await ctx.db
      .query("eventTeamRosters")
      .withIndex("by_event", (q) => q.eq("eventKey", eventKey))
      .first();
    return roster?.teamNumbers ?? null;
  },
});
