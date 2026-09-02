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

const DEFAULT_HASH =
  "8f0e2f76e22b43e2855189877e7dc1e1e7d98c226c95db247cd1d547928334a9";
const modules = import.meta.glob("./**/*.ts");
const EVENT = "2025chcmp";

async function setup(t: ReturnType<typeof convexTest>, balance = 1000) {
  const userId = await t.run(async (ctx) => ctx.db.insert("users", { name: "Bettor" }));
  const as = t.withIdentity({ subject: userId, issuer: "test" });
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
  return { userId, as, marketId, bal };
}

describe("cancelMarket", () => {
  test("refunds exactly once, no matter how many times it is called", async () => {
    const t = convexTest(schema, modules);
    const { as, marketId, bal } = await setup(t, 1000);

    await as.mutation(api.betting.placeBet, { marketId, optionId: "red", amount: 300 });
    expect(await bal()).toBe(700);

    await as.mutation(api.betting.cancelMarket, { marketId, adminKey: DEFAULT_HASH });
    expect(await bal()).toBe(1000);

    // Second call used to credit every bet again — minting 300 coins.
    await expect(
      as.mutation(api.betting.cancelMarket, { marketId, adminKey: DEFAULT_HASH }),
    ).rejects.toThrow(/already cancelled/i);
    expect(await bal()).toBe(1000);
  });

  test("a resolved market cannot then be cancelled", async () => {
    const t = convexTest(schema, modules);
    const { as, marketId, bal } = await setup(t, 1000);
    await as.mutation(api.betting.placeBet, { marketId, optionId: "red", amount: 100 });
    await as.mutation(api.betting.resolveMarket, {
      marketId, resolvedOptionId: "red", adminKey: DEFAULT_HASH,
    });
    const afterResolve = await bal();
    await expect(
      as.mutation(api.betting.cancelMarket, { marketId, adminKey: DEFAULT_HASH }),
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

describe("beg", () => {
  test("cannot be looped to mint unlimited coins", async () => {
    const t = convexTest(schema, modules);
    const { as, bal } = await setup(t, 0);

    await as.mutation(api.betting.beg, { eventKey: EVENT });
    expect(await bal()).toBe(10);

    // The 3s cooldown used to live only in the UI, so a scripted loop was free
    // money. Ten rapid calls should all be refused.
    for (let i = 0; i < 10; i++) {
      await expect(as.mutation(api.betting.beg, { eventKey: EVENT }))
        .rejects.toThrow(/Slow down/i);
    }
    expect(await bal()).toBe(10);
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
      if (row) await ctx.db.patch(row._id, { lastBegAt: Date.now() - 10_000 });
    });

    await as.mutation(api.betting.beg, { eventKey: EVENT });
    expect(await bal()).toBe(20);
  });
});

describe("resolveMarket payouts", () => {
  test("the pool is conserved — winners are paid from seed + losing bets", async () => {
    const t = convexTest(schema, modules);
    const { as, marketId, bal } = await setup(t, 1000);

    await as.mutation(api.betting.placeBet, { marketId, optionId: "red", amount: 200 });
    expect(await bal()).toBe(800);

    const res = await as.mutation(api.betting.resolveMarket, {
      marketId, resolvedOptionId: "red", adminKey: DEFAULT_HASH,
    });

    // totalPool = seeds(200) + bets(200) = 400; winPool = seed_red(100) + 200 = 300
    // payout = floor(200/300 * 400) = 266
    expect(res.totalPool).toBe(400);
    expect(await bal()).toBe(800 + 266);
  });
});
