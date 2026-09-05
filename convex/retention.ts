import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_THRESHOLD = -500;  // default loss tolerance for new players
const MAX_HISTORY = 5;           // rolling window of abandon datapoints
const MIN_LOSS_TO_RECORD = -20;  // ignore trivial losses (single bad bet)

// ── Pure Helpers ──────────────────────────────────────────────────────────────

/** Average the abandon history to compute the player's personal loss tolerance. */
function computeThreshold(abandonHistory: number[]): number {
  if (abandonHistory.length === 0) return DEFAULT_THRESHOLD;
  const avg = abandonHistory.reduce((s, v) => s + v, 0) / abandonHistory.length;
  // Never let threshold be shallower than -50 (would trigger boost too easily)
  return Math.min(avg, -50);
}

/**
 * Compute boost level (0–3) from current session loss vs personal threshold.
 *
 *   0 = normal odds
 *   1 = light boost  (~15% better odds)  — at 60% of threshold
 *   2 = medium boost (~30% better odds)  — at 75% of threshold
 *   3 = heavy boost  (~50% better odds)  — at 90%+ of threshold
 */
function computeBoostLevel(sessionLoss: number, threshold: number): number {
  if (sessionLoss >= 0) return 0; // not losing — no boost
  const ratio = Math.abs(sessionLoss) / Math.abs(threshold);
  if (ratio < 0.60) return 0;
  if (ratio < 0.75) return 1;
  if (ratio < 0.90) return 2;
  return 3;
}

// ── Exported Helper (called by game mutations in betting.ts) ──────────────────

/**
 * Returns the current boost level (0–3) for a player based on their
 * session loss relative to their personal abandon threshold.
 *
 * This is called from within game mutation handlers (spinSlot, dropPlinko, etc.)
 * to determine how much to bias the odds in the player's favor.
 */
export async function getBoostForUser(
  ctx: MutationCtx,
  userId: Id<"users">,
  eventKey: string,
  currentBalance: number,
): Promise<number> {
  const profile = await ctx.db
    .query("retentionProfiles")
    .withIndex("by_user_event", (q) =>
      q.eq("userId", userId).eq("eventKey", eventKey)
    )
    .first();

  if (!profile) return 0;

  const sessionLoss = currentBalance - profile.sessionStartBalance;
  return computeBoostLevel(sessionLoss, profile.threshold);
}

// ── Mutations ─────────────────────────────────────────────────────────────────

/**
 * Called when the player opens the betting page.
 *
 * If a previous session exists, retroactively checks whether the player
 * left while losing and records that as an abandon datapoint.
 * Then starts a fresh session with the current balance.
 */
export const startSession = mutation({
  args: { eventKey: v.string() },
  handler: async (ctx, { eventKey }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    // Get current balance
    const bal = await ctx.db
      .query("userBalances")
      .withIndex("by_user_event", (q) =>
        q.eq("userId", userId).eq("eventKey", eventKey)
      )
      .first();

    const currentBalance = bal?.balance ?? 1000;

    // Check for existing profile
    const existing = await ctx.db
      .query("retentionProfiles")
      .withIndex("by_user_event", (q) =>
        q.eq("userId", userId).eq("eventKey", eventKey)
      )
      .first();

    if (existing) {
      // Retroactively record abandon from prior session if they left while losing
      const priorSessionLoss = currentBalance - existing.sessionStartBalance;

      if (priorSessionLoss < MIN_LOSS_TO_RECORD) {
        // They left while down — record as abandon datapoint
        const history = [...existing.abandonHistory, priorSessionLoss].slice(-MAX_HISTORY);
        const threshold = computeThreshold(history);
        await ctx.db.patch(existing._id, {
          abandonHistory:      history,
          threshold,
          sessionStartBalance: currentBalance,
          sessionStartTime:    Date.now(),
          updatedAt:           Date.now(),
        });
      } else {
        // No significant loss — just start new session
        await ctx.db.patch(existing._id, {
          sessionStartBalance: currentBalance,
          sessionStartTime:    Date.now(),
          updatedAt:           Date.now(),
        });
      }
      return;
    }

    // Create new profile (first visit)
    await ctx.db.insert("retentionProfiles", {
      userId,
      eventKey,
      abandonHistory:      [],
      threshold:           DEFAULT_THRESHOLD,
      sessionStartBalance: currentBalance,
      sessionStartTime:    Date.now(),
      updatedAt:           Date.now(),
    });
  },
});

/**
 * Called when the player leaves the page while in a losing session.
 * Uses visibilitychange / beforeunload on the frontend.
 *
 * Records the current net loss as an abandon datapoint and recomputes
 * the player's personal threshold.
 */
export const recordAbandon = mutation({
  args: { eventKey: v.string() },
  handler: async (ctx, { eventKey }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return; // silently fail — not critical

    const bal = await ctx.db
      .query("userBalances")
      .withIndex("by_user_event", (q) =>
        q.eq("userId", userId).eq("eventKey", eventKey)
      )
      .first();

    const profile = await ctx.db
      .query("retentionProfiles")
      .withIndex("by_user_event", (q) =>
        q.eq("userId", userId).eq("eventKey", eventKey)
      )
      .first();

    if (!profile || !bal) return;

    const sessionLoss = bal.balance - profile.sessionStartBalance;
    if (sessionLoss >= MIN_LOSS_TO_RECORD) return; // not a significant loss

    const history = [...profile.abandonHistory, sessionLoss].slice(-MAX_HISTORY);
    const threshold = computeThreshold(history);

    await ctx.db.patch(profile._id, {
      abandonHistory: history,
      threshold,
      // Close the session out as well as recording it. Without this the
      // sessionStartBalance stayed put, so startSession recomputed the very
      // same loss on the next visit and pushed it into the history a second
      // time — every abandon was counted twice and the threshold drifted.
      sessionStartBalance: bal.balance,
      sessionStartTime:    Date.now(),
      updatedAt:           Date.now(),
    });
  },
});
