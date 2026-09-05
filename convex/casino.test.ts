/**
 * Casino round integrity.
 *
 * The audit finding these cover: crossyCashOut and minesCashOut used to take
 * `betAmount` and `multiplier` from the caller and credit their product with no
 * verification at all — one console call minted an unbounded balance. Mines
 * additionally dealt its board from a client-supplied seed (so losing a round
 * revealed the layout for a replay) and never bounded `revealedCount`, which
 * drove the multiplier to Infinity and wrote Infinity into the balance row.
 *
 * The rounds now live in `casinoGames`; the client only names a tile.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const EVENT = "2025chcmp";

async function player(t: ReturnType<typeof convexTest>, balance = 1000) {
  const userId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("users", { name: "Player" });
    await ctx.db.insert("userBalances", {
      userId: id, eventKey: EVENT, balance,
      totalWon: 0, totalLost: 0, totalBet: 0, totalBegs: 0,
    });
    return id;
  });
  const as = t.withIdentity({ subject: userId, issuer: "test" });
  const bal = () => t.run(async (ctx) =>
    (await ctx.db.query("userBalances")
      .withIndex("by_user_event", (q) => q.eq("userId", userId).eq("eventKey", EVENT))
      .first())!.balance);
  return { userId, as, bal };
}

describe("cash-out requires a real round", () => {
  test("minesCashOut with no round in progress pays nothing", async () => {
    const t = convexTest(schema, modules);
    const { as, bal } = await player(t);
    await expect(
      as.mutation(api.betting.minesCashOut, { eventKey: EVENT }),
    ).rejects.toThrow(/No game in progress/);
    expect(await bal()).toBe(1000);
  });

  test("crossyCashOut with no round in progress pays nothing", async () => {
    const t = convexTest(schema, modules);
    const { as, bal } = await player(t);
    await expect(
      as.mutation(api.betting.crossyCashOut, { eventKey: EVENT }),
    ).rejects.toThrow(/No game in progress/);
    expect(await bal()).toBe(1000);
  });

  test("cash-out pays the server's multiplier, never the caller's", async () => {
    const t = convexTest(schema, modules);
    const { as, bal } = await player(t);

    // One mine, so 24 of 25 tiles are safe: the first reveal is almost
    // certainly a gem, and the multiplier is barely above 1x.
    await as.mutation(api.betting.minesStart, {
      eventKey: EVENT, betAmount: 100, mineCount: 1,
    });
    expect(await bal()).toBe(900); // stake deducted by the server

    const round = await t.run(async (ctx) => (await ctx.db.query("casinoGames").first())!);
    const safeTile = [...Array(25).keys()].find((i) => !round.minePositions!.includes(i))!;
    await as.mutation(api.betting.minesReveal, { eventKey: EVENT, tileIndex: safeTile });

    const { payout } = await as.mutation(api.betting.minesCashOut, { eventKey: EVENT });
    // 0.97 * C(25,1)/C(24,1) = 1.01 → 101 coins on a 100 stake.
    expect(payout).toBe(101);
    expect(await bal()).toBe(1001);
  });

  test("a round can only be cashed out once", async () => {
    const t = convexTest(schema, modules);
    const { as, bal } = await player(t);
    await as.mutation(api.betting.minesStart, {
      eventKey: EVENT, betAmount: 100, mineCount: 1,
    });
    const round = await t.run(async (ctx) => (await ctx.db.query("casinoGames").first())!);
    const safeTile = [...Array(25).keys()].find((i) => !round.minePositions!.includes(i))!;
    await as.mutation(api.betting.minesReveal, { eventKey: EVENT, tileIndex: safeTile });
    await as.mutation(api.betting.minesCashOut, { eventKey: EVENT });
    const after = await bal();

    await expect(
      as.mutation(api.betting.minesCashOut, { eventKey: EVENT }),
    ).rejects.toThrow(/No game in progress/);
    expect(await bal()).toBe(after);
  });
});

describe("balances stay finite whole numbers", () => {
  test("a fractional stake is rejected outright", async () => {
    const t = convexTest(schema, modules);
    const { as, bal } = await player(t);
    await expect(
      as.mutation(api.betting.spinSlot, { eventKey: EVENT, betAmount: 10.7777 }),
    ).rejects.toThrow(/whole number/);
    expect(await bal()).toBe(1000);
  });

  test("revealing past the last safe tile cannot produce an Infinity payout", async () => {
    const t = convexTest(schema, modules);
    const { as, bal } = await player(t);
    // 24 mines, 1 safe tile: revealing it ends the round at the top multiplier.
    await as.mutation(api.betting.minesStart, {
      eventKey: EVENT, betAmount: 10, mineCount: 24,
    });
    const round = await t.run(async (ctx) => (await ctx.db.query("casinoGames").first())!);
    const safeTile = [...Array(25).keys()].find((i) => !round.minePositions!.includes(i))!;
    const r = await as.mutation(api.betting.minesReveal, { eventKey: EVENT, tileIndex: safeTile });

    expect(Number.isFinite(r.multiplier)).toBe(true);
    expect(r.gameOver).toBe(true);
    expect(Number.isFinite(await bal())).toBe(true);
  });

  test("the mines board is never revealed mid-round", async () => {
    const t = convexTest(schema, modules);
    const { as } = await player(t);
    await as.mutation(api.betting.minesStart, {
      eventKey: EVENT, betAmount: 10, mineCount: 3,
    });
    const round = await t.run(async (ctx) => (await ctx.db.query("casinoGames").first())!);
    const safeTile = [...Array(25).keys()].find((i) => !round.minePositions!.includes(i))!;
    const r = await as.mutation(api.betting.minesReveal, { eventKey: EVENT, tileIndex: safeTile });
    expect(r.safe).toBe(true);
    expect(r.minePositions).toEqual([]); // layout withheld until the round ends
  });

  test("the same tile cannot be revealed twice", async () => {
    const t = convexTest(schema, modules);
    const { as } = await player(t);
    await as.mutation(api.betting.minesStart, {
      eventKey: EVENT, betAmount: 10, mineCount: 1,
    });
    const round = await t.run(async (ctx) => (await ctx.db.query("casinoGames").first())!);
    const safeTile = [...Array(25).keys()].find((i) => !round.minePositions!.includes(i))!;
    await as.mutation(api.betting.minesReveal, { eventKey: EVENT, tileIndex: safeTile });
    await expect(
      as.mutation(api.betting.minesReveal, { eventKey: EVENT, tileIndex: safeTile }),
    ).rejects.toThrow(/already revealed/);
  });
});
