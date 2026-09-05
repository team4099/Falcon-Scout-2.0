import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { requireAdmin } from "./adminAuth";
import { getBoostForUser } from "./retention";

const STARTING_BALANCE = 1000;

/** Coins paid for a submission whose template predates per-form rewards. */
export const DEFAULT_SCOUT_REWARD = 50;

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
): Promise<void> {
  if (amount <= 0) return;
  const bal = await ctx.db
    .query("userBalances")
    .withIndex("by_user_event", (q) => q.eq("userId", userId).eq("eventKey", eventKey))
    .first();

  if (!bal) {
    await ctx.db.insert("userBalances", {
      userId,
      eventKey,
      balance:   STARTING_BALANCE + amount,
      totalWon:  0,
      totalLost: 0,
      totalBet:  0,
      totalBegs: 0,
      totalEarned: amount,
    });
    return;
  }
  await ctx.db.patch(bal._id, {
    balance:     bal.balance + amount,
    totalEarned: (bal.totalEarned ?? 0) + amount,
  });
}

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
      await ctx.db.insert("userBalances", {
        userId,
        eventKey,
        balance:   STARTING_BALANCE + BEG_AMOUNT,
        totalWon:  0,
        totalLost: 0,
        totalBet:  0,
        totalBegs: 1,
        lastBegAt: now,
      });
      return { newBalance: STARTING_BALANCE + BEG_AMOUNT, totalBegs: 1 };
    }

    // The 3s cooldown used to live only in BettingPage, so it constrained the
    // button and not the mutation — a loop could mint unlimited coins.
    const since = now - (bal.lastBegAt ?? 0);
    if (since < BEG_COOLDOWN_MS) {
      const wait = Math.ceil((BEG_COOLDOWN_MS - since) / 1000);
      throw new Error(`Slow down — you can beg again in ${wait}s.`);
    }

    await ctx.db.patch(bal._id, {
      balance:   bal.balance + BEG_AMOUNT,
      totalBegs: (bal.totalBegs ?? 0) + 1,
      lastBegAt: now,
    });
    return { newBalance: bal.balance + BEG_AMOUNT, totalBegs: (bal.totalBegs ?? 0) + 1 };
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
  handler: async (ctx, { marketId }) => ctx.db.get(marketId),
});

/**
 * Returns the real bet totals per option for a market (used to compute live odds).
 * Returns: { optionId → totalBetCoins }
 */
export const getMarketPool = query({
  args: { marketId: v.id("bettingMarkets") },
  handler: async (ctx, { marketId }) => {
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
          await ctx.db.patch(bal._id, {
            balance:  bal.balance + payout,
            totalWon: bal.totalWon + payout,
          });
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
        await ctx.db.patch(bal._id, { balance: bal.balance + bet.amount });
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

    if (!Number.isInteger(amount)) throw new Error("Bet must be a whole number of coins");
    if (amount < 10) throw new Error("Minimum bet is 10 coins");

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

    await ctx.db.patch(bal._id, {
      balance:  bal.balance - amount,
      totalBet: bal.totalBet + amount,
    });

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

// ── Slot Machine ──────────────────────────────────────────────────────────────

const SLOT_SYMBOLS = ["lemon", "cherry", "bell", "star", "seven", "money"] as const;
// Flatter distribution → more high-value symbols land, more matches overall
const SLOT_WEIGHTS = [22, 22, 20, 16, 12, 8]; // total = 100
const SLOT_PAYOUTS: Record<string, Record<number, number>> = {
  //                5-kind  4-kind  3-kind  2-kind (tiny consolation)
  money:  { 5: 500, 4: 75,  3: 15,  2: 0.5  },
  seven:  { 5: 150, 4: 30,  3: 8,   2: 0.4  },
  star:   { 5: 75,  4: 15,  3: 4,   2: 0.3  },
  bell:   { 5: 30,  4: 8,   3: 2,   2: 0.2  },
  cherry: { 5: 15,  4: 5,   3: 1.5, 2: 0.15 },
  lemon:  { 5: 8,   4: 3,   3: 1,   2: 0.1  },
};

function weightedSlotSymbol(): string {
  const r = Math.random() * 100;
  let cum = 0;
  for (let i = 0; i < SLOT_SYMBOLS.length; i++) {
    cum += SLOT_WEIGHTS[i];
    if (r < cum) return SLOT_SYMBOLS[i];
  }
  return SLOT_SYMBOLS[0];
}

/**
 * Spin the slot machine. Deducts betAmount, generates 5 weighted-random reels,
 * computes payout from the best N-of-a-kind, and credits winnings.
 * Returns the reel results, payout, and updated balance.
 */
export const spinSlot = mutation({
  args: {
    eventKey:  v.string(),
    betAmount: v.number(),
  },
  handler: async (ctx, { eventKey, betAmount }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    if (betAmount < 10) throw new Error("Minimum bet is 10 coins");

    // Get or create balance
    let bal = await ctx.db
      .query("userBalances")
      .withIndex("by_user_event", (q) =>
        q.eq("userId", userId).eq("eventKey", eventKey)
      )
      .first();

    if (!bal) {
      const id = await ctx.db.insert("userBalances", {
        userId,
        eventKey,
        balance:   STARTING_BALANCE,
        totalWon:  0,
        totalLost: 0,
        totalBet:  0,
        totalBegs: 0,
      });
      bal = (await ctx.db.get(id))!;
    }

    if (bal.balance < betAmount) throw new Error("Insufficient balance");

    // Deduct bet immediately
    await ctx.db.patch(bal._id, {
      balance:  bal.balance - betAmount,
      totalBet: bal.totalBet + betAmount,
    });

    // Generate 5 reels
    const reels: string[] = [];
    for (let i = 0; i < 5; i++) reels.push(weightedSlotSymbol());

    // ── Retention boost: increase matching probability ──────────────────────
    const slotBoost = await getBoostForUser(ctx, userId, eventKey, bal.balance - betAmount);
    if (slotBoost > 0) {
      const forceTripleChance = [0, 0.08, 0.15, 0.25][slotBoost];
      const forcePairChance = [0, 0.20, 0.30, 0.40][slotBoost];
      const rand = Math.random();
      if (rand < forceTripleChance) {
        // Force 3-of-a-kind with a mid/high value symbol
        const boostSymbols = ["cherry", "bell", "star", "seven"];
        const sym = boostSymbols[Math.floor(Math.random() * boostSymbols.length)];
        const positions = [0, 1, 2, 3, 4].sort(() => Math.random() - 0.5).slice(0, 3);
        for (const p of positions) reels[p] = sym;
      } else if (rand < forcePairChance) {
        // Force at least one matching pair
        const src = Math.floor(Math.random() * 5);
        let dst = Math.floor(Math.random() * 5);
        while (dst === src) dst = Math.floor(Math.random() * 5);
        reels[dst] = reels[src];
      }
    }

    // Count occurrences of each symbol
    const counts: Record<string, number> = {};
    for (const s of reels) counts[s] = (counts[s] ?? 0) + 1;

    // Find best payout: check each symbol's count against the payout table
    let payout = 0;
    let winSymbol = "";
    let winCount = 0;
    for (const [sym, cnt] of Object.entries(counts)) {
      const table = SLOT_PAYOUTS[sym];
      if (!table) continue;
      // Check 5, then 4, then 3, then 2
      for (const n of [5, 4, 3, 2] as const) {
        if (cnt >= n && table[n]) {
          const p = Math.floor(betAmount * table[n]);
          if (p > payout) {
            payout = p;
            winSymbol = sym;
            winCount = n;
          }
          break; // take best match count for this symbol
        }
      }
    }

    // Credit winnings
    const updated = (await ctx.db.get(bal._id))!;
    if (payout > 0) {
      await ctx.db.patch(bal._id, {
        balance:  updated.balance + payout,
        totalWon: updated.totalWon + payout,
      });
    } else {
      await ctx.db.patch(bal._id, {
        totalLost: updated.totalLost + betAmount,
      });
    }

    const final = (await ctx.db.get(bal._id))!;
    return {
      reels,
      payout,
      winSymbol,
      winCount,
      newBalance: final.balance,
    };
  },
});

// ── Plinko ────────────────────────────────────────────────────────────────────

/** Risk levels determine the multiplier distribution */
const PLINKO_MULTIPLIERS: Record<string, number[]> = {
  // Low risk: safer payouts, generous edges
  low: [5.0, 2.0, 1.5, 1.2, 0.7, 0.4, 0.7, 1.2, 1.5, 2.0, 5.0],
  // Medium risk: solid variance, juicy edges
  medium: [12.0, 4.0, 2.0, 1.3, 0.8, 0.3, 0.8, 1.3, 2.0, 4.0, 12.0],
  // High risk: extreme variance, massive edge payouts
  high: [50.0, 10.0, 3.0, 0.8, 0.4, 0.2, 0.4, 0.8, 3.0, 10.0, 50.0],
};

/**
 * Simulate a Plinko ball drop. The ball starts at the center and bounces
 * left or right at each row of pegs. Each bounce has a slight center bias
 * to create a natural distribution. Returns the path and final multiplier.
 */
export const dropPlinko = mutation({
  args: {
    eventKey:  v.string(),
    betAmount: v.number(),
    risk:      v.string(),  // "low" | "medium" | "high"
  },
  handler: async (ctx, { eventKey, betAmount, risk }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    if (betAmount < 10) throw new Error("Minimum bet is 10 coins");
    if (!PLINKO_MULTIPLIERS[risk]) throw new Error("Invalid risk level");

    // Get or create balance
    let bal = await ctx.db
      .query("userBalances")
      .withIndex("by_user_event", (q) =>
        q.eq("userId", userId).eq("eventKey", eventKey)
      )
      .first();

    if (!bal) {
      const id = await ctx.db.insert("userBalances", {
        userId,
        eventKey,
        balance:   STARTING_BALANCE,
        totalWon:  0,
        totalLost: 0,
        totalBet:  0,
        totalBegs: 0,
      });
      bal = (await ctx.db.get(id))!;
    }

    if (bal.balance < betAmount) throw new Error("Insufficient balance");

    // Deduct bet
    await ctx.db.patch(bal._id, {
      balance:  bal.balance - betAmount,
      totalBet: bal.totalBet + betAmount,
    });

    // Simulate ball path through 10 rows of pegs
    // Ball starts at position 5 (center of 11 slots: 0-10)
    // At each row, it goes left (-0.5) or right (+0.5)
    const path: number[] = [5]; // starting position (center)
    const multipliers = PLINKO_MULTIPLIERS[risk];
    let position = 5;

    // ── Retention boost: modify center bias to favor higher-multiplier zones ──
    const plinkoBoost = await getBoostForUser(ctx, userId, eventKey, bal.balance - betAmount);
    // Normal (1.0): slight center bias → low multipliers. Boosted: reduce/reverse → edge bias
    const biasScale = [1.0, 0.0, -1.0, -2.0][plinkoBoost];

    for (let row = 0; row < 10; row++) {
      const centerBias = (position > 5 ? -0.02 : position < 5 ? 0.02 : 0) * biasScale;
      const goRight = Math.random() < (0.5 + centerBias);
      position = Math.max(0, Math.min(10, position + (goRight ? 0.5 : -0.5)));
      path.push(position);
    }

    // Map final position to slot index (0-10)
    const slotIndex = Math.round(position);
    const multiplier = multipliers[Math.min(slotIndex, multipliers.length - 1)];
    const payout = Math.floor(betAmount * multiplier);

    // Credit winnings
    const updated = (await ctx.db.get(bal._id))!;
    if (payout > 0) {
      await ctx.db.patch(bal._id, {
        balance:  updated.balance + payout,
        totalWon: payout > betAmount ? updated.totalWon + (payout - betAmount) : updated.totalWon,
        totalLost: payout < betAmount ? updated.totalLost + (betAmount - payout) : updated.totalLost,
      });
    } else {
      await ctx.db.patch(bal._id, {
        totalLost: updated.totalLost + betAmount,
      });
    }

    const final = (await ctx.db.get(bal._id))!;
    return {
      path,
      slotIndex,
      multiplier,
      payout,
      newBalance: final.balance,
    };
  },
});

// ── Crossy Road (Chicken Cross) ───────────────────────────────────────────────

/**
 * Difficulty configs for Chicken Cross.
 * tilesPerRow = total tiles shown, trapsPerRow = how many are deadly.
 * baseMultiplier = payout multiplier per safe step (compounds).
 */
const CROSSY_DIFFICULTIES: Record<string, { tilesPerRow: number; trapsPerRow: number; baseMultiplier: number }> = {
  easy:   { tilesPerRow: 4, trapsPerRow: 1, baseMultiplier: 1.31 },
  medium: { tilesPerRow: 3, trapsPerRow: 1, baseMultiplier: 1.47 },
  hard:   { tilesPerRow: 2, trapsPerRow: 1, baseMultiplier: 1.96 },
  expert: { tilesPerRow: 3, trapsPerRow: 2, baseMultiplier: 2.94 },
};

const CROSSY_MAX_ROWS = 10;

/**
 * Process a single step in the Crossy Road game.
 * - On row 0 (first step): deducts the bet from balance.
 * - Randomly determines trap positions for the current row.
 * - Returns whether the chosen tile was safe or a trap.
 */
export const crossyStep = mutation({
  args: {
    eventKey:   v.string(),
    betAmount:  v.number(),
    difficulty: v.string(),   // "easy" | "medium" | "hard" | "expert"
    tileIndex:  v.number(),   // which tile the player picked (0-based)
    currentRow: v.number(),   // which row we're on (0-based, 0 = first step)
  },
  handler: async (ctx, { eventKey, betAmount, difficulty, tileIndex, currentRow }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    if (betAmount < 10) throw new Error("Minimum bet is 10 coins");

    const config = CROSSY_DIFFICULTIES[difficulty];
    if (!config) throw new Error("Invalid difficulty");
    if (tileIndex < 0 || tileIndex >= config.tilesPerRow) throw new Error("Invalid tile index");
    if (currentRow < 0 || currentRow >= CROSSY_MAX_ROWS) throw new Error("Invalid row");

    // Get or create balance
    let bal = await ctx.db
      .query("userBalances")
      .withIndex("by_user_event", (q) =>
        q.eq("userId", userId).eq("eventKey", eventKey)
      )
      .first();

    if (!bal) {
      const id = await ctx.db.insert("userBalances", {
        userId,
        eventKey,
        balance:   STARTING_BALANCE,
        totalWon:  0,
        totalLost: 0,
        totalBet:  0,
        totalBegs: 0,
      });
      bal = (await ctx.db.get(id))!;
    }

    // On first step, deduct the bet
    if (currentRow === 0) {
      if (bal.balance < betAmount) throw new Error("Insufficient balance");
      await ctx.db.patch(bal._id, {
        balance:  bal.balance - betAmount,
        totalBet: bal.totalBet + betAmount,
      });
    }

    // Row 0 is a "hook" row: no traps, 0.9x multiplier to lure the player in
    const trapsThisRow = currentRow === 0 ? 0 : config.trapsPerRow;

    // Generate trap positions for this row (random, determined server-side)
    const trapIndices: number[] = [];
    const allIndices = Array.from({ length: config.tilesPerRow }, (_, i) => i);
    for (let t = 0; t < trapsThisRow; t++) {
      const pick = Math.floor(Math.random() * allIndices.length);
      trapIndices.push(allIndices[pick]);
      allIndices.splice(pick, 1);
    }

    // ── Retention mercy: chance to save player from trap ────────────────────
    const crossyEffectiveBal = currentRow === 0 ? bal.balance - betAmount : bal.balance;
    const crossyBoost = await getBoostForUser(ctx, userId, eventKey, crossyEffectiveBal);
    if (crossyBoost > 0 && trapIndices.includes(tileIndex) && currentRow > 0) {
      const mercyChance = [0, 0.15, 0.25, 0.40][crossyBoost];
      if (Math.random() < mercyChance) {
        const safeTiles = Array.from({ length: config.tilesPerRow }, (_, i) => i)
          .filter(i => i !== tileIndex && !trapIndices.includes(i));
        if (safeTiles.length > 0) {
          trapIndices[trapIndices.indexOf(tileIndex)] = safeTiles[Math.floor(Math.random() * safeTiles.length)];
        }
      }
    }

    const hitTrap = trapIndices.includes(tileIndex);

    // Calculate current multiplier (compounding)
    // Row 0 = 0.9x (hook), then rows 1+ compound: 0.9 * baseMultiplier^row
    const rowsCompleted = hitTrap ? currentRow : currentRow + 1;
    const HOOK_MULTIPLIER = 0.9;
    const multiplier = rowsCompleted === 0
      ? 1
      : rowsCompleted === 1
        ? HOOK_MULTIPLIER
        : parseFloat((HOOK_MULTIPLIER * Math.pow(config.baseMultiplier, rowsCompleted - 1)).toFixed(2));

    if (hitTrap) {
      // Player lost — record the loss
      const updated = (await ctx.db.get(bal._id))!;
      await ctx.db.patch(bal._id, {
        totalLost: updated.totalLost + betAmount,
      });
      const final = (await ctx.db.get(bal._id))!;
      const lostAtMult = currentRow === 0
        ? 1
        : currentRow === 1
          ? HOOK_MULTIPLIER
          : parseFloat((HOOK_MULTIPLIER * Math.pow(config.baseMultiplier, currentRow - 1)).toFixed(2));
      return {
        safe: false,
        trapIndices,
        multiplier: lostAtMult,
        payout: 0,
        newBalance: final.balance,
        gameOver: true,
      };
    }

    // Safe tile
    const payout = Math.floor(betAmount * multiplier);
    const final = (await ctx.db.get(bal._id))!;
    return {
      safe: true,
      trapIndices,
      multiplier,
      payout,
      newBalance: final.balance,
      gameOver: rowsCompleted >= CROSSY_MAX_ROWS,  // auto-cashout at max
    };
  },
});

/**
 * Cash out the current Crossy Road game.
 * Credits bet × multiplier to the player's balance.
 */
export const crossyCashOut = mutation({
  args: {
    eventKey:   v.string(),
    betAmount:  v.number(),
    multiplier: v.number(),
  },
  handler: async (ctx, { eventKey, betAmount, multiplier }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const bal = await ctx.db
      .query("userBalances")
      .withIndex("by_user_event", (q) =>
        q.eq("userId", userId).eq("eventKey", eventKey)
      )
      .first();

    if (!bal) throw new Error("No balance record");

    const payout = Math.floor(betAmount * multiplier);
    await ctx.db.patch(bal._id, {
      balance:  bal.balance + payout,
      totalWon: bal.totalWon + (payout > betAmount ? payout - betAmount : 0),
    });

    const final = (await ctx.db.get(bal._id))!;
    return {
      payout,
      newBalance: final.balance,
    };
  },
});

// ── Mines ─────────────────────────────────────────────────────────────────────

/**
 * Reveal a tile in the Mines game.
 * On the first reveal (revealedCount === 0), deducts the bet.
 * Server determines mine positions on first reveal and uses a deterministic
 * seed so positions stay consistent across reveals within the same game.
 */
export const minesReveal = mutation({
  args: {
    eventKey:      v.string(),
    betAmount:     v.number(),
    mineCount:     v.number(),    // 1–24
    tileIndex:     v.number(),    // 0–24
    revealedCount: v.number(),    // how many gems already revealed this game
    gameSeed:      v.string(),    // client-generated unique game ID for deterministic mine placement
  },
  handler: async (ctx, { eventKey, betAmount, mineCount, tileIndex, revealedCount, gameSeed }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    if (betAmount < 10) throw new Error("Minimum bet is 10 coins");
    if (mineCount < 1 || mineCount > 24) throw new Error("Mine count must be 1-24");
    if (tileIndex < 0 || tileIndex > 24) throw new Error("Invalid tile index");

    // Get or create balance
    let bal = await ctx.db
      .query("userBalances")
      .withIndex("by_user_event", (q) =>
        q.eq("userId", userId).eq("eventKey", eventKey)
      )
      .first();

    if (!bal) {
      const id = await ctx.db.insert("userBalances", {
        userId,
        eventKey,
        balance:   STARTING_BALANCE,
        totalWon:  0,
        totalLost: 0,
        totalBet:  0,
        totalBegs: 0,
      });
      bal = (await ctx.db.get(id))!;
    }

    // On first reveal, deduct the bet
    if (revealedCount === 0) {
      if (bal.balance < betAmount) throw new Error("Insufficient balance");
      await ctx.db.patch(bal._id, {
        balance:  bal.balance - betAmount,
        totalBet: bal.totalBet + betAmount,
      });
    }

    // Generate deterministic mine positions from gameSeed
    // Simple hash-based seeded RNG
    let hash = 0;
    const seedStr = gameSeed + ":" + userId;
    for (let i = 0; i < seedStr.length; i++) {
      const chr = seedStr.charCodeAt(i);
      hash = ((hash << 5) - hash) + chr;
      hash |= 0;
    }

    // Fisher-Yates shuffle with seeded random to pick mine positions
    const indices = Array.from({ length: 25 }, (_, i) => i);
    let seed = Math.abs(hash);
    const seededRandom = () => {
      seed = (seed * 1664525 + 1013904223) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(seededRandom() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    const minePositions = indices.slice(0, mineCount);

    // ── Retention mercy: chance to save player from mine ────────────────────
    const minesEffectiveBal = revealedCount === 0 ? bal.balance - betAmount : bal.balance;
    const minesBoost = await getBoostForUser(ctx, userId, eventKey, minesEffectiveBal);
    let hitMine = minePositions.includes(tileIndex);
    if (minesBoost > 0 && hitMine) {
      const mercyChance = [0, 0.15, 0.25, 0.40][minesBoost];
      if (Math.random() < mercyChance) {
        hitMine = false;
      }
    }

    // Calculate multiplier using combinatorial formula with 3% house edge
    // Multiplier = 0.97 * C(25, s) / C(25 - N, s)
    // where s = gems revealed (including this one if safe), N = mine count
    const HOUSE_EDGE = 0.97;
    const gemsRevealed = hitMine ? revealedCount : revealedCount + 1;

    const combination = (n: number, k: number): number => {
      if (k > n || k < 0) return 0;
      if (k === 0 || k === n) return 1;
      let result = 1;
      for (let i = 0; i < k; i++) {
        result = result * (n - i) / (i + 1);
      }
      return result;
    };

    const safeTotal = 25 - mineCount;
    const multiplier = gemsRevealed === 0
      ? 1
      : parseFloat(
          (HOUSE_EDGE * combination(25, gemsRevealed) / combination(safeTotal, gemsRevealed)).toFixed(2)
        );

    if (hitMine) {
      // Player lost
      const updated = (await ctx.db.get(bal._id))!;
      await ctx.db.patch(bal._id, {
        totalLost: updated.totalLost + betAmount,
      });
      const final = (await ctx.db.get(bal._id))!;
      return {
        safe: false,
        minePositions,
        multiplier: revealedCount === 0 ? 1 : parseFloat(
          (HOUSE_EDGE * combination(25, revealedCount) / combination(safeTotal, revealedCount)).toFixed(2)
        ),
        payout: 0,
        newBalance: final.balance,
        gameOver: true,
      };
    }

    // Safe tile — check if all safe tiles are revealed (auto cash-out)
    const allGemsRevealed = gemsRevealed >= safeTotal;
    const payout = Math.floor(betAmount * multiplier);
    
    if (allGemsRevealed) {
      // Auto cash out — all gems found!
      const current = (await ctx.db.get(bal._id))!;
      await ctx.db.patch(bal._id, {
        balance:  current.balance + payout,
        totalWon: current.totalWon + (payout > betAmount ? payout - betAmount : 0),
      });
    }

    const final = (await ctx.db.get(bal._id))!;
    return {
      safe: true,
      minePositions: allGemsRevealed ? minePositions : [],
      multiplier,
      payout,
      newBalance: final.balance,
      gameOver: allGemsRevealed,
    };
  },
});

/**
 * Cash out the current Mines game.
 * Credits bet × multiplier to the player's balance.
 */
export const minesCashOut = mutation({
  args: {
    eventKey:   v.string(),
    betAmount:  v.number(),
    multiplier: v.number(),
  },
  handler: async (ctx, { eventKey, betAmount, multiplier }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const bal = await ctx.db
      .query("userBalances")
      .withIndex("by_user_event", (q) =>
        q.eq("userId", userId).eq("eventKey", eventKey)
      )
      .first();

    if (!bal) throw new Error("No balance record");

    const payout = Math.floor(betAmount * multiplier);
    await ctx.db.patch(bal._id, {
      balance:  bal.balance + payout,
      totalWon: bal.totalWon + (payout > betAmount ? payout - betAmount : 0),
    });

    const final = (await ctx.db.get(bal._id))!;
    return {
      payout,
      newBalance: final.balance,
    };
  },
});
