import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { canViewEvent, eventViewerId, isSignedIn, requireAdmin, requireEventAccess, requireUser } from "./adminAuth";
import { awardCoins, revokeCoins, DEFAULT_SCOUT_REWARD } from "./betting";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

/**
 * Was this scout actually assigned the work this submission represents?
 *
 * Coins are meant to reward assigned scouting, not any submission a signed-in
 * user happens to send — a scout with nothing to do could otherwise farm
 * coins by resubmitting matches/teams no one asked them to cover.
 *
 *  - "default" (match scouting): the scout must hold a position on
 *    `matchAssignments` for this match. Positions aren't team-specific here
 *    (the server has no TBA schedule to resolve red1/blue2/etc into a team
 *    number), so this checks "assigned to this match", not "assigned this
 *    exact team" — still enough to block scouting matches nobody rostered
 *    them for.
 *  - "pit": the scout must be on this team's `pitScoutingTeams` roster.
 *  - Everything else (note scout, spying, unknown): never pays. Only match and
 *    pit scouting are rewarded; pit duty has its own payout on check-in.
 */
async function isAssignedForReward(
  ctx: MutationCtx,
  scoutId: Id<"users">,
  formType: string,
  args: { eventKey: string; matchNumber: number; teamNumber: number },
): Promise<boolean> {
  switch (formType) {
    case "default": {
      const assignment = await ctx.db
        .query("matchAssignments")
        .withIndex("by_event_match", (q) =>
          q.eq("eventKey", args.eventKey).eq("matchNumber", args.matchNumber)
        )
        .filter((q) => q.eq(q.field("scoutId"), scoutId))
        .first();
      return assignment !== null;
    }
    case "pit": {
      const team = await ctx.db
        .query("pitScoutingTeams")
        .withIndex("by_event_team", (q) =>
          q.eq("eventKey", args.eventKey).eq("teamNumber", args.teamNumber)
        )
        .first();
      return team?.scoutIds.includes(scoutId) ?? false;
    }
    default:
      return false;
  }
}

/**
 * Has this scout already submitted a match-scouting form for this match?
 *
 * Match assignments are one robot per scout per match, but the server can't
 * resolve a position to a team number, so "assigned to this match" is the
 * finest check available. Without a per-match cap a scout could submit all six
 * teams of an assigned match and be paid six times.
 */
async function alreadyScoutedMatch(
  ctx: MutationCtx,
  scoutId: Id<"users">,
  args: { eventKey: string; matchNumber: number; compLevel?: "qm" | "elim" },
  exclude: Id<"formSubmissions">,
): Promise<boolean> {
  const prior = await ctx.db
    .query("formSubmissions")
    .withIndex("by_scout_event_match", (q) =>
      q.eq("scoutId", scoutId).eq("eventKey", args.eventKey).eq("matchNumber", args.matchNumber)
    )
    .collect();
  for (const r of prior) {
    if (r._id === exclude || (r.compLevel ?? "qm") !== "qm") continue;
    const t = await ctx.db.get(r.templateId);
    if ((t?.formType ?? "default") === "default") return true;
  }
  // A form an admin deleted still counts — the scout was already paid for it.
  const tombstones = await ctx.db
    .query("submissionTombstones")
    .withIndex("by_scout_event", (q) => q.eq("scoutId", scoutId).eq("eventKey", args.eventKey))
    .collect();
  return tombstones.some(
    (r) => r.formType === "default" && r.matchNumber === args.matchNumber && (r.compLevel ?? "qm") === "qm"
  );
}

/**
 * The reward for a form of this type right now: the ACTIVE template's, not the
 * submitted one's. templateId comes from the client, so trusting its own
 * coinReward would let a scout submit against an old or draft template that
 * happens to pay more.
 */
async function currentReward(ctx: MutationCtx, template: Doc<"formTemplates"> | null): Promise<number> {
  const formType = template?.formType ?? "default";
  const active = (await ctx.db
    .query("formTemplates")
    .filter((q) => q.eq(q.field("isActive"), true))
    .collect()
  ).find((t) => (t.formType ?? "default") === formType);
  return (active ?? template)?.coinReward ?? DEFAULT_SCOUT_REWARD;
}

/**
 * Undo the payout of a submission its own scout is deleting.
 *
 * If another of their forms still covers the same match (or pit team), the
 * payout moves to that one instead — the work is still done. Otherwise every
 * scout it paid (a pit form pays the whole roster) is clawed back by what the
 * ledger says is outstanding, so delete → resubmit nets to zero.
 */
async function reverseReward(ctx: MutationCtx, sub: Doc<"formSubmissions">): Promise<void> {
  const txns = (await ctx.db
    .query("coinTransactions")
    .withIndex("by_related", (q) => q.eq("relatedId", sub._id))
    .collect()
  ).filter((t) => t.type === "scouting_reward" || t.type === "scouting_revoked");
  if (txns.length === 0) return;

  const formType = (await ctx.db.get(sub.templateId))?.formType ?? "default";
  const paid = new Set<string>(txns.map((t) => t.userId));
  const others = formType === "pit"
    ? await ctx.db
        .query("formSubmissions")
        .withIndex("by_event_team", (q) => q.eq("eventKey", sub.eventKey).eq("teamNumber", sub.teamNumber))
        .collect()
    : await ctx.db
        .query("formSubmissions")
        .withIndex("by_scout_event_match", (q) =>
          q.eq("scoutId", sub.scoutId).eq("eventKey", sub.eventKey).eq("matchNumber", sub.matchNumber)
        )
        .collect();
  for (const r of others) {
    if (r._id === sub._id || !r.scoutId || !paid.has(r.scoutId)) continue;
    if (formType !== "pit" && (r.compLevel ?? "qm") !== "qm") continue;
    if (((await ctx.db.get(r.templateId))?.formType ?? "default") !== formType) continue;
    for (const t of txns) await ctx.db.patch(t._id, { relatedId: r._id });
    return;
  }

  const owed = new Map<Id<"users">, number>();
  for (const t of txns) owed.set(t.userId, (owed.get(t.userId) ?? 0) + t.amount);
  for (const [userId, amount] of owed) {
    await revokeCoins(ctx, userId, sub.eventKey, amount, "scouting_revoked", "Scouting form deleted", sub._id);
  }
}

// Shared field-type validator (keep in sync with schema.ts)
const fieldTypeValidator = v.union(
  v.literal("text"),
  v.literal("number"),
  v.literal("checkbox"),
  v.literal("select"),
  v.literal("radio"),
  v.literal("counter"),
  v.literal("textarea"),
  v.literal("teamNumber"),
  v.literal("rating"),
  v.literal("photo")
);

const formTypeValidator = v.optional(
  v.union(
    v.literal("default"),
    v.literal("super"),
    v.literal("pit"),
    v.literal("spy")
  )
);

const fieldValidator = v.object({
  id: v.string(),
  type: fieldTypeValidator,
  label: v.string(),
  required: v.boolean(),
  options: v.optional(v.array(v.string())),
  section: v.optional(v.string()),
  showInRankings: v.optional(v.boolean()),
});

// ──────────────────────────────────────────────
// Form Templates
// ──────────────────────────────────────────────

/** Legacy "checklist" templates are dead rows — never surface them. */
function isLiveTemplate(t: { formType?: string }): boolean {
  return t.formType !== "checklist";
}

/**
 * One-shot cleanup for the removed checklist form type: deletes every
 * "checklist" template, the submissions made against them, and the deprecated
 * checklistSubmissions table. Run from the Convex dashboard (Functions →
 * forms:purgeLegacyChecklists) once per deployment. Idempotent.
 */
export const purgeLegacyChecklists = internalMutation({
  args: {},
  handler: async (ctx) => {
    let templates = 0, submissions = 0, legacyRows = 0;
    for (const t of await ctx.db.query("formTemplates").collect()) {
      if (t.formType !== "checklist") continue;
      const subs = await ctx.db
        .query("formSubmissions")
        .filter((q) => q.eq(q.field("templateId"), t._id))
        .collect();
      for (const s of subs) await ctx.db.delete(s._id);
      submissions += subs.length;
      await ctx.db.delete(t._id);
      templates++;
    }
    for (const r of await ctx.db.query("checklistSubmissions").collect()) {
      await ctx.db.delete(r._id);
      legacyRows++;
    }
    return { templates, submissions, legacyRows };
  },
});

export const listTemplates = query({
  args: {},
  handler: async (ctx) => {
    if (!(await isSignedIn(ctx))) return [];
    return (await ctx.db.query("formTemplates").collect()).filter(isLiveTemplate);
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
    return (
      (
        await ctx.db
          .query("formTemplates")
          .filter((q) => q.eq(q.field("isActive"), true))
          .collect()
      ).find(isLiveTemplate) ?? null
    );
  },
});

export const listActiveTemplates = query({
  args: {},
  handler: async (ctx) => {
    if (!(await isSignedIn(ctx))) return [];
    return (
      await ctx.db
        .query("formTemplates")
        .filter((q) => q.eq(q.field("isActive"), true))
        .collect()
    ).filter(isLiveTemplate);
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
  handler: async (ctx, { id, adminKey, description, ...updates }) => {
    await requireAdmin(ctx, adminKey);
    // The client can't send `undefined` (it's stripped in transit), so a
    // cleared description arrives as "" — map it to undefined, which makes
    // patch remove the field. Omitted entirely = leave it alone.
    await ctx.db.patch(id, description === undefined
      ? updates
      : { ...updates, description: description.trim() || undefined });
  },
});

/** Activate a template and deactivate any other template of the same formType. */
export const activateTemplate = mutation({
  args: { id: v.id("formTemplates"), adminKey: v.optional(v.string()) },
  handler: async (ctx, { id, adminKey }) => {
    await requireAdmin(ctx, adminKey);
    const template = await ctx.db.get(id);
    if (!template) throw new Error("Template not found");
    const myType = template.formType ?? "default";

    const all = await ctx.db.query("formTemplates").collect();
    for (const t of all) {
      if (t._id !== id && (t.formType ?? "default") === myType && t.isActive) {
        await ctx.db.patch(t._id, { isActive: false });
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
    // A guest can only file reports for an event they were added to.
    const userId = await requireEventAccess(ctx, args.eventKey);

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
      // An empty roster means "we never learned who is here" — TBA publishes
      // one for events whose team list isn't up yet — not "nobody is here".
      // Enforcing it would reject every submission at such an event.
      if (roster && roster.teamNumbers.length > 0 && !roster.teamNumbers.includes(args.teamNumber)) {
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
    // submission pays out — but only for match/pit forms the scout is assigned
    // to, and only their FIRST one per match (match forms) or per team (pit
    // forms). The offlineId check above only guards replays of a queued
    // submission; nothing stopped a scout re-submitting the same match from
    // the form over and over, which paid the reward every time.
    //
    // Re-submitting is still allowed (it is how a scout corrects a mistake,
    // and two scouts covering the same team is normal and should pay both) —
    // it just doesn't pay twice.
    const template = userId ? await ctx.db.get(args.templateId) : null;
    const formType = template?.formType ?? "default";
    const reward = userId ? await currentReward(ctx, template) : 0;
    if (userId && formType === "default") {
      // Match assignments only exist for quals and are keyed by match number
      // alone — so an "elim" (or level-less) form for the same number must not
      // count as a second assigned match.
      if (
        (args.compLevel ?? "qm") === "qm" &&
        !(await alreadyScoutedMatch(ctx, userId, args, submissionId)) &&
        reward > 0 &&
        (await isAssignedForReward(ctx, userId, formType, args))
      ) {
        await awardCoins(ctx, userId, args.eventKey, reward, "scouting_reward", template?.name, submissionId);
      }
    } else if (userId && formType === "pit" && reward > 0) {
      // Pit scouting is done in groups and one form covers the team, so the
      // submitter's form pays and completes it for everyone rostered on that
      // team. Only the first roster submission per team pays, so a resubmit
      // (or a second teammate filling it in again) doesn't pay the group twice.
      const team = await ctx.db
        .query("pitScoutingTeams")
        .withIndex("by_event_team", (q) =>
          q.eq("eventKey", args.eventKey).eq("teamNumber", args.teamNumber)
        )
        .first();
      if (team?.scoutIds.includes(userId)) {
        const roster = new Set<string>(team.scoutIds);
        const prior = await ctx.db
          .query("formSubmissions")
          .withIndex("by_event_team", (q) =>
            q.eq("eventKey", args.eventKey).eq("teamNumber", args.teamNumber)
          )
          .collect();
        // A pit form an admin deleted still counts as this team's paid one.
        let alreadyPaid = (await ctx.db
          .query("submissionTombstones")
          .withIndex("by_event_team", (q) =>
            q.eq("eventKey", args.eventKey).eq("teamNumber", args.teamNumber)
          )
          .collect()
        ).some((r) => r.formType === "pit" && roster.has(r.scoutId));
        for (const r of prior) {
          if (alreadyPaid) break;
          if (r._id === submissionId || !r.scoutId || !roster.has(r.scoutId)) continue;
          if (((await ctx.db.get(r.templateId))?.formType ?? "default") === "pit") {
            alreadyPaid = true;
            break;
          }
        }
        if (!alreadyPaid) {
          for (const id of team.scoutIds) {
            await awardCoins(ctx, id, args.eventKey, reward, "scouting_reward", template?.name, submissionId);
          }
        }
      }
    }

    return submissionId;
  },
});

/**
 * The signed-in scout's own submissions at an event.
 *
 * Only the identity fields are returned — this backs "have I already done
 * this?" checks (My Schedule completion), not data display, so there is
 * no reason to ship every response blob to every client.
 */
export const getMySubmissions = query({
  args: { eventKey: v.string() },
  handler: async (ctx, { eventKey }) => {
    const userId = await eventViewerId(ctx, eventKey);
    if (!userId) return [];
    const rows = await ctx.db
      .query("formSubmissions")
      .withIndex("by_scout_event_match", (q) =>
        q.eq("scoutId", userId).eq("eventKey", eventKey)
      )
      .collect();

    // formType comes from the template, not the row. My Schedule needs it to
    // tell a pit submission from a match one when ticking assignments off, and
    // resolving it here covers templates that have since been deactivated —
    // the client's listActiveTemplates would not.
    const formTypeById = new Map<string, string>();
    for (const templateId of new Set(rows.map((r) => r.templateId))) {
      const tpl = await ctx.db.get(templateId);
      if (tpl) formTypeById.set(templateId, tpl.formType ?? "default");
    }

    const mine: {
      _id: string; templateId: Id<"formTemplates">; formType: string;
      matchNumber: number; compLevel?: "qm" | "elim"; teamNumber: number;
      offlineId?: string;
    }[] = rows.map((r) => ({
      _id: r._id,
      templateId: r.templateId,
      formType: formTypeById.get(r.templateId) ?? "default",
      matchNumber: r.matchNumber,
      compLevel: r.compLevel,
      teamNumber: r.teamNumber,
      // Lets the client hide a form it has queued for deletion while offline.
      offlineId: r.offlineId,
    }));

    // Forms an admin deleted still count as done (see submissionTombstones).
    const asKey = (r: Doc<"submissionTombstones">) => ({
      _id: r._id, templateId: r.templateId, formType: r.formType,
      matchNumber: r.matchNumber, compLevel: r.compLevel, teamNumber: r.teamNumber,
    });
    const myTombstones = await ctx.db
      .query("submissionTombstones")
      .withIndex("by_scout_event", (q) => q.eq("scoutId", userId).eq("eventKey", eventKey))
      .collect();
    mine.push(...myTombstones.map(asKey));

    // Pit scouting is a group job: a teammate's pit form completes the team for
    // everyone rostered on it, so include those alongside this scout's own.
    const teams = await ctx.db
      .query("pitScoutingTeams")
      .withIndex("by_event", (q) => q.eq("eventKey", eventKey))
      .collect();
    for (const t of teams.filter((t) => t.scoutIds.includes(userId))) {
      const subs = await ctx.db
        .query("formSubmissions")
        .withIndex("by_event_team", (q) => q.eq("eventKey", eventKey).eq("teamNumber", t.teamNumber))
        .collect();
      for (const r of subs) {
        if (r.scoutId === userId) continue;
        let type = formTypeById.get(r.templateId);
        if (type === undefined) {
          type = (await ctx.db.get(r.templateId))?.formType ?? "default";
          formTypeById.set(r.templateId, type);
        }
        if (type !== "pit") continue;
        mine.push({
          _id: r._id, templateId: r.templateId, formType: "pit",
          matchNumber: r.matchNumber, compLevel: r.compLevel, teamNumber: r.teamNumber,
        });
      }
      const gone = await ctx.db
        .query("submissionTombstones")
        .withIndex("by_event_team", (q) => q.eq("eventKey", eventKey).eq("teamNumber", t.teamNumber))
        .collect();
      mine.push(...gone.filter((r) => r.formType === "pit" && r.scoutId !== userId).map(asKey));
    }
    return mine;
  },
});

export const listSubmissions = query({
  args: {
    eventKey: v.string(),
  },
  handler: async (ctx, { eventKey }) => {
    if (!(await canViewEvent(ctx, eventKey))) return [];
    return await ctx.db
      .query("formSubmissions")
      .withIndex("by_event_team", (q) => q.eq("eventKey", eventKey))
      .collect();
  },
});

// listSubmissions minus `data` — for list screens (Manage Scouts, Submissions
// feed) that only show who/what/when. `data` can hold base64 photos, and a
// Convex subscription re-sends the whole result on every new submission, so
// omitting it keeps those pages light. Open one with getSubmission.
export const listSubmissionSummaries = query({
  args: { eventKey: v.string() },
  handler: async (ctx, { eventKey }) => {
    if (!(await canViewEvent(ctx, eventKey))) return [];
    const rows = await ctx.db
      .query("formSubmissions")
      .withIndex("by_event_team", (q) => q.eq("eventKey", eventKey))
      .collect();
    return rows.map(({ data: _data, ...summary }) => summary);
  },
});

export const getSubmission = query({
  args: { id: v.id("formSubmissions") },
  handler: async (ctx, { id }) => {
    const sub = await ctx.db.get(id);
    return sub && (await canViewEvent(ctx, sub.eventKey)) ? sub : null;
  },
});

export const getTeamSubmissions = query({
  args: {
    eventKey: v.string(),
    teamNumber: v.number(),
  },
  handler: async (ctx, { eventKey, teamNumber }) => {
    if (!(await canViewEvent(ctx, eventKey))) return [];
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
    const sub = await ctx.db.get(id);
    if (!sub) return;
    // An admin removing a report is data cleanup, not the scout undoing their
    // work: coins stay, the assignment stays done, and it can't be re-earned.
    const formType = (await ctx.db.get(sub.templateId))?.formType ?? "default";
    if (sub.scoutId && (formType === "default" || formType === "pit")) {
      await ctx.db.insert("submissionTombstones", {
        scoutId: sub.scoutId, eventKey: sub.eventKey, templateId: sub.templateId, formType,
        matchNumber: sub.matchNumber, compLevel: sub.compLevel, teamNumber: sub.teamNumber,
      });
    }
    await ctx.db.delete(id);
  },
});

/**
 * A scout deleting their own form (My QR Codes). Looked up by the offlineId the
 * device generated, and only ever touches the caller's own row. The coins it
 * earned are clawed back and, with the row gone, the assignment reopens in My
 * Assignments. Returns false when there is nothing of theirs to delete (never
 * synced, already deleted, or uploaded by a teammate's scan) so a queued retry
 * can be dropped.
 */
export const deleteMySubmission = mutation({
  args: { offlineId: v.string() },
  handler: async (ctx, { offlineId }) => {
    const userId = await requireUser(ctx);
    const sub = await ctx.db
      .query("formSubmissions")
      .withIndex("by_offline_id", (q) => q.eq("offlineId", offlineId))
      .first();
    if (!sub || sub.scoutId !== userId) return false;
    await reverseReward(ctx, sub);
    await ctx.db.delete(sub._id);
    return true;
  },
});

/**
 * Bulk-delete submissions for an event — every one, or just one scout's.
 * Backs Manage Scouts' "Delete all reports" actions (per-scout and event-wide).
 * Coins already paid out are not clawed back.
 */
export const deleteSubmissions = mutation({
  args: {
    eventKey: v.string(),
    scoutId: v.optional(v.id("users")), // omit to delete every submission at the event
    adminKey: v.optional(v.string()),
  },
  handler: async (ctx, { eventKey, scoutId, adminKey }) => {
    await requireAdmin(ctx, adminKey);
    const rows = await ctx.db
      .query("formSubmissions")
      .withIndex("by_event_team", (q) => q.eq("eventKey", eventKey))
      .collect();
    const toDelete = scoutId ? rows.filter((r) => r.scoutId === scoutId) : rows;
    await Promise.all(toDelete.map((r) => ctx.db.delete(r._id)));
    return toDelete.length;
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
    await requireEventAccess(ctx, eventKey);
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
    if (!(await canViewEvent(ctx, eventKey))) return null;
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
