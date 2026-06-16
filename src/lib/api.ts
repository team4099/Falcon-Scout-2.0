// TBA and Statbotics API utilities with persistent two-tier caching.
//
// API keys are stored in localStorage by the user via Settings → API Keys.
// They fall back to VITE_TBA_KEY env var if set (useful for team deployments).
//
// Cache tiers:
//   - Team avatars     → IndexedDB (large base64 images, 90-day TTL)
//   - Stable team info → localStorage, 90-day TTL
//   - Event data       → localStorage, 7-day TTL
//   - Live data        → localStorage, 30-min TTL

import { idbGet, idbSet, lsGet, lsGetStale, lsSet, TTL } from "./persistentCache";

const TBA_BASE        = "https://www.thebluealliance.com/api/v3";
const STATBOTICS_BASE = "https://api.statbotics.io/v3";

// ── Key storage ───────────────────────────────────────────────────────────────

export const API_KEY_STORAGE = {
  tba: "falconscout_api_key_tba",
} as const;

export function getTBAKey(): string {
  return (
    localStorage.getItem(API_KEY_STORAGE.tba) ??
    (import.meta.env.VITE_TBA_KEY as string | undefined) ??
    ""
  );
}

export function setTBAKey(key: string): void {
  if (key.trim()) {
    localStorage.setItem(API_KEY_STORAGE.tba, key.trim());
  } else {
    localStorage.removeItem(API_KEY_STORAGE.tba);
  }
}

// kept for backwards compat — delegates to persistentCache
export function clearApiCache(): void {
  import("./persistentCache").then(({ clearAllCache }) => clearAllCache());
}

/** Clear the 5-minute error-backoff entry for a specific cache key so the
 *  next call to fetchWithCache will actually hit the network again. */
export function clearCacheErrKey(cacheKey: string): void {
  const LS_PREFIX = "falconscout_cache_";
  localStorage.removeItem(`${LS_PREFIX}${cacheKey}__err`);
}

/**
 * Clear TBA error-backoff entries for a given event so that the next fetch
 * attempt will actually hit the network (e.g. after a key is first saved).
 */
export function clearTBAErrCache(eventKey: string): void {
  clearCacheErrKey(`tba_teams_${eventKey}`);
  clearCacheErrKey(`tba_rankings_${eventKey}`);
  clearCacheErrKey(`tba_matches_full_${eventKey}`);
  clearCacheErrKey(`tba_insights_${eventKey}`);
}

// ── Core fetch with localStorage cache ───────────────────────────────────────

async function fetchWithCache<T>(
  url: string,
  cacheKey: string,
  headers: Record<string, string> = {},
  ttl: number = TTL.SHORT
): Promise<T | null> {
  // If offline: serve any stale cache over a blank screen
  if (!navigator.onLine) {
    return lsGetStale<T>(cacheKey);
  }

  // Fresh cache hit
  const fresh = lsGet<T>(cacheKey);
  if (fresh !== null) return fresh;

  // If this endpoint recently errored, don't hammer it — wait 5 minutes before retrying
  const errKey = `${cacheKey}__err`;
  if (lsGet<unknown>(errKey) !== null) {
    return lsGetStale<T>(cacheKey);
  }

  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      console.warn(`[API] ${res.status}  — ${url}`);
      // Cache the failure so we don't retry for 5 minutes.
      // updateTimestamp=false so an error doesn't reset "last synced" to "now"
      lsSet(errKey, { status: res.status }, 5 * 60 * 1000, false);
      return lsGetStale<T>(cacheKey);
    }
    const data = (await res.json()) as T;
    lsSet(cacheKey, data, ttl);
    return data;
  } catch {
    // Network error (CORS block, DNS failure, etc.) — also back off for 5 minutes
    // to avoid hammering endpoints that return CORS-less 500s.
    lsSet(errKey, { status: 0 }, 5 * 60 * 1000, false);
    return lsGetStale<T>(cacheKey);
  }
}

function tbaHeaders(): Record<string, string> | null {
  const key = getTBAKey();
  // Return null (not an empty object) when no key is available so callers
  // can bail out early and avoid making requests that would 401.
  return key ? { "X-TBA-Auth-Key": key } : null;
}

/**
 * Like fetchWithCache but returns null without making any network request
 * when no TBA API key is configured.  This avoids 401 responses being
 * cached in the error-backoff layer before the key arrives from Convex.
 */
async function fetchTBAWithCache<T>(
  url: string,
  cacheKey: string,
  ttl: number
): Promise<T | null> {
  const headers = tbaHeaders();
  if (!headers) {
    // No key yet — return stale data if we have it, but don't make a
    // request that would produce a cached 401 error-backoff entry.
    return lsGetStale<T>(cacheKey);
  }
  return fetchWithCache<T>(url, cacheKey, headers, ttl);
}

// ── TBA ───────────────────────────────────────────────────────────────────────

export async function fetchTBAEventTeams(eventKey: string) {
  return fetchTBAWithCache(
    `${TBA_BASE}/event/${eventKey}/teams`,
    `tba_teams_${eventKey}`,
    TTL.MEDIUM  // team lists for an event don't change after registration
  );
}

export async function fetchTBAEventRankings(eventKey: string) {
  return fetchTBAWithCache(
    `${TBA_BASE}/event/${eventKey}/rankings`,
    `tba_rankings_${eventKey}`,
    TTL.SHORT   // live rankings during the event
  );
}

export interface TBAMatch {
  key: string;
  comp_level: "qm" | "ef" | "qf" | "sf" | "f";
  set_number: number;
  match_number: number;
  time: number | null;           // scheduled (unix s)
  predicted_time: number | null; // predicted (unix s)
  actual_time: number | null;    // set once played
  alliances: {
    red:  { team_keys: string[]; score: number };
    blue: { team_keys: string[]; score: number };
  };
}

export async function fetchTBAEventMatches(eventKey: string) {
  return fetchTBAWithCache<TBAMatch[]>(
    `${TBA_BASE}/event/${eventKey}/matches`,
    `tba_matches_full_${eventKey}`,
    TTL.SHORT   // match scores update throughout the event
  );
}

export async function fetchTBATeamInfo(teamNumber: number) {
  return fetchTBAWithCache<{
    nickname: string;
    school_name: string;
    city: string;
    state_prov: string;
    country: string;
  }>(
    `${TBA_BASE}/team/frc${teamNumber}`,
    `tba_team_${teamNumber}`,
    TTL.LONG    // team name / nickname doesn't change within a season
  );
}

/**
 * Fetches a team avatar and stores it in IndexedDB (bypasses 5MB localStorage limit).
 * Falls back to IndexedDB stale data if offline or request fails.
 */
export async function fetchTBATeamAvatar(teamNumber: number, year: number): Promise<string | null> {
  const cacheKey = `tba_avatar_${teamNumber}_${year}`;

  // 1. Check IndexedDB first (fresh entry within TTL.LONG)
  const cached = await idbGet<string | null>(cacheKey);
  if (cached !== undefined && cached !== null) return cached;

  // 2. Offline with no cache → nothing to show
  if (!navigator.onLine) return null;

  // 3. Fetch from TBA
  try {
    const media = await fetchTBAWithCache<Array<{ type: string; details?: { base64Image?: string } }>>(
      `${TBA_BASE}/team/frc${teamNumber}/media/${year}`,
      `tba_media_${teamNumber}_${year}`,
      TTL.LONG  // avatars don't change mid-season
    );
    if (!Array.isArray(media)) {
      await idbSet<string | null>(cacheKey, null, TTL.LONG);
      return null;
    }
    const avatar = media.find((m) => m.type === "avatar");
    const dataUrl = avatar?.details?.base64Image
      ? `data:image/png;base64,${avatar.details.base64Image}`
      : null;

    // Store in IndexedDB so large base64 never bloats localStorage
    await idbSet<string | null>(cacheKey, dataUrl, TTL.LONG);
    return dataUrl;
  } catch {
    return null;
  }
}

// ── Statbotics (no key required) ──────────────────────────────────────────────

export async function fetchStatboticsTeamEvent(teamNumber: number, eventKey: string) {
  return fetchWithCache(
    `${STATBOTICS_BASE}/team_event/${teamNumber}/${eventKey}`,
    `sb_team_event_${teamNumber}_${eventKey}`,
    {},
    TTL.SHORT
  );
}

export async function fetchStatboticsEventTeams(eventKey: string) {
  return fetchWithCache(
    `${STATBOTICS_BASE}/team_events?event=${eventKey}&limit=100`,
    `sb_event_teams_${eventKey}`,
    {},
    TTL.SHORT  // EPA updates after every match
  );
}

// Fetches per-match EPA for every team at an event.
export async function fetchStatboticsEventTeamMatches(eventKey: string) {
  return fetchWithCache(
    `${STATBOTICS_BASE}/team_matches?event=${eventKey}&limit=5000`,
    `sb_event_team_matches_${eventKey}`,
    {},
    TTL.SHORT
  );
}

export async function fetchStatboticsTeamYear(teamNumber: number, year: number) {
  return fetchWithCache<{ team: number; epa: unknown }>(
    `${STATBOTICS_BASE}/team_year/${teamNumber}/${year}`,
    `sb_team_year_${teamNumber}_${year}`,
    {},
    TTL.LONG   // season EPA is stable within a year
  );
}

/** Batch-fetch season EPA for all teams in a given year in a single request.
 *  Returns an array of { team, epa, ... } objects — one per team. */
export async function fetchStatboticsTeamYearsBatch(year: number) {
  return fetchWithCache<Array<{ team: number; epa: unknown }>>(
    `${STATBOTICS_BASE}/team_years?year=${year}&limit=5000`,
    `sb_team_years_batch_${year}`,
    {},
    TTL.LONG
  );
}

// ── Nexus (no key required) ───────────────────────────────────────────────────

export interface NexusTeamStatus {
  /** e.g. "NoShow", "Queuing", "OnDeck", "OnField", "Scoring", "PostMatch" */
  status: string;
  minutesUntilQueue: number | null;
  nextMatchKey: string | null;
  nextMatchLabel: string | null;
}

export async function fetchNexusTeamStatus(
  eventCode: string,
  teamNumber: number
): Promise<NexusTeamStatus | null> {
  try {
    const url = `https://frc.nexus/api/v1/event/${eventCode}/team/${teamNumber}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const json = await res.json() as Record<string, unknown>;
    return {
      status: (json.status as string) ?? "Unknown",
      minutesUntilQueue:
        typeof json.minutesUntilQueued === "number" ? json.minutesUntilQueued :
        typeof json.minutesUntilQueue  === "number" ? json.minutesUntilQueue  : null,
      nextMatchKey:   (json.nextMatchKey   as string) ?? null,
      nextMatchLabel: (json.nextMatchLabel as string) ?? null,
    };
  } catch {
    return null;
  }
}

export async function fetchTBAEventInsights(eventKey: string) {
  return fetchTBAWithCache<{
    qual?: { average_score?: number; average_win_score?: number };
    playoff?: { average_score?: number };
  }>(
    `${TBA_BASE}/event/${eventKey}/insights`,
    `tba_insights_${eventKey}`,
    TTL.SHORT
  );
}
