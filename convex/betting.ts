import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { getApprovedUserId, isSignedIn, requireAdmin } from "./adminAuth";

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

// ── Fixed odds ────────────────────────────────────────────────────────────────

/**
 * Payout multipliers are FIXED at placement, not computed from the pool at
 * resolution. A market stores each option's Statbotics win probability, and the
 * fair multiplier is its reciprocal: a 25%-likely alliance pays 4x, a 75%
 * favourite pays 1.33x. Nobody else's bet can move what your bet pays.
 *
 * The clamp exists because win probabilities are seeded 1-99, and an
 * unclamped 1% would pay 100x — one lucky coin flip would end the leaderboard.
 */
const MIN_MULTIPLIER = 1.05;
const MAX_MULTIPLIER = 10;

/** Multiplier for a win probability given in percent (1-99). Total return, stake included. */
export function multiplierFor(winProbPct: number): number {
  if (!Number.isFinite(winProbPct) || winProbPct <= 0) return MAX_MULTIPLIER;
  const raw = 100 / winProbPct;
  const clamped = Math.min(MAX_MULTIPLIER, Math.max(MIN_MULTIPLIER, raw));
  return Math.round(clamped * 100) / 100;
}

/**
 * The win probability an option was created with. `winProb` is the field that
 * means this; `seedPool` is the pre-fixed-odds name that happened to hold the
 * same percentage for match_winner markets.
 */
export function optionWinProb(option: { winProb?: number; seedPool: number }): number {
  return option.winProb ?? option.seedPool;
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
    const userId = await getApprovedUserId(ctx);
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
    const userId = await getApprovedUserId(ctx);
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
    const userId = await getApprovedUserId(ctx);
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
    const userId = await getApprovedUserId(ctx);
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

/**
 * Match-winner markets for an event, optionally filtered by status.
 *
 * Legacy markets of the ten removed types are filtered out rather than
 * deleted: their rows and bets stay intact for the ledger, they just no longer
 * appear anywhere a scout can bet on them.
 */
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
    const all = (await ctx.db
      .query("bettingMarkets")
      .withIndex("by_event", (q) => q.eq("eventKey", eventKey))
      .collect()
    ).filter((m) => m.type === "match_winner");
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

/**
 * Batch-create one match_winner market per TBA match, seeded with Statbotics
 * win probabilities. This is the only way markets are created: FalconBet was
 * simplified to a single question — which alliance wins this match?
 *
 * `winRed`/`winBlue` are percentages (1-99) that sum to 100, computed from EPA
 * on the client and passed in by an admin. They fix the payout multipliers for
 * every bet placed on the market, so they are written once and never updated.
 * Matches that already have a market are skipped.
 */
export const batchCreateMatchWinnerMarkets = mutation({
  args: {
    eventKey: v.string(),
    limit:    v.optional(v.number()), // max markets to create (default: unlimited)
    matches: v.array(v.object({
      matchNumber: v.number(),
      matchLabel:  v.string(),
      winRed:      v.number(), // 1-99
      winBlue:     v.number(), // 1-99, = 100 - winRed
    })),
    adminKey: v.optional(v.string()),
  },
  handler: async (ctx, { eventKey, limit, matches, adminKey }) => {
    const userId = await requireAdmin(ctx, adminKey);

    const existing = await ctx.db
      .query("bettingMarkets")
      .withIndex("by_event", (q) => q.eq("eventKey", eventKey))
      .collect();
    const existingByMatch = new Map(
      existing.filter((m) => m.type === "match_winner").map((m) => [m.matchNumber, m])
    );

    let created = 0;
    let refreshed = 0;
    for (const m of matches) {
      // Clamp here too: a bad EPA fetch upstream must not write a 0% option,
      // which would hand out the maximum multiplier on a coin flip.
      const winRed  = Math.max(1, Math.min(99, Math.round(m.winRed)));
      const winBlue = 100 - winRed;
      const description =
        `Statbotics predicts Red ${winRed}% · Blue ${winBlue}%. ` +
        `Pays ${multiplierFor(winRed).toFixed(2)}x on Red, ` +
        `${multiplierFor(winBlue).toFixed(2)}x on Blue.`;
      const options = [
        { id: "red",  label: "Red Alliance",  winProb: winRed,  seedPool: winRed  },
        { id: "blue", label: "Blue Alliance", winProb: winBlue, seedPool: winBlue },
      ];

      const prior = existingByMatch.get(m.matchNumber);
      if (prior) {
        // Re-derive odds only for a market nobody has bet on yet: a placed bet
        // has its multiplier locked already, and the market must not shift
        // under the players who read the old odds. This is what lets a market
        // seeded from a bad/missing EPA fetch (all 50/50) be fixed in place
        // instead of wiping the event's bets and balances.
        if (prior.status !== "open" || prior.options[0]?.winProb === winRed) continue;
        const hasBet = await ctx.db
          .query("bets")
          .withIndex("by_market", (q) => q.eq("marketId", prior._id))
          .first();
        if (hasBet) continue;
        await ctx.db.patch(prior._id, { description, options });
        refreshed++;
        continue;
      }

      if (limit !== undefined && created >= limit) continue;
      await ctx.db.insert("bettingMarkets", {
        eventKey,
        title:       `${m.matchLabel} — Match Winner`,
        description,
        type:        "match_winner",
        matchNumber: m.matchNumber,
        options,
        status:    "open",
        createdAt: Date.now(),
        createdBy: userId,
      });
      created++;
    }
    return { created, refreshed };
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
 * Resolve a market with a winning outcome and settle every bet on it.
 *
 * Fixed odds: each bet pays `floor(stake × multiplier)` using the multiplier
 * frozen when it was placed, so resolution is pure bookkeeping. It does not
 * look at the pool, and one scout's bet never changes another's payout. Losers
 * get nothing; their stake already left the balance at placement.
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

    const winnerOption = market.options.find((o) => o.id === resolvedOptionId);
    if (!winnerOption) throw new Error("Unknown winning option");

    // Legacy bets placed before fixed odds carry no multiplier. Rather than keep
    // the whole parimutuel code path alive for them, they settle at even money.
    const fallbackMultiplier = 2;

    let totalPaid = 0;

    // Settle each winning bet
    for (const bet of allBets) {
      const won = bet.optionId === resolvedOptionId;
      const payout = won
        ? Math.floor(bet.amount * (bet.multiplier ?? fallbackMultiplier))
        : 0;
      totalPaid += payout;

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

    return { settledBets: allBets.length, totalPaid };
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
 *
 * One bet per user per market, final. Because each match has exactly one
 * match_winner market, that is one bet per match: it cannot be raised, reduced,
 * switched to the other alliance, or retracted. The stake leaves the balance
 * immediately and the payout multiplier is frozen here from the market's
 * Statbotics win probability — never from anything the client sends.
 */
export const placeBet = mutation({
  args: {
    marketId: v.id("bettingMarkets"),
    optionId: v.string(),
    amount:   v.number(),
  },
  handler: async (ctx, { marketId, optionId, amount }) => {
    const userId = await getApprovedUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    assertBet(amount);

    const market = await ctx.db.get(marketId);
    if (!market) throw new Error("Market not found");
    if (market.status !== "open") throw new Error("Market is not open for betting");

    const validOption = market.options.find((o) => o.id === optionId);
    if (!validOption) throw new Error("Invalid option");

    // One bet per match, enforced here rather than by hiding the panel — a
    // second submission from a stale client must be rejected by the server.
    const existing = await ctx.db
      .query("bets")
      .withIndex("by_market_user", (q) => q.eq("marketId", marketId).eq("userId", userId))
      .first();
    if (existing) {
      throw new Error("You already bet on this match — bets can't be changed or added to");
    }

    // Odds are read off the market, so they are whatever the admin's Statbotics
    // seed said at creation. A client cannot propose its own multiplier.
    const multiplier = multiplierFor(optionWinProb(validOption));

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
      multiplier,
      eventKey: market.eventKey,
      placedAt: Date.now(),
    });
  },
});

/** All bets placed by the current user at an event. */
export const listMyBets = query({
  args: { eventKey: v.string() },
  handler: async (ctx, { eventKey }) => {
    const userId = await getApprovedUserId(ctx);
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
