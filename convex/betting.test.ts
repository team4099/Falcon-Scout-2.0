/**
 * FalconBet economy invariants.
 *
 * Two audit findings live here: cancelMarket refunding twice (coins minted from
 * nothing) and beg having no server-side cooldown (unlimited coins).
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { BEG_JACKPOT, BEG_JACKPOT_ODDS, BEG_MAX, BEG_ROB_MAX, rollBeg, rollRobbery } from "./betting";
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

  test("a resolved market cannot be reopened and paid out a second time", async () => {
    const t = convexTest(schema, modules);
    const { as, marketId, bal } = await setup(t, 1000);
    await as.mutation(api.betting.placeBet, { marketId, optionId: "red", amount: 100 });
    await as.mutation(api.betting.resolveMarket, { marketId, resolvedOptionId: "red" });
    const afterResolve = await bal();
    await expect(as.mutation(api.betting.unlockMarket, { marketId })).rejects.toThrow(/locked market/i);
    await expect(as.mutation(api.betting.lockMarket, { marketId })).rejects.toThrow(/open market/i);
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

// Begging mostly pays 1 coin on a 60s cooldown so that scouting, not gambling
// or begging, is the way to earn. Pin Math.random so the server's roll is
// deterministic: 0.5 skips the jackpot and lands in the 1-coin band.
const BEG_AMOUNT = 1;

describe("rollBeg", () => {
  // First draw decides the jackpot, second the payout.
  const draws = (second: number) => { let n = 0; return () => (n++ === 0 ? 0.5 : second); };

  test("maps the payout draw onto 0 / 1 / 2 / 3..BEG_MAX", () => {
    expect(rollBeg(draws(0)).amount).toBe(0);
    expect(rollBeg(draws(0.1499)).amount).toBe(0);
    expect(rollBeg(draws(0.15)).amount).toBe(1);
    expect(rollBeg(draws(0.7999)).amount).toBe(1);
    expect(rollBeg(draws(0.80)).amount).toBe(2);
    expect(rollBeg(draws(0.92)).amount).toBe(3);
    expect(rollBeg(draws(0.9999999))).toEqual({ amount: BEG_MAX, jackpot: false });
  });

  test("mostly pays 1; 3+ is rare", () => {
    const counts = new Map<number, number>();
    const N = 100_000;
    for (let i = 0; i < N; i++) {
      const { amount } = rollBeg();
      counts.set(amount, (counts.get(amount) ?? 0) + 1);
    }
    const share = (pred: (a: number) => boolean) =>
      [...counts].filter(([a]) => pred(a)).reduce((s, [, c]) => s + c, 0) / N;
    expect(share((a) => a === 1)).toBeGreaterThan(0.6);
    expect(share((a) => a >= 3 && a <= BEG_MAX)).toBeLessThan(0.1);
    expect(Math.max(...[...counts.keys()].filter((a) => a !== BEG_JACKPOT))).toBeLessThanOrEqual(BEG_MAX);
  });

  test("jackpot is 1-in-100,000 and pays 100", () => {
    expect(BEG_JACKPOT_ODDS).toBe(1 / 100_000);
    expect(rollBeg(() => 0.000005)).toEqual({ amount: BEG_JACKPOT, jackpot: true });
    expect(rollBeg(() => 0.00001).jackpot).toBe(false);
  });
});

describe("beg", () => {
  beforeEach(() => { vi.spyOn(Math, "random").mockReturnValue(0.5); });
  afterEach(() => { vi.restoreAllMocks(); });

  test("returns the rolled amount and tracks coins begged", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await setup(t, 0);
    const res = await as.mutation(api.betting.beg, { eventKey: EVENT });
    expect(res).toMatchObject({ amount: BEG_AMOUNT, jackpot: false, totalBegs: 1, newBalance: BEG_AMOUNT });
    const row = await t.run((ctx) => ctx.db.query("userBalances")
      .withIndex("by_user_event", (q) => q.eq("userId", userId).eq("eventKey", EVENT)).first());
    expect(row).toMatchObject({ totalBegs: 1, totalBegCoins: BEG_AMOUNT });
  });

  test("jackpot pays 100 and is noted in the ledger", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const t = convexTest(schema, modules);
    const { as, bal, txns } = await setup(t, 0);
    const res = await as.mutation(api.betting.beg, { eventKey: EVENT });
    expect(res).toMatchObject({ amount: BEG_JACKPOT, jackpot: true });
    expect(await bal()).toBe(BEG_JACKPOT);
    expect((await txns())[0]).toMatchObject({ type: "beg", amount: BEG_JACKPOT, note: "JACKPOT" });
  });

  test("cannot be looped to mint unlimited coins", async () => {
    const t = convexTest(schema, modules);
    const { as, bal } = await setup(t, 0);

    await as.mutation(api.betting.beg, { eventKey: EVENT });
    expect(await bal()).toBe(BEG_AMOUNT);

    // The 3s cooldown used to live only in the UI, so a scripted loop was free
    // money. Rapid calls now pay nothing, then start costing coins.
    for (let i = 0; i < 10; i++) {
      const res = await as.mutation(api.betting.beg, { eventKey: EVENT });
      expect(res.amount).toBeLessThanOrEqual(0);
    }
    expect(await bal()).toBe(0);
  });

  test("early begs are ignored twice, then robbed 1-5, never below zero", async () => {
    const t = convexTest(schema, modules);
    const { as, bal, txns } = await setup(t, 4);
    await as.mutation(api.betting.beg, { eventKey: EVENT }); // paid 1 → 5
    const beg = () => as.mutation(api.betting.beg, { eventKey: EVENT });

    expect(await beg()).toMatchObject({ outcome: "ignored", amount: 0 });
    expect(await beg()).toMatchObject({ outcome: "ignored", amount: 0 });
    // Math.random pinned at 0.5 → robbery of 1 + floor(0.5 * 5) = 3.
    expect(await beg()).toMatchObject({ outcome: "robbed", amount: -3, newBalance: 2 });
    expect(await beg()).toMatchObject({ outcome: "robbed", amount: -2, newBalance: 0 });
    expect(await beg()).toMatchObject({ outcome: "robbed", amount: 0, newBalance: 0 });
    expect(await bal()).toBe(0);

    const robs = (await txns()).filter((r) => r.amount < 0);
    expect(robs.map((r) => r.amount).sort()).toEqual([-2, -3]);
    expect(robs.every((r) => r.type === "beg" && r.note === "Robbed while begging")).toBe(true);
  });

  test("rollRobbery stays in 1..5", () => {
    expect(rollRobbery(() => 0)).toBe(1);
    expect(rollRobbery(() => 0.9999999)).toBe(BEG_ROB_MAX);
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

  test("a paid beg resets the strike count", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await setup(t, 0);
    const beg = () => as.mutation(api.betting.beg, { eventKey: EVENT });
    await beg();
    await beg(); await beg(); // two strikes
    await t.run(async (ctx) => {
      const row = await ctx.db.query("userBalances")
        .withIndex("by_user_event", (q) => q.eq("userId", userId).eq("eventKey", EVENT)).first();
      if (row) await ctx.db.patch(row._id, { lastBegAt: Date.now() - 120_000 });
    });
    expect(await beg()).toMatchObject({ outcome: "paid" });
    expect(await beg()).toMatchObject({ outcome: "ignored" });
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

  test("playoff matches all share matchNumber 1 but each get their own market", async () => {
    const t = convexTest(schema, modules);
    const { as } = await setup(t);
    const matches = [
      { matchNumber: 1, matchLabel: "Q1", winRed: 60, winBlue: 40 },
      { matchNumber: 1, matchLabel: "SF7M1", winRed: 55, winBlue: 45 },
      { matchNumber: 1, matchLabel: "SF8M1", winRed: 89, winBlue: 11 },
    ];
    expect((await as.mutation(api.betting.batchCreateMatchWinnerMarkets, {
      eventKey: EVENT, matches,
    })).created).toBe(3);

    // Re-running neither duplicates them nor lets SF odds overwrite Q1's.
    expect(await as.mutation(api.betting.batchCreateMatchWinnerMarkets, {
      eventKey: EVENT, matches,
    })).toEqual({ created: 0, refreshed: 0 });

    const all = await t.run((ctx) => ctx.db.query("bettingMarkets").collect());
    const prob = (title: string) => all.find((m) => m.title === title)!.options[0].winProb;
    expect(prob("Q1 — Match Winner")).toBe(60);
    expect(prob("SF8M1 — Match Winner")).toBe(89);
  });

  test("re-running fixes 50/50 odds on markets with no bets, but never touches one with a bet", async () => {
    const t = convexTest(schema, modules);
    const { as } = await setup(t);
    const flat = [
      { matchNumber: 30, matchLabel: "Q30", winRed: 50, winBlue: 50 },
      { matchNumber: 31, matchLabel: "Q31", winRed: 50, winBlue: 50 },
    ];
    await as.mutation(api.betting.batchCreateMatchWinnerMarkets, { eventKey: EVENT, matches: flat });

    const q31 = await t.run(async (ctx) =>
      (await ctx.db.query("bettingMarkets")
        .withIndex("by_event_match", (q) => q.eq("eventKey", EVENT).eq("matchNumber", 31)).first())!);
    await as.mutation(api.betting.placeBet, { marketId: q31._id, optionId: "red", amount: 10 });

    const real = [
      { matchNumber: 30, matchLabel: "Q30", winRed: 80, winBlue: 20 },
      { matchNumber: 31, matchLabel: "Q31", winRed: 80, winBlue: 20 },
    ];
    expect(await as.mutation(api.betting.batchCreateMatchWinnerMarkets, { eventKey: EVENT, matches: real }))
      .toEqual({ created: 0, refreshed: 1 });

    const probs = async (n: number) => t.run(async (ctx) =>
      (await ctx.db.query("bettingMarkets")
        .withIndex("by_event_match", (q) => q.eq("eventKey", EVENT).eq("matchNumber", n)).first())!
        .options.map((o) => o.winProb));
    expect(await probs(30)).toEqual([80, 20]);
    expect(await probs(31)).toEqual([50, 50]);
  });

  test("refreshMatches fixes odds on existing markets but never creates one", async () => {
    const t = convexTest(schema, modules);
    const { as } = await setup(t);
    await as.mutation(api.betting.batchCreateMatchWinnerMarkets, {
      eventKey: EVENT, matches: [{ matchNumber: 40, matchLabel: "Q40", winRed: 50, winBlue: 50 }],
    });
    const res = await as.mutation(api.betting.batchCreateMatchWinnerMarkets, {
      eventKey: EVENT, matches: [],
      refreshMatches: [
        { matchNumber: 40, matchLabel: "Q40", winRed: 65, winBlue: 35 },
        { matchNumber: 41, matchLabel: "Q41", winRed: 65, winBlue: 35 },
      ],
    });
    expect(res).toEqual({ created: 0, refreshed: 1 });
    const all = await t.run((ctx) => ctx.db.query("bettingMarkets").collect());
    expect(all.filter((m) => m.matchNumber === 41)).toHaveLength(0);
    expect(all.find((m) => m.matchNumber === 40)!.options[0].winProb).toBe(65);
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

describe("autoResolveMarket (server-triggered payout)", () => {
  // autoResolveMarket looks a market up by title ("<label> — Match Winner"), the
  // shape batchCreateMatchWinnerMarkets writes — not the bare "Q1" the shared
  // setup() fixture above uses for its own unrelated tests, so this builds its
  // own market rather than reusing that fixture.
  async function marketFixture(t: ReturnType<typeof convexTest>) {
    const userId = await t.run((ctx) => ctx.db.insert("users", { name: "Bettor" }));
    const as = t.withIdentity({ subject: userId, issuer: "test", email: "czhao@team4099.com" });
    const marketId = await t.run(async (ctx) => {
      await ctx.db.insert("userBalances", { userId, eventKey: EVENT, balance: 1000, totalWon: 0, totalLost: 0, totalBet: 0, totalBegs: 0 });
      return ctx.db.insert("bettingMarkets", {
        eventKey: EVENT, title: "Q1 — Match Winner", type: "match_winner",
        options: [
          { id: "red", label: "Red", winProb: 40, seedPool: 40 },
          { id: "blue", label: "Blue", winProb: 60, seedPool: 60 },
        ],
        status: "open", createdAt: Date.now(),
      });
    });
    return { userId, as, marketId };
  }

  test("resolves and pays out exactly like the admin resolveMarket path", async () => {
    const t = convexTest(schema, modules);
    const { as, marketId } = await marketFixture(t);
    await as.mutation(api.betting.placeBet, { marketId, optionId: "red", amount: 100 });
    // Betting closes (auto-lock) before the match plays; resolution follows.
    await t.run((ctx) => ctx.db.patch(marketId, { status: "locked" }));

    const res = await t.mutation(internal.betting.autoResolveMarket, {
      eventKey: EVENT, matchLabel: "Q1", winner: "red",
    });
    expect(res).not.toBeNull();
    expect(res!.totalPaid).toBe(250); // 40% underdog pays 2.5x

    const market = await t.run((ctx) => ctx.db.get(marketId));
    expect(market!.status).toBe("resolved");
    expect(market!.resolvedOptionId).toBe("red");
  });

  test("is silently a no-op for an already-resolved market or an unknown label", async () => {
    const t = convexTest(schema, modules);
    const { marketId } = await marketFixture(t);
    await t.run((ctx) => ctx.db.patch(marketId, { status: "resolved", resolvedOptionId: "red" }));

    expect(await t.mutation(internal.betting.autoResolveMarket, {
      eventKey: EVENT, matchLabel: "Q1", winner: "blue",
    })).toBeNull();
    const stillRed = await t.run((ctx) => ctx.db.get(marketId));
    expect(stillRed!.resolvedOptionId).toBe("red"); // not flipped to blue by a second call

    expect(await t.mutation(internal.betting.autoResolveMarket, {
      eventKey: EVENT, matchLabel: "Q404 — nonexistent", winner: "red",
    })).toBeNull();
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
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const t = convexTest(schema, modules);
    const { as, txns } = await setup(t, 0);

    await as.mutation(api.betting.beg, { eventKey: EVENT });
    vi.restoreAllMocks();
    const rows = await txns();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "beg", amount: BEG_AMOUNT });
  });
});
