import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { isSignedIn, requireAdmin } from "./adminAuth";
import { getBoostForUser } from "./retention";

const STARTING_BALANCE = 1000;

/** Coins paid for a submission whose template predates per-form rewards. */
export const DEFAULT_SCOUT_REWARD = 50;

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

/** The caller's balance row for an event, created with the starting stake if absent. */
async function getOrCreateBalanceRow(
  ctx: MutationCtx,
  userId: Id<"users">,
  eventKey: string,
) {
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
  return (await ctx.db.get(id))!;
}

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
    assertBet(betAmount);

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
    assertBet(betAmount);
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

// ── Multi-step casino games (Crossy Road, Mines) ──────────────────────────────
//
// Both games span several mutations: a start, one or more steps, then a
// cash-out. Every piece of that state — the board, the progress, and the
// multiplier to pay — is held in `casinoGames` and never accepted from the
// caller. The client used to own all of it and hand the multiplier back at
// cash-out, which meant `minesCashOut({betAmount, multiplier})` credited
// whatever it was given: one console call could mint an unbounded balance.
// The step and cash-out mutations below now take only the tile the player
// touched and read everything else from the row.

/** Find the caller's open round for a game, if any. */
async function openGame(
  ctx: MutationCtx,
  userId: Id<"users">,
  eventKey: string,
  game: "crossy" | "mines",
) {
  return await ctx.db
    .query("casinoGames")
    .withIndex("by_user_event_game", (q) =>
      q.eq("userId", userId).eq("eventKey", eventKey).eq("game", game)
    )
    .first();
}

/**
 * Open a round: validate the stake, deduct it, and clear any round the player
 * walked away from. An abandoned round's stake stays spent — that is what
 * abandoning means — so this never refunds.
 */
async function startRound(
  ctx: MutationCtx,
  userId: Id<"users">,
  eventKey: string,
  game: "crossy" | "mines",
  betAmount: number,
  state: Record<string, unknown>,
): Promise<number> {
  assertBet(betAmount);

  const stale = await openGame(ctx, userId, eventKey, game);
  if (stale) await ctx.db.delete(stale._id);

  const bal = await getOrCreateBalanceRow(ctx, userId, eventKey);
  if (bal.balance < betAmount) throw new Error("Insufficient balance");

  await ctx.db.patch(bal._id, {
    balance:  bal.balance - betAmount,
    totalBet: bal.totalBet + betAmount,
  });

  await ctx.db.insert("casinoGames", {
    userId,
    eventKey,
    game,
    betAmount,
    multiplier: 1,
    startedAt: Date.now(),
    ...state,
  });

  return bal.balance - betAmount;
}

/** Pay out an open round at the multiplier the server computed, and close it. */
async function settleRound(
  ctx: MutationCtx,
  userId: Id<"users">,
  eventKey: string,
  game: "crossy" | "mines",
  minMultiplierSteps: number,
): Promise<{ payout: number; newBalance: number; multiplier: number }> {
  const round = await openGame(ctx, userId, eventKey, game);
  if (!round) throw new Error("No game in progress");

  const progress =
    game === "mines" ? (round.revealed?.length ?? 0) : (round.rowsCleared ?? 0);
  if (progress < minMultiplierSteps) {
    throw new Error("Nothing to cash out yet");
  }

  const payout = Math.floor(round.betAmount * round.multiplier);
  const bal = await getOrCreateBalanceRow(ctx, userId, eventKey);
  await ctx.db.patch(bal._id, {
    balance:  bal.balance + payout,
    totalWon: bal.totalWon + Math.max(0, payout - round.betAmount),
    ...(payout < round.betAmount
      ? { totalLost: bal.totalLost + (round.betAmount - payout) }
      : {}),
  });
  await ctx.db.delete(round._id);

  return { payout, newBalance: bal.balance + payout, multiplier: round.multiplier };
}

/** Close a lost round and book the stake as a loss. */
async function loseRound(
  ctx: MutationCtx,
  userId: Id<"users">,
  eventKey: string,
  roundId: Id<"casinoGames">,
  betAmount: number,
): Promise<number> {
  const bal = await getOrCreateBalanceRow(ctx, userId, eventKey);
  await ctx.db.patch(bal._id, { totalLost: bal.totalLost + betAmount });
  await ctx.db.delete(roundId);
  return bal.balance;
}

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
/** Row 0 pays under 1x — the hook that gets a player one row in. */
const CROSSY_HOOK_MULTIPLIER = 0.9;

/** Cash-out multiplier after `rowsCleared` safe rows. */
function crossyMultiplier(rowsCleared: number, baseMultiplier: number): number {
  if (rowsCleared <= 0) return 1;
  if (rowsCleared === 1) return CROSSY_HOOK_MULTIPLIER;
  return parseFloat(
    (CROSSY_HOOK_MULTIPLIER * Math.pow(baseMultiplier, rowsCleared - 1)).toFixed(2)
  );
}

/** Begin a Chicken Cross round. Deducts the stake and opens the server round. */
export const crossyStart = mutation({
  args: {
    eventKey:   v.string(),
    betAmount:  v.number(),
    difficulty: v.string(),
  },
  handler: async (ctx, { eventKey, betAmount, difficulty }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    if (!CROSSY_DIFFICULTIES[difficulty]) throw new Error("Invalid difficulty");

    const newBalance = await startRound(ctx, userId, eventKey, "crossy", betAmount, {
      difficulty,
      rowsCleared: 0,
    });
    return { newBalance };
  },
});

/**
 * Step onto one tile of the current row. The row number, the stake and the
 * difficulty all come from the open round, so the only thing the caller
 * chooses is which tile to touch.
 */
export const crossyStep = mutation({
  args: {
    eventKey:  v.string(),
    tileIndex: v.number(),
  },
  handler: async (ctx, { eventKey, tileIndex }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const round = await openGame(ctx, userId, eventKey, "crossy");
    if (!round) throw new Error("No game in progress");

    const config = CROSSY_DIFFICULTIES[round.difficulty ?? ""];
    if (!config) throw new Error("Invalid difficulty");

    const currentRow = round.rowsCleared ?? 0;
    if (currentRow >= CROSSY_MAX_ROWS) throw new Error("Round already complete — cash out");
    if (!Number.isInteger(tileIndex) || tileIndex < 0 || tileIndex >= config.tilesPerRow) {
      throw new Error("Invalid tile index");
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
    const bal = await getOrCreateBalanceRow(ctx, userId, eventKey);
    const crossyBoost = await getBoostForUser(ctx, userId, eventKey, bal.balance);
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

    if (hitTrap) {
      const newBalance = await loseRound(ctx, userId, eventKey, round._id, round.betAmount);
      return {
        safe: false,
        trapIndices,
        multiplier: crossyMultiplier(currentRow, config.baseMultiplier),
        payout: 0,
        newBalance,
        gameOver: true,
      };
    }

    const rowsCleared = currentRow + 1;
    const multiplier = crossyMultiplier(rowsCleared, config.baseMultiplier);
    await ctx.db.patch(round._id, { rowsCleared, multiplier });

    return {
      safe: true,
      trapIndices,
      multiplier,
      payout: Math.floor(round.betAmount * multiplier),
      newBalance: bal.balance,
      // At max rows the round stops accepting steps; the client cashes out.
      gameOver: rowsCleared >= CROSSY_MAX_ROWS,
    };
  },
});

/**
 * Cash out the open Chicken Cross round at the server-held multiplier.
 * Takes no stake or multiplier — both come from the round.
 */
export const crossyCashOut = mutation({
  args: { eventKey: v.string() },
  handler: async (ctx, { eventKey }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    // Row 0 is the free hook row; cashing out there would pay 1x for nothing.
    return await settleRound(ctx, userId, eventKey, "crossy", 1);
  },
});

// ── Mines ─────────────────────────────────────────────────────────────────────

const MINES_TILES = 25;
/** House edge applied to the fair combinatorial multiplier. */
const MINES_HOUSE_EDGE = 0.97;

function combination(n: number, k: number): number {
  if (k > n || k < 0) return 0;
  if (k === 0 || k === n) return 1;
  let result = 1;
  for (let i = 0; i < k; i++) {
    result = result * (n - i) / (i + 1);
  }
  return result;
}

/**
 * Cash-out multiplier after `gemsRevealed` safe tiles.
 *
 * Guarded against gemsRevealed exceeding the number of safe tiles: the
 * denominator is then 0 and the raw formula yields Infinity, which used to be
 * written straight into the balance row and left it permanently unusable.
 * The reveal path can no longer produce that state, but the guard keeps a bad
 * multiplier from ever reaching a balance again.
 */
function minesMultiplier(mineCount: number, gemsRevealed: number): number {
  const safeTotal = MINES_TILES - mineCount;
  if (gemsRevealed <= 0) return 1;
  if (gemsRevealed > safeTotal) return 1;
  const raw =
    MINES_HOUSE_EDGE * combination(MINES_TILES, gemsRevealed) / combination(safeTotal, gemsRevealed);
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return parseFloat(raw.toFixed(2));
}

/**
 * Begin a Mines round. The board is dealt here, with the server's own
 * randomness — mine positions used to be derived from a client-supplied
 * `gameSeed`, so losing a round revealed the layout and replaying the same
 * seed walked the safe path to the top multiplier.
 */
export const minesStart = mutation({
  args: {
    eventKey:  v.string(),
    betAmount: v.number(),
    mineCount: v.number(),
  },
  handler: async (ctx, { eventKey, betAmount, mineCount }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    if (!Number.isInteger(mineCount) || mineCount < 1 || mineCount > 24) {
      throw new Error("Mine count must be a whole number from 1 to 24");
    }

    // Fisher-Yates over the 25 tiles; take the first mineCount as mines.
    const indices = Array.from({ length: MINES_TILES }, (_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }

    const newBalance = await startRound(ctx, userId, eventKey, "mines", betAmount, {
      mineCount,
      minePositions: indices.slice(0, mineCount),
      revealed: [],
    });
    return { newBalance };
  },
});

/** Reveal one tile of the open Mines round. */
export const minesReveal = mutation({
  args: {
    eventKey:  v.string(),
    tileIndex: v.number(),
  },
  handler: async (ctx, { eventKey, tileIndex }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const round = await openGame(ctx, userId, eventKey, "mines");
    if (!round) throw new Error("No game in progress");

    if (!Number.isInteger(tileIndex) || tileIndex < 0 || tileIndex >= MINES_TILES) {
      throw new Error("Invalid tile index");
    }

    const minePositions = round.minePositions ?? [];
    const revealed      = round.revealed ?? [];
    const mineCount     = round.mineCount ?? minePositions.length;
    if (revealed.includes(tileIndex)) throw new Error("Tile already revealed");

    // ── Retention mercy: chance to save player from mine ────────────────────
    const bal = await getOrCreateBalanceRow(ctx, userId, eventKey);
    const minesBoost = await getBoostForUser(ctx, userId, eventKey, bal.balance);
    let hitMine = minePositions.includes(tileIndex);
    if (minesBoost > 0 && hitMine) {
      const mercyChance = [0, 0.15, 0.25, 0.40][minesBoost];
      // Move the mine to a tile the player has not touched, so the board stays
      // consistent for the rest of the round.
      if (Math.random() < mercyChance) {
        const free = Array.from({ length: MINES_TILES }, (_, i) => i).filter(
          (i) => i !== tileIndex && !revealed.includes(i) && !minePositions.includes(i)
        );
        if (free.length > 0) {
          minePositions[minePositions.indexOf(tileIndex)] =
            free[Math.floor(Math.random() * free.length)];
          hitMine = false;
        }
      }
    }

    if (hitMine) {
      const newBalance = await loseRound(ctx, userId, eventKey, round._id, round.betAmount);
      return {
        safe: false,
        minePositions,
        multiplier: minesMultiplier(mineCount, revealed.length),
        payout: 0,
        newBalance,
        gameOver: true,
      };
    }

    const nextRevealed = [...revealed, tileIndex];
    const multiplier   = minesMultiplier(mineCount, nextRevealed.length);
    const allGemsRevealed = nextRevealed.length >= MINES_TILES - mineCount;

    await ctx.db.patch(round._id, {
      revealed: nextRevealed,
      minePositions,
      multiplier,
    });

    return {
      safe: true,
      // Only give the layout away once the round is over.
      minePositions: allGemsRevealed ? minePositions : [],
      multiplier,
      payout: Math.floor(round.betAmount * multiplier),
      newBalance: bal.balance,
      gameOver: allGemsRevealed,
    };
  },
});

/**
 * Cash out the open Mines round at the server-held multiplier.
 * Takes no stake or multiplier — both come from the round.
 */
export const minesCashOut = mutation({
  args: { eventKey: v.string() },
  handler: async (ctx, { eventKey }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    return await settleRound(ctx, userId, eventKey, "mines", 1);
  },
});
