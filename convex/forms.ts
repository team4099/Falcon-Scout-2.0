import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { isSignedIn, requireAdmin, requireUser } from "./adminAuth";
import { awardCoins, DEFAULT_SCOUT_REWARD } from "./betting";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

/**
 * Has this scout already logged this exact match+team at this event?
 *
 * `exclude` is the row just inserted, which is skipped so a submission never
 * counts itself. compLevel is part of the identity: qual 5 and elim 5 are
 * different matches, and an undefined compLevel (rows predating the column)
 * only matches another undefined one.
 */
async function alreadyScouted(
  ctx: MutationCtx,
  scoutId: Id<"users">,
  args: { eventKey: string; matchNumber: number; teamNumber: number; compLevel?: "qm" | "elim" },
  exclude: Id<"formSubmissions">,
): Promise<boolean> {
  const prior = await ctx.db
    .query("formSubmissions")
    .withIndex("by_scout_event_match", (q) =>
      q.eq("scoutId", scoutId).eq("eventKey", args.eventKey).eq("matchNumber", args.matchNumber)
    )
    .collect();
  return prior.some(
    (r) =>
      r._id !== exclude &&
      r.teamNumber === args.teamNumber &&
      r.compLevel === args.compLevel
  );
}

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
    if (!(await isSignedIn(ctx))) return [];
    return await ctx.db.query("formTemplates").collect();
  },
});

export const getTemplate = query({
  args: { id: v.id("formTemplates") },
  handler: async (ctx, { id }) => {
    if (!(await isSignedIn(ctx))) return null;
    return await ctx.db.get(id);
  },
});

export const getActiveTemplate = query({
  args: {},
  handler: async (ctx) => {
    if (!(await isSignedIn(ctx))) return null;
    return await ctx.db
      .query("formTemplates")
      .filter((q) => q.eq(q.field("isActive"), true))
      .first();
  },
});

export const listActiveTemplates = query({
  args: {},
  handler: async (ctx) => {
    if (!(await isSignedIn(ctx))) return [];
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
    coinReward: v.optional(v.number()),
    isActive: v.boolean(),
    adminKey: v.optional(v.string()),
  },
  handler: async (ctx, { adminKey, ...args }) => {
    await requireAdmin(ctx, adminKey);
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
    coinReward: v.optional(v.number()),
    isActive: v.optional(v.boolean()),
    adminKey: v.optional(v.string()),
  },
  handler: async (ctx, { id, adminKey, ...updates }) => {
    await requireAdmin(ctx, adminKey);
    await ctx.db.patch(id, updates);
  },
});

/**
 * Activate a template and deactivate any other template of the same formType.
 * Checklist forms are exempt — any number can be active simultaneously.
 */
export const activateTemplate = mutation({
  args: { id: v.id("formTemplates"), adminKey: v.optional(v.string()) },
  handler: async (ctx, { id, adminKey }) => {
    await requireAdmin(ctx, adminKey);
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
  args: { id: v.id("formTemplates"), adminKey: v.optional(v.string()) },
  handler: async (ctx, { id, adminKey }) => {
    await requireAdmin(ctx, adminKey);
    await ctx.db.patch(id, { isActive: false });
  },
});

export const deleteTemplate = mutation({
  args: { id: v.id("formTemplates"), adminKey: v.optional(v.string()) },
  handler: async (ctx, { id, adminKey }) => {
    await requireAdmin(ctx, adminKey);
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
    compLevel: v.optional(v.union(v.literal("qm"), v.literal("elim"))),
    teamNumber: v.number(),
    data: v.string(),
    offlineId: v.optional(v.string()), // idempotency key — set by offline queue
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);

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

    const submissionId = await ctx.db.insert("formSubmissions", {
      templateId: args.templateId,
      eventKey: args.eventKey,
      matchNumber: args.matchNumber,
      compLevel: args.compLevel,
      teamNumber: args.teamNumber,
      data: args.data,
      scoutId: userId ?? undefined,
      syncedAt: Date.now(),
      offlineId: args.offlineId,
    });

    // ── Scouting payout ───────────────────────────────────────────────────
    // Scouting is meant to be the primary way to earn coins, so an accepted
    // submission pays out — but only the scout's FIRST one for a given match
    // and team. The offlineId check above only guards replays of a queued
    // submission; nothing stopped a scout re-submitting the same match from
    // the form over and over, which paid the reward every time.
    //
    // Re-submitting is still allowed (it is how a scout corrects a mistake,
    // and two scouts covering the same team is normal and should pay both) —
    // it just doesn't pay twice.
    if (userId && !(await alreadyScouted(ctx, userId, args, submissionId))) {
      const template = await ctx.db.get(args.templateId);
      const reward = template?.coinReward ?? DEFAULT_SCOUT_REWARD;
      if (reward > 0) {
        await awardCoins(ctx, userId, args.eventKey, reward);
      }
    }

    return submissionId;
  },
});

export const listSubmissions = query({
  args: {
    eventKey: v.string(),
  },
  handler: async (ctx, { eventKey }) => {
    if (!(await isSignedIn(ctx))) return [];
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
    if (!(await isSignedIn(ctx))) return [];
    return await ctx.db
      .query("formSubmissions")
      .withIndex("by_event_team", (q) =>
        q.eq("eventKey", eventKey).eq("teamNumber", teamNumber)
      )
      .collect();
  },
});

export const deleteSubmission = mutation({
  args: { id: v.id("formSubmissions"), adminKey: v.optional(v.string()) },
  handler: async (ctx, { id, adminKey }) => {
    await requireAdmin(ctx, adminKey);
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
    // Every scout's device calls this in the background, so this is
    // signed-in-only rather than admin-only.
    await requireUser(ctx);
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
    if (!(await isSignedIn(ctx))) return null;
    const roster = await ctx.db
      .query("eventTeamRosters")
      .withIndex("by_event", (q) => q.eq("eventKey", eventKey))
      .first();
    return roster?.teamNumbers ?? null;
  },
});

// ──────────────────────────────────────────────
// One-off migration
// ──────────────────────────────────────────────

/**
 * Backfill `compLevel` on rows written before the column existed.
 *
 * The value is recovered from `data._matchPrefix`, which the online submit path
 * has always embedded in the JSON blob. Rows that synced through the offline
 * queue never stored it (that inconsistency is fixed in ScoutMatchPage), so
 * those are left undefined rather than guessed — an unknown comp level is
 * honest, a wrong one silently corrupts averages.
 *
 * Safe to run repeatedly: rows that already have compLevel are skipped.
 * Returns a tally so you can see how much was recoverable.
 */
export const backfillCompLevel = mutation({
  args: { adminKey: v.optional(v.string()) },
  handler: async (ctx, { adminKey }) => {
    await requireAdmin(ctx, adminKey);

    const all = await ctx.db.query("formSubmissions").collect();
    let updated = 0;
    let unrecoverable = 0;
    let alreadySet = 0;

    for (const row of all) {
      if (row.compLevel) { alreadySet++; continue; }

      let prefix: unknown;
      try {
        prefix = (JSON.parse(row.data) as Record<string, unknown>)._matchPrefix;
      } catch {
        prefix = undefined;
      }

      if (prefix === "qm" || prefix === "elim") {
        await ctx.db.patch(row._id, { compLevel: prefix });
        updated++;
      } else {
        unrecoverable++;
      }
    }

    return { total: all.length, updated, alreadySet, unrecoverable };
  },
});
