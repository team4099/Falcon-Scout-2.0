/**
 * FalconBet economy invariants.
 *
 * Two audit findings live here: cancelMarket refunding twice (coins minted from
 * nothing) and beg having no server-side cooldown (unlimited coins).
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const EVENT = "2025chcmp";

async function setup(t: ReturnType<typeof convexTest>, balance = 1000) {
  const userId = await t.run(async (ctx) => ctx.db.insert("users", { name: "Bettor" }));
  // Also carries an admin-allowlisted email (see convex/adminAuth.ts) so this
  // same fixture can exercise both bettor actions and the admin-only market
  // lifecycle calls (cancelMarket/resolveMarket) below.
  const as = t.withIdentity({ subject: userId, issuer: "test", email: "czhao@team4099.com" });
  const marketId = await t.run(async (ctx) => {
    await ctx.db.insert("userBalances", {
      userId, eventKey: EVENT, balance,
      totalWon: 0, totalLost: 0, totalBet: 0, totalBegs: 0,
    });
    return ctx.db.insert("bettingMarkets", {
      eventKey: EVENT, title: "Q1", type: "match_winner",
      // Red is the 40% underdog, so it pays 2.5x and Blue pays 1.67x. Keeping
      // them asymmetric is what proves the multiplier is read per option.
      options: [
        { id: "red", label: "Red", winProb: 40, seedPool: 40 },
        { id: "blue", label: "Blue", winProb: 60, seedPool: 60 },
      ],
      status: "open", createdAt: Date.now(),
    });
  });
  const bal = async () =>
    t.run(async (ctx) =>
      (await ctx.db
        .query("userBalances")
        .withIndex("by_user_event", (q) => q.eq("userId", userId).eq("eventKey", EVENT))
        .first())?.balance,
    );
  const txns = async () =>
    t.run(async (ctx) =>
      ctx.db
        .query("coinTransactions")
        .withIndex("by_user_event", (q) => q.eq("userId", userId).eq("eventKey", EVENT))
        .collect(),
    );
  return { userId, as, marketId, bal, txns };
}

describe("cancelMarket", () => {
  test("refunds exactly once, no matter how many times it is called", async () => {
    const t = convexTest(schema, modules);
    const { as, marketId, bal } = await setup(t, 1000);

    await as.mutation(api.betting.placeBet, { marketId, optionId: "red", amount: 300 });
    expect(await bal()).toBe(700);

    await as.mutation(api.betting.cancelMarket, { marketId });
    expect(await bal()).toBe(1000);

    // Second call used to credit every bet again — minting 300 coins.
    await expect(
      as.mutation(api.betting.cancelMarket, { marketId }),
    ).rejects.toThrow(/already cancelled/i);
    expect(await bal()).toBe(1000);
  });

  test("a resolved market cannot then be cancelled", async () => {
    const t = convexTest(schema, modules);
    const { as, marketId, bal } = await setup(t, 1000);
    await as.mutation(api.betting.placeBet, { marketId, optionId: "red", amount: 100 });
    await as.mutation(api.betting.resolveMarket, {
      marketId, resolvedOptionId: "red",
    });
    const afterResolve = await bal();
    await expect(
      as.mutation(api.betting.cancelMarket, { marketId }),
    ).rejects.toThrow(/already resolved/i);
    expect(await bal()).toBe(afterResolve);
  });
});

describe("placeBet", () => {
  test("rejects fractional amounts", async () => {
    const t = convexTest(schema, modules);
    const { as, marketId } = await setup(t);
    await expect(
      as.mutation(api.betting.placeBet, { marketId, optionId: "red", amount: 10.5 }),
    ).rejects.toThrow(/whole number/i);
  });

  test("still enforces the minimum and the balance", async () => {
    const t = convexTest(schema, modules);
    const { as, marketId } = await setup(t, 50);
    await expect(
      as.mutation(api.betting.placeBet, { marketId, optionId: "red", amount: 5 }),
    ).rejects.toThrow(/Minimum bet/i);
    await expect(
      as.mutation(api.betting.placeBet, { marketId, optionId: "red", amount: 500 }),
    ).rejects.toThrow(/Insufficient balance/i);
  });
});

// Begging was nerfed to 1 coin on a 60s cooldown so that scouting, not
// gambling or begging, is the way to earn. Kept as a constant so the intent of
// these tests survives future rebalancing.
const BEG_AMOUNT = 1;

describe("beg", () => {
  test("cannot be looped to mint unlimited coins", async () => {
    const t = convexTest(schema, modules);
    const { as, bal } = await setup(t, 0);

    await as.mutation(api.betting.beg, { eventKey: EVENT });
    expect(await bal()).toBe(BEG_AMOUNT);

    // The 3s cooldown used to live only in the UI, so a scripted loop was free
    // money. Ten rapid calls should all be refused.
    for (let i = 0; i < 10; i++) {
      await expect(as.mutation(api.betting.beg, { eventKey: EVENT }))
        .rejects.toThrow(/Slow down/i);
    }
    expect(await bal()).toBe(BEG_AMOUNT);
  });

  test("works again once the cooldown has elapsed", async () => {
    const t = convexTest(schema, modules);
    const { userId, as, bal } = await setup(t, 0);
    await as.mutation(api.betting.beg, { eventKey: EVENT });

    // Wind the clock back rather than sleeping.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("userBalances")
        .withIndex("by_user_event", (q) => q.eq("userId", userId).eq("eventKey", EVENT))
        .first();
      if (row) await ctx.db.patch(row._id, { lastBegAt: Date.now() - 120_000 });
    });

    await as.mutation(api.betting.beg, { eventKey: EVENT });
    expect(await bal()).toBe(BEG_AMOUNT * 2);
  });
});

describe("fixed odds", () => {
  test("payout comes from the multiplier locked in at placement", async () => {
    const t = convexTest(schema, modules);
    const { as, marketId, bal } = await setup(t, 1000);

    // Red is seeded at 40% -> 100/40 = 2.50x.
    await as.mutation(api.betting.placeBet, { marketId, optionId: "red", amount: 200 });
    expect(await bal()).toBe(800);

    const bet = await t.run(async (ctx) =>
      (await ctx.db.query("bets").withIndex("by_market", (q) => q.eq("marketId", marketId)).first())!,
    );
    expect(bet.multiplier).toBe(2.5);

    const res = await as.mutation(api.betting.resolveMarket, {
      marketId, resolvedOptionId: "red",
    });
    // floor(200 * 2.5) = 500 credited on top of the already-deducted stake.
    expect(res.totalPaid).toBe(500);
    expect(await bal()).toBe(800 + 500);
  });

  test("the favourite pays less than the underdog on the same stake", async () => {
    const t = convexTest(schema, modules);
    const { as, marketId, bal } = await setup(t, 1000);

    // Blue is seeded at 60% -> 100/60 = 1.67x.
    await as.mutation(api.betting.placeBet, { marketId, optionId: "blue", amount: 300 });
    await as.mutation(api.betting.resolveMarket, { marketId, resolvedOptionId: "blue" });
    // floor(300 * 1.67) = 501
    expect(await bal()).toBe(700 + 501);
  });

  test("a later bet cannot move an earlier bet's payout", async () => {
    const t = convexTest(schema, modules);
    const { as, marketId, bal } = await setup(t, 1000);

    await as.mutation(api.betting.placeBet, { marketId, optionId: "red", amount: 100 });

    // A second scout piles onto the same side. Under the old parimutuel payout
    // this diluted the first bet; with fixed odds it must change nothing.
    const other = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", { name: "Other" });
      await ctx.db.insert("userBalances", {
        userId: uid, eventKey: EVENT, balance: 5000,
        totalWon: 0, totalLost: 0, totalBet: 0, totalBegs: 0,
      });
      return uid;
    });
    await t
      // Team email so this second scout clears the approval check in adminAuth.
      .withIdentity({ subject: other, issuer: "test", email: "scout@team4099.com" })
      .mutation(api.betting.placeBet, { marketId, optionId: "red", amount: 4000 });

    await as.mutation(api.betting.resolveMarket, { marketId, resolvedOptionId: "red" });
    // Still floor(100 * 2.5) = 250.
    expect(await bal()).toBe(900 + 250);
  });

  test("losing bets pay nothing and are not re-charged", async () => {
    const t = convexTest(schema, modules);
    const { as, marketId, bal } = await setup(t, 1000);

    await as.mutation(api.betting.placeBet, { marketId, optionId: "red", amount: 250 });
    await as.mutation(api.betting.resolveMarket, { marketId, resolvedOptionId: "blue" });
    // The stake left the balance at placement; resolution must not deduct again.
    expect(await bal()).toBe(750);
  });
});

describe("one bet per match", () => {
  test("a second bet on the same market is rejected", async () => {
    const t = convexTest(schema, modules);
    const { as, marketId, bal } = await setup(t, 1000);

    await as.mutation(api.betting.placeBet, { marketId, optionId: "red", amount: 100 });
    await expect(
      as.mutation(api.betting.placeBet, { marketId, optionId: "red", amount: 100 }),
    ).rejects.toThrow(/already bet/i);
    // Nothing extra left the balance.
    expect(await bal()).toBe(900);
  });

  test("a scout cannot hedge by also betting the other alliance", async () => {
    const t = convexTest(schema, modules);
    const { as, marketId } = await setup(t, 1000);

    await as.mutation(api.betting.placeBet, { marketId, optionId: "red", amount: 100 });
    await expect(
      as.mutation(api.betting.placeBet, { marketId, optionId: "blue", amount: 100 }),
    ).rejects.toThrow(/already bet/i);

    const count = await t.run(async (ctx) =>
      (await ctx.db.query("bets").withIndex("by_market", (q) => q.eq("marketId", marketId)).collect()).length,
    );
    expect(count).toBe(1);
  });

  test("the limit is per market, not per event", async () => {
    const t = convexTest(schema, modules);
    const { as, marketId, userId } = await setup(t, 1000);

    const secondMarket = await t.run((ctx) =>
      ctx.db.insert("bettingMarkets", {
        eventKey: EVENT, title: "Q2", type: "match_winner",
        matchNumber: 2,
        options: [
          { id: "red", label: "Red", winProb: 50, seedPool: 50 },
          { id: "blue", label: "Blue", winProb: 50, seedPool: 50 },
        ],
        status: "open", createdAt: Date.now(),
      }),
    );

    await as.mutation(api.betting.placeBet, { marketId, optionId: "red", amount: 100 });
    await as.mutation(api.betting.placeBet, { marketId: secondMarket, optionId: "blue", amount: 100 });

    const mine = await t.run(async (ctx) =>
      ctx.db.query("bets").withIndex("by_user_event", (q) =>
        q.eq("userId", userId).eq("eventKey", EVENT)).collect(),
    );
    expect(mine).toHaveLength(2);
  });
});

describe("batchCreateMatchWinnerMarkets", () => {
  test("seeds win probabilities and skips matches that already have a market", async () => {
    const t = convexTest(schema, modules);
    const { as } = await setup(t);

    const matches = [
      { matchNumber: 10, matchLabel: "Q10", winRed: 70, winBlue: 30 },
      { matchNumber: 11, matchLabel: "Q11", winRed: 25, winBlue: 75 },
    ];
    expect((await as.mutation(api.betting.batchCreateMatchWinnerMarkets, {
      eventKey: EVENT, matches,
    })).created).toBe(2);

    // Re-running must not duplicate them.
    expect((await as.mutation(api.betting.batchCreateMatchWinnerMarkets, {
      eventKey: EVENT, matches,
    })).created).toBe(0);

    const q10 = await t.run(async (ctx) =>
      (await ctx.db.query("bettingMarkets")
        .withIndex("by_event_match", (q) => q.eq("eventKey", EVENT).eq("matchNumber", 10))
        .first())!,
    );
    expect(q10.options.map((o) => o.winProb)).toEqual([70, 30]);
  });

  test("an out-of-range probability is clamped, not written as 0%", async () => {
    const t = convexTest(schema, modules);
    const { as } = await setup(t);

    await as.mutation(api.betting.batchCreateMatchWinnerMarkets, {
      eventKey: EVENT,
      matches: [{ matchNumber: 20, matchLabel: "Q20", winRed: 0, winBlue: 100 }],
    });

    const m = await t.run(async (ctx) =>
      (await ctx.db.query("bettingMarkets")
        .withIndex("by_event_match", (q) => q.eq("eventKey", EVENT).eq("matchNumber", 20))
        .first())!,
    );
    expect(m.options.map((o) => o.winProb)).toEqual([1, 99]);

    // 1% would pay 100x unclamped; the cap holds it at 10x.
    await as.mutation(api.betting.placeBet, { marketId: m._id, optionId: "red", amount: 10 });
    const bet = await t.run(async (ctx) =>
      (await ctx.db.query("bets").withIndex("by_market", (q) => q.eq("marketId", m._id)).first())!,
    );
    expect(bet.multiplier).toBe(10);
  });
});

describe("listMarkets", () => {
  test("hides legacy markets of the removed types", async () => {
    const t = convexTest(schema, modules);
    const { as, marketId } = await setup(t);

    await t.run((ctx) =>
      ctx.db.insert("bettingMarkets", {
        eventKey: EVENT, title: "Legacy O/U", type: "team_field_numeric",
        threshold: 5,
        options: [
          { id: "over", label: "Over", seedPool: 50 },
          { id: "under", label: "Under", seedPool: 50 },
        ],
        status: "open", createdAt: Date.now(),
      }),
    );

    const listed = await as.query(api.betting.listMarkets, { eventKey: EVENT });
    expect(listed.map((m) => m._id)).toEqual([marketId]);
  });
});

describe("coin transaction ledger", () => {
  test("placeBet logs a bet_placed entry; resolveMarket logs bet_won only for the winner", async () => {
    const t = convexTest(schema, modules);
    const { as, marketId, txns } = await setup(t, 1000);

    await as.mutation(api.betting.placeBet, { marketId, optionId: "red", amount: 200 });
    let rows = await txns();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "bet_placed", amount: -200 });

    await as.mutation(api.betting.resolveMarket, { marketId, resolvedOptionId: "red" });
    rows = await txns();
    expect(rows).toHaveLength(2);
    const won = rows.find((r) => r.type === "bet_won");
    expect(won).toBeTruthy();
    expect(won!.amount).toBeGreaterThan(0);
  });

  test("resolveMarket logs no entry for a losing bet beyond its bet_placed row", async () => {
    const t = convexTest(schema, modules);
    const { as, marketId, txns } = await setup(t, 1000);

    await as.mutation(api.betting.placeBet, { marketId, optionId: "blue", amount: 100 });
    await as.mutation(api.betting.resolveMarket, { marketId, resolvedOptionId: "red" });

    const rows = await txns();
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("bet_placed");
  });

  test("cancelMarket logs a bet_refunded entry", async () => {
    const t = convexTest(schema, modules);
    const { as, marketId, txns } = await setup(t, 1000);

    await as.mutation(api.betting.placeBet, { marketId, optionId: "red", amount: 150 });
    await as.mutation(api.betting.cancelMarket, { marketId });

    const rows = await txns();
    const refund = rows.find((r) => r.type === "bet_refunded");
    expect(refund).toMatchObject({ amount: 150 });
  });

  test("beg logs a beg entry", async () => {
    const t = convexTest(schema, modules);
    const { as, txns } = await setup(t, 0);

    await as.mutation(api.betting.beg, { eventKey: EVENT });
    const rows = await txns();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "beg", amount: 1 });
  });
});
