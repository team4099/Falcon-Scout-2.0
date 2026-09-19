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

import { idbGetEntry, idbSet, lsGet, lsGetStale, lsSet, TTL } from "./persistentCache";

const TBA_BASE = "https://www.thebluealliance.com/api/v3";

// Statbotics has two hosts. The official API is the source of truth; the
// community mirror is a standby. The app used to be hard-pointed at the mirror
// (0ab3b5f) because the official host was down mid-event — which also meant a
// mirror outage took EPA data down with no recourse. Now every Statbotics call
// tries the official host first and falls back to the mirror only on failure.
const STATBOTICS_PRIMARY = "https://api.statbotics.io/v3";
const STATBOTICS_MIRROR  = "https://statbotics-production.up.railway.app/v3";

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
 * Read the error-backoff entry for a cache key, if the last fetch failed and
 * the 5-minute backoff has not yet expired. Lets the UI distinguish "this
 * upstream is down" from "this team genuinely has no data", which otherwise
 * look identical (both render as an empty cell).
 *
 * `status` is the HTTP status, or 0 for a network/CORS failure.
 */
export function getCacheError(cacheKey: string): { status: number } | null {
  return lsGet<{ status: number }>(`${cacheKey}__err`);
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

export interface TBATeam {
  key: string;              // e.g. "frc4099"
  team_number: number;
  nickname: string;
  name: string;
  city: string | null;
  state_prov: string | null;
  country: string | null;
}

export async function fetchTBAEventTeams(eventKey: string) {
  return fetchTBAWithCache<TBATeam[]>(
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
  winning_alliance: "red" | "blue" | "";  // "" = tie
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
  if (teamNumber <= 0) return null; // guard against invalid team numbers (e.g. checklist submissions)
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
  if (teamNumber <= 0) return null; // guard against invalid team numbers
  const cacheKey = `tba_avatar_${teamNumber}_${year}`;

  // 1. Check IndexedDB first (fresh entry within TTL.LONG).
  //    idbGetEntry distinguishes "no entry" from "entry whose value is null".
  //    The old check rejected null, which is exactly the value stored to record
  //    "this team has no avatar" — so the negative cache never hit and every
  //    avatar-less team was re-fetched from TBA on every single page load.
  const cached = await idbGetEntry<string | null>(cacheKey);
  if (cached) return cached.value;

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
//
// Official host first, community mirror as a standby. Which one is serving data
// is exposed via getStatboticsHealth() so admins can see it in Settings rather
// than having to guess from missing EPA numbers.

export type StatboticsSource = "primary" | "mirror";

export interface StatboticsHealth {
  /** Host that most recently served a successful response. */
  active: StatboticsSource;
  /** When `active` last changed — drives the mirror stickiness window. */
  since: number;
  /** Why we last left the official host, if we have. */
  lastError: { source: StatboticsSource; status: number; at: number } | null;
  lastSuccessAt: number | null;
}

const SB_HEALTH_KEY = "falconscout_statbotics_health";

/** How long to keep using the mirror after the official host fails, before
 *  paying the cost of probing it again. Matches fetchWithCache's error backoff
 *  so a degraded official host doesn't add a failed round-trip to every call. */
const SB_MIRROR_STICKY_MS = 5 * 60 * 1000;

const SB_DEFAULT_HEALTH: StatboticsHealth = {
  active: "primary", since: 0, lastError: null, lastSuccessAt: null,
};

export const STATBOTICS_HOSTS: Record<StatboticsSource, string> = {
  primary: STATBOTICS_PRIMARY,
  mirror:  STATBOTICS_MIRROR,
};

/** Human-readable host label for the source, for UI. */
export function statboticsHostLabel(source: StatboticsSource): string {
  return new URL(STATBOTICS_HOSTS[source]).host;
}

export function getStatboticsHealth(): StatboticsHealth {
  try {
    const raw = localStorage.getItem(SB_HEALTH_KEY);
    if (!raw) return SB_DEFAULT_HEALTH;
    return { ...SB_DEFAULT_HEALTH, ...(JSON.parse(raw) as Partial<StatboticsHealth>) };
  } catch {
    return SB_DEFAULT_HEALTH;
  }
}

const sbHealthListeners = new Set<(h: StatboticsHealth) => void>();

/** Subscribe to failover changes so a mounted UI reflects them immediately
 *  rather than only on remount. Returns an unsubscribe function. */
export function subscribeStatboticsHealth(fn: (h: StatboticsHealth) => void): () => void {
  sbHealthListeners.add(fn);
  return () => { sbHealthListeners.delete(fn); };
}

function writeStatboticsHealth(patch: Partial<StatboticsHealth>): void {
  const next = { ...getStatboticsHealth(), ...patch };
  try {
    localStorage.setItem(SB_HEALTH_KEY, JSON.stringify(next));
  } catch { /* quota / private mode — health is advisory, not load-bearing */ }
  sbHealthListeners.forEach((fn) => fn(next));
}

/** The order to try hosts in. The mirror only goes first while it's holding a
 *  recent official-host failure, so recovery is automatic once that expires. */
function statboticsOrder(): StatboticsSource[] {
  const h = getStatboticsHealth();
  const stickyMirror = h.active === "mirror" && Date.now() - h.since < SB_MIRROR_STICKY_MS;
  return stickyMirror ? ["mirror", "primary"] : ["primary", "mirror"];
}

function recordStatboticsSuccess(source: StatboticsSource): void {
  const h = getStatboticsHealth();
  writeStatboticsHealth({
    active: source,
    since: h.active === source ? h.since : Date.now(),
    lastSuccessAt: Date.now(),
  });
}

/**
 * Statbotics fetch with cache + host failover.
 *
 * Deliberately not built on fetchWithCache: that caches the first failure and
 * returns stale for 5 minutes, which would poison the request before the mirror
 * ever got tried. Here the error-backoff entry is only written once *every*
 * host has failed.
 *
 * `path` is everything after the /v3 base, e.g. "/team_year/4099/2026".
 */
async function fetchStatboticsWithCache<T>(
  path: string,
  cacheKey: string,
  ttl: number
): Promise<T | null> {
  if (!navigator.onLine) return lsGetStale<T>(cacheKey);

  const fresh = lsGet<T>(cacheKey);
  if (fresh !== null) return fresh;

  const errKey = `${cacheKey}__err`;
  if (lsGet<unknown>(errKey) !== null) return lsGetStale<T>(cacheKey);

  let lastStatus = 0;

  for (const source of statboticsOrder()) {
    try {
      const res = await fetch(`${STATBOTICS_HOSTS[source]}${path}`);
      if (!res.ok) {
        console.warn(`[Statbotics:${source}] ${res.status} — ${path}`);
        lastStatus = res.status;
        writeStatboticsHealth({ lastError: { source, status: res.status, at: Date.now() } });
        continue;
      }
      const data = (await res.json()) as T;
      lsSet(cacheKey, data, ttl);
      recordStatboticsSuccess(source);
      return data;
    } catch {
      // Network/CORS failure — no status to report.
      lastStatus = 0;
      writeStatboticsHealth({ lastError: { source, status: 0, at: Date.now() } });
    }
  }

  // Every host failed — only now is the backoff legitimate. Each failure
  // already recorded itself in health on the way through.
  lsSet(errKey, { status: lastStatus }, 5 * 60 * 1000, false);
  return lsGetStale<T>(cacheKey);
}

/**
 * Probe both hosts and update the health record. Used by the Settings panel's
 * "Re-check" button so an admin can confirm recovery without waiting for the
 * stickiness window to lapse.
 */
export async function checkStatboticsHosts(): Promise<Record<StatboticsSource, boolean>> {
  const result = {} as Record<StatboticsSource, boolean>;
  for (const source of ["primary", "mirror"] as StatboticsSource[]) {
    try {
      // Year-independent endpoint: a /team_year probe would 404 for a season
      // Statbotics hasn't populated yet and report a healthy host as down.
      const res = await fetch(`${STATBOTICS_HOSTS[source]}/team/4099`);
      result[source] = res.ok;
      if (!res.ok) {
        writeStatboticsHealth({ lastError: { source, status: res.status, at: Date.now() } });
      }
    } catch {
      result[source] = false;
      writeStatboticsHealth({ lastError: { source, status: 0, at: Date.now() } });
    }
  }
  // Prefer the official host the moment it's healthy again.
  if (result.primary) recordStatboticsSuccess("primary");
  else if (result.mirror) recordStatboticsSuccess("mirror");
  return result;
}

export async function fetchStatboticsTeamEvent(teamNumber: number, eventKey: string) {
  return fetchStatboticsWithCache(
    `/team_event/${teamNumber}/${eventKey}`,
    `sb_team_event_${teamNumber}_${eventKey}`,
    TTL.SHORT
  );
}

/** Cache key for the event-wide Statbotics EPA fetch, so callers can inspect
 *  its error-backoff state via `getCacheError`. */
export function statboticsEventTeamsCacheKey(eventKey: string): string {
  return `sb_event_teams_${eventKey}`;
}

export async function fetchStatboticsEventTeams(eventKey: string) {
  return fetchStatboticsWithCache(
    // Statbotics v3 hard-caps limit at 1000 (422 above that) — 1000 gives
    // a safety margin over the ~80 teams even a large championship division has.
    `/team_events?event=${eventKey}&limit=1000`,
    statboticsEventTeamsCacheKey(eventKey),
    TTL.SHORT  // EPA updates after every match
  );
}

// Fetches per-match EPA for every team at an event.
export async function fetchStatboticsEventTeamMatches(eventKey: string) {
  return fetchStatboticsWithCache(
    // Same 1000 cap as team_events — limit=5000 returns 422 and hard-failed
    // every fetch. Both hosts enforce it, so this was latent before the mirror.
    `/team_matches?event=${eventKey}&limit=1000`,
    `sb_event_team_matches_${eventKey}`,
    TTL.SHORT
  );
}

export async function fetchStatboticsTeamYear(teamNumber: number, year: number) {
  return fetchStatboticsWithCache<{ team: number; epa: unknown }>(
    `/team_year/${teamNumber}/${year}`,
    `sb_team_year_${teamNumber}_${year}`,
    TTL.LONG   // season EPA is stable within a year
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
