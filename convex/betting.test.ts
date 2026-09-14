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
      options: [
        { id: "red", label: "Red", seedPool: 100 },
        { id: "blue", label: "Blue", seedPool: 100 },
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

describe("resolveMarket payouts", () => {
  test("the pool is conserved — winners are paid from seed + losing bets", async () => {
    const t = convexTest(schema, modules);
    const { as, marketId, bal } = await setup(t, 1000);

    await as.mutation(api.betting.placeBet, { marketId, optionId: "red", amount: 200 });
    expect(await bal()).toBe(800);

    const res = await as.mutation(api.betting.resolveMarket, {
      marketId, resolvedOptionId: "red",
    });

    // totalPool = seeds(200) + bets(200) = 400; winPool = seed_red(100) + 200 = 300
    // payout = floor(200/300 * 400) = 266
    expect(res.totalPool).toBe(400);
    expect(await bal()).toBe(800 + 266);
  });
});

describe("createMarket new FRC-outcome types", () => {
  test("accepts team_top_rank, alliance_selection, and elimination_advance", async () => {
    const t = convexTest(schema, modules);
    const { as } = await setup(t);

    for (const type of ["team_top_rank", "alliance_selection", "elimination_advance"] as const) {
      const marketId = await as.mutation(api.betting.createMarket, {
        eventKey: EVENT,
        title: `Test ${type}`,
        type,
        teamNumber: 4099,
        ...(type === "team_top_rank" ? { threshold: 8 } : {}),
        ...(type === "elimination_advance" ? { targetValue: "semifinals" } : {}),
        options: [
          { id: "yes", label: "Yes", seedPool: 50 },
          { id: "no", label: "No", seedPool: 50 },
        ],
      });
      const market = await t.run((ctx) => ctx.db.get(marketId));
      expect(market?.type).toBe(type);
    }
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
