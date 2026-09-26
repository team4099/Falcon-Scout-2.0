// ── Auto-lock markets shortly before a match, and keep odds fresh ─────────────
//
// Betting stays open until an admin locks it by hand unless something closes it
// 5 minutes before the match starts. This does that from TBA data fetched *server-side*
// (never client-supplied, so nobody can lock markets by lying), on a cron and
// whenever a signed-in client opens the Betting page. Idempotent and cheap: it
// returns before touching TBA if the event has no open markets.

import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import { multiplierFor } from "./betting";

/** Betting closes this long before a match's start time. */
export const LOCK_LEAD_MS = 5 * 60 * 1000;

const TBA_BASE = "https://www.thebluealliance.com/api/v3";
const LEVEL_PREFIX: Record<string, string> = { qm: "Q", ef: "EF", qf: "QF", sf: "SF", f: "F" };

type TbaMatch = {
  comp_level: string;
  set_number: number;
  match_number: number;
  time?: number | null;           // scheduled start (unix s)
  predicted_time?: number | null; // TBA's running estimate (unix s), follows delays
  actual_time?: number | null;
  alliances?: { red?: { score?: number }; blue?: { score?: number } };
};

/** Same labels the client writes into market titles (BettingPage matchLabel). */
export function tbaMatchLabel(m: TbaMatch): string {
  const prefix = LEVEL_PREFIX[m.comp_level] ?? m.comp_level.toUpperCase();
  return m.comp_level === "qm"
    ? `${prefix}${m.match_number}`
    : `${prefix}${m.set_number}M${m.match_number}`;
}

/**
 * Should betting be closed? Yes once the match is within LOCK_LEAD_MS of its
 * start (predicted time, which follows schedule slips, else the scheduled
 * time), and always once it has started or been scored (-1 scores = none).
 */
export function shouldLock(m: TbaMatch, nowMs: number): boolean {
  const red = m.alliances?.red?.score ?? -1;
  const blue = m.alliances?.blue?.score ?? -1;
  if (red >= 0 && blue >= 0) return true;
  if (typeof m.actual_time === "number" && m.actual_time * 1000 <= nowMs) return true;
  const start = m.predicted_time ?? m.time;
  return typeof start === "number" && start * 1000 - LOCK_LEAD_MS <= nowMs;
}

export const openMarkets = internalQuery({
  args: { eventKey: v.string() },
  handler: async (ctx, { eventKey }) =>
    (await ctx.db
      .query("bettingMarkets")
      .withIndex("by_event", (q) => q.eq("eventKey", eventKey))
      .collect())
      .filter((m) => m.type === "match_winner" && m.status === "open")
      .map((m) => ({ id: m._id, title: m.title })),
});

export const currentEventKey = internalQuery({
  args: {},
  handler: async (ctx): Promise<string | null> =>
    (await ctx.db
      .query("eventSettings")
      .withIndex("by_key", (q) => q.eq("key", "current_event"))
      .first())?.eventKey ?? null,
});

export const lockMarkets = internalMutation({
  args: { ids: v.array(v.id("bettingMarkets")) },
  handler: async (ctx, { ids }) => {
    let locked = 0;
    for (const id of ids) {
      const m = await ctx.db.get(id);
      if (m && m.status === "open") {
        await ctx.db.patch(id, { status: "locked" });
        locked++;
      }
    }
    return locked;
  },
});

async function lockPlayed(ctx: ActionCtx, eventKey: string): Promise<number> {
  if (!/^\d{4}[a-z0-9]{1,20}$/.test(eventKey)) return 0;
  const open = await ctx.runQuery(internal.bettingSync.openMarkets, { eventKey });
  if (open.length === 0) return 0;

  const key = await ctx.runQuery(internal.tba.getKey);
  if (!key) return 0;
  let matches: TbaMatch[];
  try {
    const res = await fetch(`${TBA_BASE}/event/${eventKey}/matches`, {
      headers: { "X-TBA-Auth-Key": key },
    });
    if (!res.ok) return 0;
    matches = (await res.json()) as TbaMatch[];
  } catch {
    return 0;
  }
  if (!Array.isArray(matches)) return 0;

  const now = Date.now();
  const closingTitles = new Set(
    matches.filter((m) => shouldLock(m, now)).map((m) => `${tbaMatchLabel(m)} — Match Winner`),
  );
  const ids = open.filter((m) => closingTitles.has(m.title)).map((m) => m.id);
  if (ids.length === 0) return 0;
  return await ctx.runMutation(internal.bettingSync.lockMarkets, { ids });
}

/** Called by the Betting page. Approved users only; takes no trusted input. */
export const lockPlayedMatches = action({
  args: { eventKey: v.string() },
  handler: async (ctx, { eventKey }): Promise<number> => {
    if (!(await ctx.runQuery(internal.tba.isApproved))) return 0;
    return await lockPlayed(ctx, eventKey);
  },
});

/** Cron entry point: the current event, so betting closes with nobody watching. */
export const lockPlayedForCurrentEvent = internalAction({
  args: {},
  handler: async (ctx) => {
    const eventKey = await ctx.runQuery(internal.bettingSync.currentEventKey);
    if (eventKey) await lockPlayed(ctx, eventKey);
  },
});

// ── Odds refresh ──────────────────────────────────────────────────────────────
// Statbotics' predictions move as results come in, and markets are written once,
// so without this the odds stay whatever they were when an admin last pressed
// "Generate". Only open markets nobody has bet on are touched: a placed bet
// already locked its multiplier, and nobody's odds shift under them.

const STATBOTICS_HOSTS = [
  "https://api-statbotics.popcornpenguins.com/v3",
  "https://statbotics-production.up.railway.app/v3",
  "https://api.statbotics.io/v3",
];

type SbMatch = TbaMatch & { pred?: { red_win_prob?: number | null } | null };

export const applyOdds = internalMutation({
  args: { eventKey: v.string(), odds: v.array(v.object({ label: v.string(), winRed: v.number() })) },
  handler: async (ctx, { eventKey, odds }) => {
    const byTitle = new Map(odds.map((o) => [`${o.label} — Match Winner`, o.winRed]));
    const markets = await ctx.db
      .query("bettingMarkets")
      .withIndex("by_event", (q) => q.eq("eventKey", eventKey))
      .collect();
    let updated = 0;
    for (const m of markets) {
      const raw = byTitle.get(m.title);
      if (raw === undefined || m.type !== "match_winner" || m.status !== "open") continue;
      const winRed = Math.max(1, Math.min(99, Math.round(raw)));
      if (m.options[0]?.winProb === winRed) continue;
      const hasBet = await ctx.db.query("bets").withIndex("by_market", (q) => q.eq("marketId", m._id)).first();
      if (hasBet) continue;
      const winBlue = 100 - winRed;
      await ctx.db.patch(m._id, {
        description:
          `Statbotics predicts Red ${winRed}% · Blue ${winBlue}%. ` +
          `Pays ${multiplierFor(winRed).toFixed(2)}x on Red, ${multiplierFor(winBlue).toFixed(2)}x on Blue.`,
        options: [
          { id: "red",  label: "Red Alliance",  winProb: winRed,  seedPool: winRed  },
          { id: "blue", label: "Blue Alliance", winProb: winBlue, seedPool: winBlue },
        ],
      });
      updated++;
    }
    return updated;
  },
});

async function refreshOdds(ctx: ActionCtx, eventKey: string): Promise<number> {
  if (!/^\d{4}[a-z0-9]{1,20}$/.test(eventKey)) return 0;
  if ((await ctx.runQuery(internal.bettingSync.openMarkets, { eventKey })).length === 0) return 0;

  // First host with a non-empty answer wins; an empty list means "not synced".
  for (const host of STATBOTICS_HOSTS) {
    try {
      const res = await fetch(`${host}/matches?event=${eventKey}&limit=1000`, {
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) continue;
      const rows = (await res.json()) as SbMatch[];
      if (!Array.isArray(rows) || rows.length === 0) continue;
      const odds = rows.flatMap((m) => {
        const p = m.pred?.red_win_prob;
        return typeof p === "number" && Number.isFinite(p)
          ? [{ label: tbaMatchLabel(m), winRed: p * 100 }] : [];
      });
      if (odds.length === 0) continue;
      return await ctx.runMutation(internal.bettingSync.applyOdds, { eventKey, odds });
    } catch { /* try the next host */ }
  }
  return 0;
}

/** Cron entry point. */
export const refreshOddsForCurrentEvent = internalAction({
  args: {},
  handler: async (ctx) => {
    const eventKey = await ctx.runQuery(internal.bettingSync.currentEventKey);
    if (eventKey) await refreshOdds(ctx, eventKey);
  },
});
