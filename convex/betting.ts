import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { isSignedIn, requireAdmin } from "./adminAuth";

const STARTING_BALANCE = 1000;

/** Coins paid for a submission whose template predates per-form rewards. */
export const DEFAULT_SCOUT_REWARD = 50;

/** Coins paid for reporting to a pit-duty shift (no form submission to reward instead). */
export const PIT_DUTY_REWARD = 100;

/** Upper bound on a single admin grant — a typo guard, not an economy limit. */
const MAX_ADMIN_AWARD = 100_000;

const MIN_BET = 10;
/** Coins are whole and the economy starts at 1000; nothing legitimate stakes more. */
const MAX_BET = 1_000_000;

/**
 * Validate a stake before it touches a balance.
 *
 * placeBet has always required a whole number, but the casino mutations only
 * checked the floor — so a bet of 10.7777 left balances like 990.2223, and a
 * non-finite stake propagated straight into the row. Coins are integers
 * everywhere; enforce that in one place.
 */
function assertBet(betAmount: number): void {
  if (!Number.isInteger(betAmount)) {
    throw new Error("Bet must be a whole number of coins");
  }
  if (betAmount < MIN_BET) throw new Error(`Minimum bet is ${MIN_BET} coins`);
  if (betAmount > MAX_BET) throw new Error("Bet is too large");
}

// ── Transaction ledger ───────────────────────────────────────────────────────

type TransactionType =
  | "scouting_reward"
  | "pit_duty_reward"
  | "pit_duty_revoked"
  | "admin_award"
  | "beg"
  | "bet_placed"
  | "bet_won"
  | "bet_refunded";

/** Record one balance-affecting event. Called alongside the patch that causes it, never instead of it. */
async function logTransaction(
  ctx: MutationCtx,
  userId: Id<"users">,
  eventKey: string,
  type: TransactionType,
  amount: number,
  balanceAfter: number,
  note?: string,
  relatedId?: string,
): Promise<void> {
  await ctx.db.insert("coinTransactions", {
    userId,
    eventKey,
    type,
    amount,
    balanceAfter,
    note,
    relatedId,
    createdAt: Date.now(),
  });
}

/** All ledger entries for the current user at an event, newest first. */
export const listMyTransactions = query({
  args: { eventKey: v.string() },
  handler: async (ctx, { eventKey }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const rows = await ctx.db
      .query("coinTransactions")
      .withIndex("by_user_event", (q) => q.eq("userId", userId).eq("eventKey", eventKey))
      .collect();
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  },
});

/**
 * Credit a scout for work done, creating their balance row if this is their
 * first activity at the event. Winnings are tracked separately from gambling
 * so the leaderboard can tell earned coins from lucky ones.
 */
export async function awardCoins(
  ctx: MutationCtx,
  userId: Id<"users">,
  eventKey: string,
  amount: number,
  reason: "scouting_reward" | "pit_duty_reward" | "admin_award",
  note?: string,
  relatedId?: string,
): Promise<void> {
  if (amount <= 0) return;
  const bal = await ctx.db
    .query("userBalances")
    .withIndex("by_user_event", (q) => q.eq("userId", userId).eq("eventKey", eventKey))
    .first();

  let balanceAfter: number;
  if (!bal) {
    balanceAfter = STARTING_BALANCE + amount;
    await ctx.db.insert("userBalances", {
      userId,
      eventKey,
      balance:   balanceAfter,
      totalWon:  0,
      totalLost: 0,
      totalBet:  0,
      totalBegs: 0,
      totalEarned: amount,
    });
  } else {
    balanceAfter = bal.balance + amount;
    await ctx.db.patch(bal._id, {
      balance:     balanceAfter,
      totalEarned: (bal.totalEarned ?? 0) + amount,
    });
  }
  await logTransaction(ctx, userId, eventKey, reason, amount, balanceAfter, note, relatedId);
}

/**
 * Reverse a previous `awardCoins` call — for an action that undoes the work
 * it paid out for (e.g. undoing a pit-duty report). A no-op if the user has
 * no balance row yet, since there is nothing to claw back.
 */
export async function revokeCoins(
  ctx: MutationCtx,
  userId: Id<"users">,
  eventKey: string,
  amount: number,
  reason: "pit_duty_revoked",
  note?: string,
  relatedId?: string,
): Promise<void> {
  if (amount <= 0) return;
  const bal = await ctx.db
    .query("userBalances")
    .withIndex("by_user_event", (q) => q.eq("userId", userId).eq("eventKey", eventKey))
    .first();
  if (!bal) return;
  const balanceAfter = bal.balance - amount;
  await ctx.db.patch(bal._id, {
    balance:     balanceAfter,
    totalEarned: Math.max(0, (bal.totalEarned ?? 0) - amount),
  });
  await logTransaction(ctx, userId, eventKey, reason, -amount, balanceAfter, note, relatedId);
}

/**
 * Admin-only: grant a scout bonus coins with a mandatory reason. The reason is
 * stored as the ledger note, so the scout sees why in their Log tab.
 * Grants only — there is deliberately no admin "take coins" path here.
 */
export const adminAwardCoins = mutation({
  args: {
    eventKey: v.string(),
    scoutId:  v.id("users"),
    amount:   v.number(),
    message:  v.string(),
  },
  handler: async (ctx, { eventKey, scoutId, amount, message }) => {
    await requireAdmin(ctx);
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error("Amount must be a positive whole number of coins");
    }
    if (amount > MAX_ADMIN_AWARD) {
      throw new Error(`Amount can't exceed ${MAX_ADMIN_AWARD} coins`);
    }
    const note = message.trim();
    if (!note) throw new Error("A message explaining the award is required");
    if (note.length > 200) throw new Error("Message must be 200 characters or fewer");
    if (!(await ctx.db.get(scoutId))) throw new Error("Scout not found");

    await awardCoins(ctx, scoutId, eventKey, amount, "admin_award", note);
  },
});

// ── Balance ───────────────────────────────────────────────────────────────────

/** Returns the current user's balance for an event, creating it (1000 coins) if absent. */
export const getOrCreateBalance = mutation({
  args: { eventKey: v.string() },
  handler: async (ctx, { eventKey }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const existing = await ctx.db
      .query("userBalances")
      .withIndex("by_user_event", (q) => q.eq("userId", userId).eq("eventKey", eventKey))
      .first();

    if (existing) return existing;

    const id = await ctx.db.insert("userBalances", {
      userId,
      eventKey,
      balance:   STARTING_BALANCE,
      totalWon:  0,
      totalLost: 0,
      totalBet:  0,
      totalBegs: 0,
    });
    return await ctx.db.get(id);
  },
});

/** Returns the current user's balance (read-only, no side effects). */
export const getMyBalance = query({
  args: { eventKey: v.string() },
  handler: async (ctx, { eventKey }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    return await ctx.db
      .query("userBalances")
      .withIndex("by_user_event", (q) => q.eq("userId", userId).eq("eventKey", eventKey))
      .first();
  },
});

/**
 * The legendary "pls beg" button. Grants exactly +10 coins.
 * 3-second cooldown enforced on the frontend. Pure desperation energy.
 */
/** Cooldown between begs. Mirrored in the UI, but enforced here. */
// Begging is the fallback for a scout who is genuinely broke, not an income
// stream. 1 coin on a 60s cooldown makes it a last resort rather than a way to
// out-earn scouting.
const BEG_COOLDOWN_MS = 60_000;
const BEG_AMOUNT = 1;

export const beg = mutation({
  args: { eventKey: v.string() },
  handler: async (ctx, { eventKey }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const now = Date.now();

    const bal = await ctx.db
      .query("userBalances")
      .withIndex("by_user_event", (q) => q.eq("userId", userId).eq("eventKey", eventKey))
      .first();

    if (!bal) {
      const balanceAfter = STARTING_BALANCE + BEG_AMOUNT;
      await ctx.db.insert("userBalances", {
        userId,
        eventKey,
        balance:   balanceAfter,
        totalWon:  0,
        totalLost: 0,
        totalBet:  0,
        totalBegs: 1,
        lastBegAt: now,
      });
      await logTransaction(ctx, userId, eventKey, "beg", BEG_AMOUNT, balanceAfter);
      return { newBalance: balanceAfter, totalBegs: 1 };
    }

    // The 3s cooldown used to live only in BettingPage, so it constrained the
    // button and not the mutation — a loop could mint unlimited coins.
    const since = now - (bal.lastBegAt ?? 0);
    if (since < BEG_COOLDOWN_MS) {
      const wait = Math.ceil((BEG_COOLDOWN_MS - since) / 1000);
      throw new Error(`Slow down — you can beg again in ${wait}s.`);
    }

    const balanceAfter = bal.balance + BEG_AMOUNT;
    await ctx.db.patch(bal._id, {
      balance:   balanceAfter,
      totalBegs: (bal.totalBegs ?? 0) + 1,
      lastBegAt: now,
    });
    await logTransaction(ctx, userId, eventKey, "beg", BEG_AMOUNT, balanceAfter);
    return { newBalance: balanceAfter, totalBegs: (bal.totalBegs ?? 0) + 1 };
  },
});

// ── Markets ───────────────────────────────────────────────────────────────────

/** List all markets for an event, optionally filtered by status. */
export const listMarkets = query({
  args: {
    eventKey: v.string(),
    status: v.optional(v.union(
      v.literal("open"),
      v.literal("locked"),
      v.literal("resolved"),
      v.literal("cancelled"),
    )),
  },
  handler: async (ctx, { eventKey, status }) => {
    if (!(await isSignedIn(ctx))) return [];
    const all = await ctx.db
      .query("bettingMarkets")
      .withIndex("by_event", (q) => q.eq("eventKey", eventKey))
      .collect();
    if (status) return all.filter((m) => m.status === status);
    return all;
  },
});

/** Get a single market by ID. */
export const getMarket = query({
  args: { marketId: v.id("bettingMarkets") },
  handler: async (ctx, { marketId }) =>
    (await isSignedIn(ctx)) ? ctx.db.get(marketId) : null,
});

/**
 * Returns the real bet totals per option for a market (used to compute live odds).
 * Returns: { optionId → totalBetCoins }
 */
export const getMarketPool = query({
  args: { marketId: v.id("bettingMarkets") },
  handler: async (ctx, { marketId }) => {
    if (!(await isSignedIn(ctx))) return {};
    const bets = await ctx.db
      .query("bets")
      .withIndex("by_market", (q) => q.eq("marketId", marketId))
      .collect();

    const totals: Record<string, number> = {};
    for (const bet of bets) {
      totals[bet.optionId] = (totals[bet.optionId] ?? 0) + bet.amount;
    }
    return totals;
  },
});

/** Create a new betting market. Any authenticated user can create one. */
export const createMarket = mutation({
  args: {
    eventKey:     v.string(),
    title:        v.string(),
    description:  v.optional(v.string()),
    type: v.union(
      v.literal("match_winner"),
      v.literal("alliance_score_ou"),
      v.literal("point_differential"),
      v.literal("team_field_bool"),
      v.literal("team_field_numeric"),
      v.literal("team_field_select"),
      v.literal("multi_match_numeric"),
      v.literal("multi_match_count"),
      v.literal("team_top_rank"),
      v.literal("alliance_selection"),
      v.literal("elimination_advance"),
    ),
    matchNumber:  v.optional(v.number()),
    matchNumbers: v.optional(v.array(v.number())),
    teamNumber:   v.optional(v.number()),
    alliance:     v.optional(v.union(v.literal("red"), v.literal("blue"))),
    templateId:   v.optional(v.id("formTemplates")),
    fieldId:      v.optional(v.string()),
    fieldLabel:   v.optional(v.string()),
    threshold:    v.optional(v.number()),
    targetValue:  v.optional(v.string()),
    minCount:     v.optional(v.number()),
    targetScope:  v.optional(v.union(v.literal("team"), v.literal("alliance"), v.literal("match"))),
    options: v.array(v.object({
      id:       v.string(),
      label:    v.string(),
      seedPool: v.number(),
    })),
    adminKey: v.optional(v.string()),
  },
  handler: async (ctx, { adminKey, ...args }) => {
    const userId = await requireAdmin(ctx, adminKey);

    return await ctx.db.insert("bettingMarkets", {
      ...args,
      status:    "open",
      createdAt: Date.now(),
      createdBy: userId,
    });
  },
});

/**
 * Batch-create two EPA-calibrated markets per match:
 *   1. match_winner        — odds seeded by Statbotics win probability
 *   2. point_differential  — O/U line set at the EPA-predicted margin
 *
 * Lines are set at the statistical median so they are genuinely 50/50.
 * Both markets are skipped if they already exist for that match.
 */
export const batchCreateRandomMarkets = mutation({
  args: {
    eventKey: v.string(),
    limit:    v.optional(v.number()), // max market documents to create (default: unlimited)
    matches: v.array(v.object({
      matchNumber:     v.number(),
      matchLabel:      v.string(),
      seedRed:         v.number(),
      seedBlue:        v.number(),
      predictedMargin: v.number(),
    })),
    adminKey: v.optional(v.string()),
  },
  handler: async (ctx, { eventKey, limit, matches, adminKey }) => {
    const userId = await requireAdmin(ctx, adminKey);

    const existing = await ctx.db
      .query("bettingMarkets")
      .withIndex("by_event", (q) => q.eq("eventKey", eventKey))
      .collect();

    const existingWinnerNums = new Set(
      existing.filter((m) => m.type === "match_winner").map((m) => m.matchNumber)
    );
    const existingDiffNums = new Set(
      existing.filter((m) => m.type === "point_differential").map((m) => m.matchNumber)
    );

    let created = 0;
    for (const m of matches) {
      if (limit !== undefined && created >= limit) break;

      // ── 1. Match winner ───────────────────────────────────────────────────
      if (!existingWinnerNums.has(m.matchNumber)) {
        await ctx.db.insert("bettingMarkets", {
          eventKey,
          title:       `${m.matchLabel} — Match Winner`,
          description: `Statbotics predicted win probability: Red ${m.seedRed}% · Blue ${m.seedBlue}%`,
          type:        "match_winner",
          matchNumber: m.matchNumber,
          options: [
            { id: "red",  label: "Red Alliance",  seedPool: m.seedRed  },
            { id: "blue", label: "Blue Alliance", seedPool: m.seedBlue },
          ],
          status:    "open",
          createdAt: Date.now(),
          createdBy: userId,
        });
        created++;
        if (limit !== undefined && created >= limit) break;
      }

      // ── 2. Point differential O/U at the EPA-predicted margin ─────────────
      if (limit !== undefined && created >= limit) break;
      if (!existingDiffNums.has(m.matchNumber)) {
        const line = m.predictedMargin;
        await ctx.db.insert("bettingMarkets", {
          eventKey,
          title:       `${m.matchLabel} — Margin Over/Under ${line}`,
          description: `Statbotics EPA predicts a ~${line} pt margin. Will the final spread beat that?`,
          type:        "point_differential",
          matchNumber: m.matchNumber,
          threshold:   line,
          options: [
            { id: "over",  label: `⬆ Over ${line} pts`,  seedPool: 50 },
            { id: "under", label: `⬇ Under ${line} pts`, seedPool: 50 },
          ],
          status:    "open",
          createdAt: Date.now(),
          createdBy: userId,
        });
        created++;
      }
    }
    return { created };
  },
});

/**
 * Batch-create match winner markets for multiple TBA matches.
 * Skips any match that already has a match_winner market.
 * seedRed / seedBlue come from Statbotics win probability (0–1 each, sum to 1).
 */
export const batchCreateMatchMarkets = mutation({
  args: {
    eventKey: v.string(),
    matches: v.array(v.object({
      matchNumber: v.number(),
      matchLabel:  v.string(),
      seedRed:     v.number(), // 0–100 (Statbotics win% × 100)
      seedBlue:    v.number(), // 0–100
    })),
    adminKey: v.optional(v.string()),
  },
  handler: async (ctx, { eventKey, matches, adminKey }) => {
    const userId = await requireAdmin(ctx, adminKey);

    const existing = await ctx.db
      .query("bettingMarkets")
      .withIndex("by_event", (q) => q.eq("eventKey", eventKey))
      .collect();

    const existingMatchWinnerNums = new Set(
      existing
        .filter((m) => m.type === "match_winner")
        .map((m) => m.matchNumber)
    );

    let created = 0;
    for (const m of matches) {
      if (existingMatchWinnerNums.has(m.matchNumber)) continue;
      await ctx.db.insert("bettingMarkets", {
        eventKey,
        title:       `${m.matchLabel} — Match Winner`,
        description: `Will Red or Blue win ${m.matchLabel}?`,
        type:        "match_winner",
        matchNumber: m.matchNumber,
        options: [
          { id: "red",  label: "Red Alliance",  seedPool: m.seedRed  },
          { id: "blue", label: "Blue Alliance", seedPool: m.seedBlue },
        ],
        status:    "open",
        createdAt: Date.now(),
        createdBy: userId,
      });
      created++;
    }
    return { created };
  },
});

/** Lock a market (no more bets accepted). */
export const lockMarket = mutation({
  args: { marketId: v.id("bettingMarkets"), adminKey: v.optional(v.string()) },
  handler: async (ctx, { marketId, adminKey }) => {
    await requireAdmin(ctx, adminKey);
    await ctx.db.patch(marketId, { status: "locked" });
  },
});

/** Unlock a market back to open. */
export const unlockMarket = mutation({
  args: { marketId: v.id("bettingMarkets"), adminKey: v.optional(v.string()) },
  handler: async (ctx, { marketId, adminKey }) => {
    await requireAdmin(ctx, adminKey);
    await ctx.db.patch(marketId, { status: "open" });
  },
});

/**
 * Resolve a market with a winning outcome.
 * Computes payouts using the parimutuel + seed pool formula and settles all bets.
 *
 * Formula:
 *   totalPool   = Σ(all seedPools) + Σ(all real bets)
 *   winPool     = seedPool_winner + Σ(real bets on winner)
 *   payout_i    = (bet_i / winPool) × totalPool   [rounded down to integer]
 */
export const resolveMarket = mutation({
  args: {
    marketId:        v.id("bettingMarkets"),
    resolvedOptionId: v.string(),
    adminKey: v.optional(v.string()),
  },
  handler: async (ctx, { marketId, resolvedOptionId, adminKey }) => {
    await requireAdmin(ctx, adminKey);

    const market = await ctx.db.get(marketId);
    if (!market) throw new Error("Market not found");
    if (market.status === "resolved" || market.status === "cancelled") {
      throw new Error("Market already closed");
    }

    // Collect all bets
    const allBets = await ctx.db
      .query("bets")
      .withIndex("by_market", (q) => q.eq("marketId", marketId))
      .collect();

    // Compute pool sizes
    const seedTotal = market.options.reduce((s, o) => s + o.seedPool, 0);
    const betTotal  = allBets.reduce((s, b) => s + b.amount, 0);
    const totalPool = seedTotal + betTotal;

    const winnerOption = market.options.find((o) => o.id === resolvedOptionId);
    if (!winnerOption) throw new Error("Unknown winning option");

    const winBets = allBets.filter((b) => b.optionId === resolvedOptionId);
    const winBetTotal = winBets.reduce((s, b) => s + b.amount, 0);
    const winPool = winnerOption.seedPool + winBetTotal;

    // Settle each winning bet
    for (const bet of allBets) {
      const won = bet.optionId === resolvedOptionId;
      const payout = won ? Math.floor((bet.amount / winPool) * totalPool) : 0;

      await ctx.db.patch(bet._id, { payout, settled: true });

      // Update user balance
      const bal = await ctx.db
        .query("userBalances")
        .withIndex("by_user_event", (q) =>
          q.eq("userId", bet.userId).eq("eventKey", bet.eventKey)
        )
        .first();

      if (bal) {
        if (won) {
          const balanceAfter = bal.balance + payout;
          await ctx.db.patch(bal._id, {
            balance:  balanceAfter,
            totalWon: bal.totalWon + payout,
          });
          if (payout > 0) {
            await logTransaction(
              ctx, bet.userId, bet.eventKey, "bet_won", payout, balanceAfter,
              market.title, marketId,
            );
          }
        } else {
          await ctx.db.patch(bal._id, {
            totalLost: bal.totalLost + bet.amount,
          });
        }
      }
    }

    // Mark market resolved
    await ctx.db.patch(marketId, {
      status:           "resolved",
      resolvedOptionId,
      resolvedAt:       Date.now(),
    });

    return { settledBets: allBets.length, totalPool };
  },
});

/**
 * Cancel a market and refund all bets.
 */
export const cancelMarket = mutation({
  args: { marketId: v.id("bettingMarkets"), adminKey: v.optional(v.string()) },
  handler: async (ctx, { marketId, adminKey }) => {
    await requireAdmin(ctx, adminKey);

    const market = await ctx.db.get(marketId);
    if (!market) throw new Error("Market not found");
    // Both terminal states must be rejected: without the "cancelled" check a
    // second call refunds every bet again, minting coins out of nothing.
    if (market.status === "resolved") throw new Error("Market already resolved");
    if (market.status === "cancelled") throw new Error("Market already cancelled");

    const allBets = await ctx.db
      .query("bets")
      .withIndex("by_market", (q) => q.eq("marketId", marketId))
      .collect();

    for (const bet of allBets) {
      const bal = await ctx.db
        .query("userBalances")
        .withIndex("by_user_event", (q) =>
          q.eq("userId", bet.userId).eq("eventKey", bet.eventKey)
        )
        .first();
      if (bal) {
        const balanceAfter = bal.balance + bet.amount;
        await ctx.db.patch(bal._id, { balance: balanceAfter });
        await logTransaction(
          ctx, bet.userId, bet.eventKey, "bet_refunded", bet.amount, balanceAfter,
          market.title, marketId,
        );
      }
      await ctx.db.patch(bet._id, { payout: bet.amount, settled: true });
    }

    await ctx.db.patch(marketId, { status: "cancelled" });
    return { refundedBets: allBets.length };
  },
});

// ── Bets ──────────────────────────────────────────────────────────────────────

/**
 * Place a bet on a market outcome.
 * Deducts from balance immediately.
 */
export const placeBet = mutation({
  args: {
    marketId: v.id("bettingMarkets"),
    optionId: v.string(),
    amount:   v.number(),
  },
  handler: async (ctx, { marketId, optionId, amount }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    assertBet(amount);

    const market = await ctx.db.get(marketId);
    if (!market) throw new Error("Market not found");
    if (market.status !== "open") throw new Error("Market is not open for betting");

    const validOption = market.options.find((o) => o.id === optionId);
    if (!validOption) throw new Error("Invalid option");

    // Get / create balance
    let bal = await ctx.db
      .query("userBalances")
      .withIndex("by_user_event", (q) =>
        q.eq("userId", userId).eq("eventKey", market.eventKey)
      )
      .first();

    if (!bal) {
      const id = await ctx.db.insert("userBalances", {
        userId,
        eventKey:  market.eventKey,
        balance:   STARTING_BALANCE,
        totalWon:  0,
        totalLost: 0,
        totalBet:  0,
        totalBegs: 0,
      });
      bal = await ctx.db.get(id);
    }

    if (!bal || bal.balance < amount) throw new Error("Insufficient balance");

    const balanceAfter = bal.balance - amount;
    await ctx.db.patch(bal._id, {
      balance:  balanceAfter,
      totalBet: bal.totalBet + amount,
    });
    await logTransaction(
      ctx, userId, market.eventKey, "bet_placed", -amount, balanceAfter,
      market.title, marketId,
    );

    return await ctx.db.insert("bets", {
      marketId,
      userId,
      optionId,
      amount,
      eventKey: market.eventKey,
      placedAt: Date.now(),
    });
  },
});

/** All bets placed by the current user at an event. */
export const listMyBets = query({
  args: { eventKey: v.string() },
  handler: async (ctx, { eventKey }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    return await ctx.db
      .query("bets")
      .withIndex("by_user_event", (q) =>
        q.eq("userId", userId).eq("eventKey", eventKey)
      )
      .collect();
  },
});

/** All bets on a specific market (for admins / market detail view). */
export const listMarketBets = query({
  args: { marketId: v.id("bettingMarkets") },
  handler: async (ctx, { marketId }) => {
    if (!(await isSignedIn(ctx))) return [];
    return await ctx.db
      .query("bets")
      .withIndex("by_market", (q) => q.eq("marketId", marketId))
      .collect();
  },
});

// ── Leaderboard ───────────────────────────────────────────────────────────────

/** Top balances for an event, sorted by net profit (totalWon - totalLost). */
export const getLeaderboard = query({
  args: { eventKey: v.string() },
  handler: async (ctx, { eventKey }) => {
    if (!(await isSignedIn(ctx))) return [];
    const balances = (await ctx.db
      .query("userBalances")
      .collect()
    ).filter((b) => b.eventKey === eventKey);

    // Enrich with user display name
    const enriched = await Promise.all(
      balances.map(async (b) => {
        const user = await ctx.db.get(b.userId);
        return {
          ...b,
          displayName: (user as unknown as { name?: string; email?: string } | null)?.name
            ?? (user as unknown as { name?: string; email?: string } | null)?.email
            ?? "Unknown Scout",
        };
      })
    );

    // Rank by coins held, not net profit: the headline number on the leaderboard
    // is the balance, and a board sorted by a number it does not show reads as
    // broken. Net profit breaks ties.
    return enriched.sort(
      (a, b) =>
        b.balance - a.balance ||
        (b.totalWon - b.totalLost) - (a.totalWon - a.totalLost)
    );
  },
});

// ── Admin: wipe everything ────────────────────────────────────────────────────

/**
 * Delete ALL betting markets and bets for an event, then reset every
 * user's balance back to the starting amount.  Admin-only by convention
 * (enforced in the UI; any authenticated user can call it from the backend).
 */
export const clearAllMarkets = mutation({
  args: { eventKey: v.string(), adminKey: v.optional(v.string()) },
  handler: async (ctx, { eventKey, adminKey }) => {
    await requireAdmin(ctx, adminKey);

    // Delete all markets
    const markets = await ctx.db
      .query("bettingMarkets")
      .withIndex("by_event", (q) => q.eq("eventKey", eventKey))
      .collect();
    for (const m of markets) await ctx.db.delete(m._id);

    // Delete all bets for this event
    const allBets = await ctx.db.query("bets").collect();
    const eventBets = allBets.filter((b) => b.eventKey === eventKey);
    for (const b of eventBets) await ctx.db.delete(b._id);

    // Reset all user balances for this event
    const balances = await ctx.db.query("userBalances").collect();
    const eventBalances = balances.filter((b) => b.eventKey === eventKey);
    for (const bal of eventBalances) {
      await ctx.db.patch(bal._id, {
        balance:   STARTING_BALANCE,
        totalWon:  0,
        totalLost: 0,
        totalBet:  0,
        totalBegs: 0,
      });
    }

    return {
      marketsDeleted: markets.length,
      betsDeleted:    eventBets.length,
      balancesReset:  eventBalances.length,
    };
  },
});
