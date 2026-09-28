// Pure helpers for the Dashboard team panel (TeamDetailPanel.tsx): event
// rankings for stat tiles, the one pit report shown per team, report ordering
// and the notes/data split used by the Reports filter.
import { matchSortValue } from "@/lib/utils";

export interface RankedSub {
  _id: string;
  templateId: string;
  matchNumber: number;
  compLevel?: "qm" | "elim";
  syncedAt?: number;
  data: string;
}

export interface Rank {
  rank: number;
  total: number;
}

/** Competition ranking: ties share a rank ("1, 2, 2, 4"). Higher is better
 *  unless `lowerIsBetter`. null when the team has no value. */
export function rankIn(
  values: Record<number, number | null | undefined>,
  team: number,
  lowerIsBetter = false,
): Rank | null {
  const mine = values[team];
  if (typeof mine !== "number" || !Number.isFinite(mine)) return null;
  const all = Object.values(values).filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  const better = all.filter((v) => (lowerIsBetter ? v < mine : v > mine)).length;
  return { rank: better + 1, total: all.length };
}

/** Form fields count things a team wants less of ("Pieces Missed", "Robot
 *  Died / Disabled", "Fouls") — rank those lowest-first so #1 is always best. */
export function isLowerBetter(label: string): boolean {
  return /\b(miss(ed|es)?|died|dead|disabled|broke|broken|fouls?|penalt(y|ies)|tipped|stuck|fail(ed|s|ure)?|drops?|dropped)\b/i.test(label);
}

export function parseSubData(s: { data: string }): Record<string, unknown> {
  try { return JSON.parse(s.data) as Record<string, unknown>; } catch { return {}; }
}

/** An answer a scout left blank. `false` and `0` are real answers. */
export function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

export const isNoteField = (type: string) => type === "text" || type === "textarea";

/** Newest report first: latest match (elims after quals), then latest sync. */
export function newestFirst<T extends RankedSub>(subs: T[]): T[] {
  return [...subs].sort(
    (a, b) =>
      matchSortValue(b.matchNumber, b.compLevel) - matchSortValue(a.matchNumber, a.compLevel) ||
      (b.syncedAt ?? 0) - (a.syncedAt ?? 0),
  );
}

/** A team has one pit report: the most recently synced one. Deleting it
 *  falls back to the previous one automatically. */
export function latestPit<T extends { syncedAt?: number }>(subs: T[]): T | null {
  let best: T | null = null;
  for (const s of subs) if (!best || (s.syncedAt ?? 0) > (best.syncedAt ?? 0)) best = s;
  return best;
}
