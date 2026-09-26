/**
 * Betting auto-lock: markets close once TBA says the match has started, judged
 * from server-fetched TBA data only, and only the right market is touched.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { hasStarted, tbaMatchLabel } from "./bettingSync";

const modules = import.meta.glob("./**/*.ts");
const EVENT = "2026vaale1";

const match = (level: string, set: number, num: number, red: number, blue: number, actual: number | null = null) => ({
  comp_level: level, set_number: set, match_number: num, actual_time: actual,
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
  return { t, as, ids };
}

const status = (t: ReturnType<typeof convexTest>, id: string) =>
  t.run(async (ctx) => (await ctx.db.get(id as never) as { status: string }).status);

describe("hasStarted / tbaMatchLabel", () => {
  test("scores or a past actual_time mean started; -1 scores and no time do not", () => {
    expect(hasStarted(match("qm", 1, 1, 30, 20), Date.now())).toBe(true);
    expect(hasStarted(match("qm", 1, 2, -1, -1), Date.now())).toBe(false);
    expect(hasStarted(match("qm", 1, 3, -1, -1, 1000), Date.now())).toBe(true);
    expect(hasStarted(match("qm", 1, 4, -1, -1, Math.floor(Date.now() / 1000) + 3600), Date.now())).toBe(false);
  });
  test("labels match what the client writes into market titles", () => {
    expect(tbaMatchLabel(match("qm", 1, 11, 0, 0))).toBe("Q11");
    expect(tbaMatchLabel(match("f", 1, 2, 0, 0))).toBe("F1M2");
  });
});

describe("lockPlayedMatches", () => {
  beforeEach(() => {
    process.env.TBA_API_KEY = "k".repeat(40);
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify([
        match("qm", 1, 1, 50, 40),      // played
        match("qm", 1, 2, -1, -1),      // upcoming
      ]), { status: 200 })));
  });
  afterEach(() => { delete process.env.TBA_API_KEY; vi.unstubAllGlobals(); });

  test("locks only markets whose match has started — a same-numbered elim is not confused", async () => {
    const { t, as, ids } = await setup();
    expect(await as.action(api.bettingSync.lockPlayedMatches, { eventKey: EVENT })).toBe(1);
    expect(await status(t, ids.Q1)).toBe("locked");
    expect(await status(t, ids.Q2)).toBe("open");
    expect(await status(t, ids.F1M2)).toBe("open");
  });

  test("placing a bet on a locked market is rejected", async () => {
    const { t, as, ids } = await setup();
    await t.run(async (ctx) => {
      const u = (await ctx.db.query("users").first())!;
      await ctx.db.insert("userBalances", { userId: u._id, eventKey: EVENT, balance: 1000, totalWon: 0, totalLost: 0, totalBet: 0, totalBegs: 0 });
    });
    await as.action(api.bettingSync.lockPlayedMatches, { eventKey: EVENT });
    await expect(
      as.mutation(api.betting.placeBet, { marketId: ids.Q1 as never, optionId: "red", amount: 10 }),
    ).rejects.toThrow(/not open/);
  });

  test("signed-out callers do nothing and never reach TBA", async () => {
    const { t, ids } = await setup();
    expect(await t.action(api.bettingSync.lockPlayedMatches, { eventKey: EVENT })).toBe(0);
    expect(await status(t, ids.Q1)).toBe("open");
    expect(fetch).not.toHaveBeenCalled();
  });

  test("no TBA call when the event has no open markets; the cron path uses the current event", async () => {
    const { t, ids } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.insert("eventSettings", { key: "current_event", eventKey: EVENT, eventName: "x", updatedAt: 1 });
    });
    await t.action(internal.bettingSync.lockPlayedForCurrentEvent, {});
    expect(await status(t, ids.Q1)).toBe("locked");
    (fetch as unknown as ReturnType<typeof vi.fn>).mockClear();
    await t.action(internal.bettingSync.lockPlayedForCurrentEvent, {});   // Q2/F1M2 still open → fetches
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});
