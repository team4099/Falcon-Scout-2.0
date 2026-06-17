import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

const STARTING_BALANCE = 1000;

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
export const beg = mutation({
  args: { eventKey: v.string() },
  handler: async (ctx, { eventKey }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    let bal = await ctx.db
      .query("userBalances")
      .withIndex("by_user_event", (q) => q.eq("userId", userId).eq("eventKey", eventKey))
      .first();

    if (!bal) {
      await ctx.db.insert("userBalances", {
        userId,
        eventKey,
        balance:   STARTING_BALANCE + 10,
        totalWon:  0,
        totalLost: 0,
        totalBet:  0,
        totalBegs: 1,
      });
      return { newBalance: STARTING_BALANCE + 10, totalBegs: 1 };
    }

    await ctx.db.patch(bal._id, {
      balance:   bal.balance + 10,
      totalBegs: (bal.totalBegs ?? 0) + 1,
    });
    return { newBalance: bal.balance + 10, totalBegs: (bal.totalBegs ?? 0) + 1 };
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
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

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
  },
  handler: async (ctx, { eventKey, limit, matches }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

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
          description: `Statbotics predicted win probability: 🔴 ${m.seedRed}% · 🔵 ${m.seedBlue}%`,
          type:        "match_winner",
          matchNumber: m.matchNumber,
          options: [
            { id: "red",  label: "🔴 Red Alliance",  seedPool: m.seedRed  },
            { id: "blue", label: "🔵 Blue Alliance", seedPool: m.seedBlue },
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
  },
  handler: async (ctx, { eventKey, matches }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

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
          { id: "red",  label: "🔴 Red Alliance",  seedPool: m.seedRed  },
          { id: "blue", label: "🔵 Blue Alliance", seedPool: m.seedBlue },
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
  args: { marketId: v.id("bettingMarkets") },
  handler: async (ctx, { marketId }) => {
    await getAuthUserId(ctx);
    await ctx.db.patch(marketId, { status: "locked" });
  },
});

/** Unlock a market back to open. */
export const unlockMarket = mutation({
  args: { marketId: v.id("bettingMarkets") },
  handler: async (ctx, { marketId }) => {
    await getAuthUserId(ctx);
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
  },
  handler: async (ctx, { marketId, resolvedOptionId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

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

    // ── Penalty: deduct coins from users who skipped this market ──────────────
    const bettedUserIds = new Set(allBets.map((b) => b.userId));

    const allBalances = await ctx.db.query("userBalances").collect();
    const eventBalances = allBalances.filter((b) => b.eventKey === market.eventKey);

    for (const bal of eventBalances) {
      if (bettedUserIds.has(bal.userId)) continue; // they bet — no penalty
      const penalty = Math.round(bal.balance * 0.10); // 10% of current balance
      if (penalty <= 0) continue;
      await ctx.db.patch(bal._id, {
        balance:        bal.balance - penalty,
        totalLost:      bal.totalLost + penalty,
        totalPenalties: (bal.totalPenalties ?? 0) + penalty,
      });
    }

    // Mark market resolved
    await ctx.db.patch(marketId, {
      status:           "resolved",
      resolvedOptionId,
      resolvedAt:       Date.now(),
    });

    return { settledBets: allBets.length, totalPool, penalised: eventBalances.length - bettedUserIds.size };
  },
});

/**
 * Cancel a market and refund all bets.
 */
export const cancelMarket = mutation({
  args: { marketId: v.id("bettingMarkets") },
  handler: async (ctx, { marketId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const market = await ctx.db.get(marketId);
    if (!market) throw new Error("Market not found");
    if (market.status === "resolved") throw new Error("Market already resolved");

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

    return enriched.sort(
      (a, b) => (b.totalWon - b.totalLost) - (a.totalWon - a.totalLost)
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
  args: { eventKey: v.string() },
  handler: async (ctx, { eventKey }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

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
