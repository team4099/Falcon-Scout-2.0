// ── Auto-lock markets for matches that have already started ───────────────────
//
// Betting stays open until an admin locks it by hand unless something closes it
// when the match is played. This does that from TBA data fetched *server-side*
// (never client-supplied, so nobody can lock markets by lying), on a cron and
// whenever a signed-in client opens the Betting page. Idempotent and cheap: it
// returns before touching TBA if the event has no open markets.

import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";

const TBA_BASE = "https://www.thebluealliance.com/api/v3";
const LEVEL_PREFIX: Record<string, string> = { qm: "Q", ef: "EF", qf: "QF", sf: "SF", f: "F" };

type TbaMatch = {
  comp_level: string;
  set_number: number;
  match_number: number;
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

/** Started or finished: TBA has stamped a start time, or posted scores (-1 = none). */
export function hasStarted(m: TbaMatch, nowMs: number): boolean {
  const red = m.alliances?.red?.score ?? -1;
  const blue = m.alliances?.blue?.score ?? -1;
  if (red >= 0 && blue >= 0) return true;
  return typeof m.actual_time === "number" && m.actual_time * 1000 <= nowMs;
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
  const startedTitles = new Set(
    matches.filter((m) => hasStarted(m, now)).map((m) => `${tbaMatchLabel(m)} — Match Winner`),
  );
  const ids = open.filter((m) => startedTitles.has(m.title)).map((m) => m.id);
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
