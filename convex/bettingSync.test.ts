/**
 * Betting/TBA sync: markets close once TBA says the match has started, and pay
 * out automatically the moment TBA posts that match's winner — judged from
 * server-fetched TBA data only, and only the right market is ever touched.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { matchWinner, shouldLock, tbaMatchLabel } from "./bettingSync";

const modules = import.meta.glob("./**/*.ts");
const EVENT = "2026vaale1";

const match = (
  level: string, set: number, num: number, red: number, blue: number,
  actual: number | null = null, winningAlliance: "red" | "blue" | "" | null = null,
) => ({
  comp_level: level, set_number: set, match_number: num, actual_time: actual,
  winning_alliance: winningAlliance,
  alliances: { red: { score: red }, blue: { score: blue } },
});

async function setup() {
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) => ctx.db.insert("users", { name: "S", email: "s@team4099.com" }));
  const ids: Record<string, string> = {};
  await t.run(async (ctx) => {
    for (const [title, n] of [["Q1", 1], ["Q2", 2], ["F1M2", 2]] as const) {
      ids[title] = await ctx.db.insert("bettingMarkets", {
        eventKey: EVENT, title: `${title} — Match Winner`, description: "", type: "match_winner",
        matchNumber: n,
        options: [
          { id: "red", label: "Red", winProb: 50, seedPool: 50 },
          { id: "blue", label: "Blue", winProb: 50, seedPool: 50 },
        ],
        status: "open", createdAt: Date.now(), createdBy: userId,
      });
    }
  });
  const as = t.withIdentity({ subject: userId, issuer: "test", email: "s@team4099.com" });
  return { t, as, userId, ids };
}

const status = (t: ReturnType<typeof convexTest>, id: string) =>
  t.run(async (ctx) => (await ctx.db.get(id as never) as { status: string }).status);

describe("shouldLock / matchWinner / tbaMatchLabel", () => {
  test("scores or a past actual_time mean started; -1 scores and no time do not", () => {
    expect(shouldLock(match("qm", 1, 1, 30, 20), Date.now())).toBe(true);
    expect(shouldLock(match("qm", 1, 2, -1, -1), Date.now())).toBe(false);
    expect(shouldLock(match("qm", 1, 3, -1, -1, 1000), Date.now())).toBe(true);
    expect(shouldLock(match("qm", 1, 4, -1, -1, Math.floor(Date.now() / 1000) + 3600), Date.now())).toBe(false);
  });
  test("locks 5 minutes before the start, using the predicted time over the scheduled one", () => {
    const now = Date.now();
    const at = (min: number) => Math.floor(now / 1000) + min * 60;
    const m = (time: number | null, predicted: number | null) => ({ ...match("qm", 1, 5, -1, -1), time, predicted_time: predicted });
    expect(shouldLock(m(at(6), null), now)).toBe(false);
    expect(shouldLock(m(at(4), null), now)).toBe(true);
    // Scheduled soon but running 20 minutes late: still open.
    expect(shouldLock(m(at(2), at(20)), now)).toBe(false);
    expect(shouldLock(m(at(30), at(3)), now)).toBe(true);
  });

  test("labels match what the client writes into market titles", () => {
    expect(tbaMatchLabel(match("qm", 1, 11, 0, 0))).toBe("Q11");
    expect(tbaMatchLabel(match("f", 1, 2, 0, 0))).toBe("F1M2");
  });

  test("prefers TBA's winning_alliance over comparing scores", () => {
    // Score says blue, but a foul/tiebreaker flipped the official result to red.
    expect(matchWinner(match("qm", 1, 1, 40, 50, null, "red"))).toBe("red");
  });
  test("falls back to comparing scores when winning_alliance is absent", () => {
    expect(matchWinner(match("qm", 1, 1, 50, 40))).toBe("red");
    expect(matchWinner(match("qm", 1, 1, 40, 50))).toBe("blue");
  });
  test("a tie or an unplayed match has no winner — left for an admin", () => {
    expect(matchWinner(match("qm", 1, 1, 40, 40))).toBeNull();
    expect(matchWinner(match("qm", 1, 1, -1, -1))).toBeNull();
    expect(matchWinner(match("qm", 1, 1, 40, 40, null, ""))).toBeNull();
  });
});

describe("applyOdds", () => {
  test("updates open no-bet markets by match label, never one that has a bet", async () => {
    const { t, as, ids } = await setup();
    await t.run(async (ctx) => {
      const u = (await ctx.db.query("users").first())!;
      await ctx.db.insert("userBalances", { userId: u._id, eventKey: EVENT, balance: 1000, totalWon: 0, totalLost: 0, totalBet: 0, totalBegs: 0 });
    });
    await as.mutation(api.betting.placeBet, { marketId: ids.Q2 as never, optionId: "red", amount: 10 });

    const n = await t.mutation(internal.bettingSync.applyOdds, {
      eventKey: EVENT,
      odds: [{ label: "Q1", winRed: 87.4 }, { label: "Q2", winRed: 12 }, { label: "Q99", winRed: 60 }],
    });
    expect(n).toBe(1);
    const probs = (id: string) => t.run(async (ctx) =>
      (await ctx.db.get(id as never) as { options: { winProb: number }[] }).options.map((o) => o.winProb));
    expect(await probs(ids.Q1)).toEqual([87, 13]);
    expect(await probs(ids.Q2)).toEqual([50, 50]);
  });
});

describe("syncPlayedMatches (lock + auto-payout)", () => {
  beforeEach(() => {
    process.env.TBA_API_KEY = "k".repeat(40);
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify([
        match("qm", 1, 1, 50, 40, 1000, "red"), // played, red won
        match("qm", 1, 2, -1, -1),              // upcoming, untouched
      ]), { status: 200 })));
  });
  afterEach(() => { delete process.env.TBA_API_KEY; vi.unstubAllGlobals(); });

  test("locks the imminent/started match and pays out the finished one in the same pass", async () => {
    const { t, as, ids } = await setup();
    const result = await as.action(api.bettingSync.syncPlayedMatches, { eventKey: EVENT });
    expect(result.resolved).toBe(1);
    // Q1 both "should lock" and has a winner — it ends up resolved, not stuck locked.
    expect(await status(t, ids.Q1)).toBe("resolved");
    expect(await status(t, ids.Q2)).toBe("open");
    expect(await status(t, ids.F1M2)).toBe("open"); // same match number, different level — not confused
  });

  test("winning bettor is paid out and the loser gets nothing, without any admin action", async () => {
    const { t, as, userId, ids } = await setup();
    const otherId = await t.run((ctx) => ctx.db.insert("users", { name: "L", email: "l@team4099.com" }));
    const asLoser = t.withIdentity({ subject: otherId, issuer: "test", email: "l@team4099.com" });
    await t.run(async (ctx) => {
      for (const uid of [userId, otherId]) {
        await ctx.db.insert("userBalances", { userId: uid as never, eventKey: EVENT, balance: 1000, totalWon: 0, totalLost: 0, totalBet: 0, totalBegs: 0 });
      }
    });
    await as.mutation(api.betting.placeBet, { marketId: ids.Q1 as never, optionId: "red", amount: 100 });
    await asLoser.mutation(api.betting.placeBet, { marketId: ids.Q1 as never, optionId: "blue", amount: 100 });

    await as.action(api.bettingSync.syncPlayedMatches, { eventKey: EVENT });

    const balance = (uid: string) => t.run(async (ctx) =>
      (await ctx.db.query("userBalances").withIndex("by_user_event", (q) => q.eq("userId", uid as never).eq("eventKey", EVENT)).first())!);
    const winner = await balance(userId);
    const loser = await balance(otherId);
    expect(winner.balance).toBe(1000 - 100 + 200); // 2.00x on a 50/50 market
    expect(winner.totalWon).toBe(200);
    expect(loser.balance).toBe(1000 - 100);
    expect(loser.totalLost).toBe(100);

    const bets = await t.run((ctx) => ctx.db.query("bets").withIndex("by_market", (q) => q.eq("marketId", ids.Q1 as never)).collect());
    expect(bets.every((b) => b.settled)).toBe(true);
  });

  test("running it twice never pays out a second time", async () => {
    const { t, as, userId, ids } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.insert("userBalances", { userId: userId as never, eventKey: EVENT, balance: 1000, totalWon: 0, totalLost: 0, totalBet: 0, totalBegs: 0 });
    });
    await as.mutation(api.betting.placeBet, { marketId: ids.Q1 as never, optionId: "red", amount: 100 });

    await as.action(api.bettingSync.syncPlayedMatches, { eventKey: EVENT });
    const first = await t.run(async (ctx) =>
      (await ctx.db.query("userBalances").withIndex("by_user_event", (q) => q.eq("userId", userId as never).eq("eventKey", EVENT)).first())!.balance);

    const second = await as.action(api.bettingSync.syncPlayedMatches, { eventKey: EVENT });
    expect(second.resolved).toBe(0); // already resolved — skipped, not re-paid
    const after = await t.run(async (ctx) =>
      (await ctx.db.query("userBalances").withIndex("by_user_event", (q) => q.eq("userId", userId as never).eq("eventKey", EVENT)).first())!.balance);
    expect(after).toBe(first);
  });

  test("placing a bet on a locked market is rejected", async () => {
    const { t, as, ids } = await setup();
    await t.run(async (ctx) => {
      const u = (await ctx.db.query("users").first())!;
      await ctx.db.insert("userBalances", { userId: u._id, eventKey: EVENT, balance: 1000, totalWon: 0, totalLost: 0, totalBet: 0, totalBegs: 0 });
    });
    // Not started/scored, but its predicted start is inside the lock window.
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify([{ ...match("qm", 1, 1, -1, -1), predicted_time: Math.floor(Date.now() / 1000) - 60 }]), { status: 200 })));
    await as.action(api.bettingSync.syncPlayedMatches, { eventKey: EVENT });
    expect(await status(t, ids.Q1)).toBe("locked");
    await expect(
      as.mutation(api.betting.placeBet, { marketId: ids.Q1 as never, optionId: "red", amount: 10 }),
    ).rejects.toThrow(/not open/);
  });

  test("signed-out callers do nothing and never reach TBA", async () => {
    const { t, ids } = await setup();
    expect(await t.action(api.bettingSync.syncPlayedMatches, { eventKey: EVENT }))
      .toEqual({ locked: 0, resolved: 0, totalPaid: 0 });
    expect(await status(t, ids.Q1)).toBe("open");
    expect(fetch).not.toHaveBeenCalled();
  });

  test("no TBA call once every market is resolved/unlockable; the cron path uses the current event", async () => {
    const { t, ids } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.insert("eventSettings", { key: "current_event", eventKey: EVENT, eventName: "x", updatedAt: 1 });
    });
    await t.action(internal.bettingSync.syncPlayedMatchesForCurrentEvent, {});
    expect(await status(t, ids.Q1)).toBe("resolved");
    (fetch as unknown as ReturnType<typeof vi.fn>).mockClear();
    await t.action(internal.bettingSync.syncPlayedMatchesForCurrentEvent, {}); // Q2/F1M2 still open → still fetches
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});
