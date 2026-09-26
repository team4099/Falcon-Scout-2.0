// TBA and Statbotics API utilities with persistent two-tier caching.
//
// TBA requests go through the Convex `tba.fetchTba` action, which holds the API
// key server-side (Convex env var TBA_API_KEY). No key ever reaches the browser.
//
// Cache tiers:
//   - Team avatars     → IndexedDB (large base64 images, 90-day TTL)
//   - Stable team info → localStorage, 90-day TTL
//   - Event data       → localStorage, 7-day TTL
//   - Live data        → localStorage, 30-min TTL

import { idbGetEntry, idbSet, lsGet, lsGetStale, lsSet, TTL } from "./persistentCache";
import { convex } from "./convexClient";
import { api } from "../../convex/_generated/api";

// Statbotics has two hosts. The official API is the source of truth; the
// community mirror is a standby. The app used to be hard-pointed at the mirror
// (0ab3b5f) because the official host was down mid-event — which also meant a
// mirror outage took EPA data down with no recourse. Now every Statbotics call
// tries the official host first and falls back to the mirror only on failure.
const STATBOTICS_PRIMARY = "https://api.statbotics.io/v3";
const STATBOTICS_MIRROR  = "https://statbotics-production.up.railway.app/v3";

/** Older builds kept a personal TBA key in localStorage. Wipe it so the key
 *  doesn't linger on shared devices now that the server holds the key. */
export function purgeLegacyTbaKey(): void {
  try { localStorage.removeItem("falconscout_api_key_tba"); } catch { /* private mode */ }
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

// ── Cached TBA fetch ─────────────────────────────────────────────────────────

/**
 * TBA fetch via the server-side proxy, with the same cache + error-backoff
 * behaviour as fetchWithCache. `path` is everything after /api/v3.
 *
 * A 401 (session not established yet) is deliberately NOT backed off: the
 * request will succeed moments later once sign-in resolves, and caching the
 * failure would blank the app for 5 minutes.
 */
async function fetchTBAWithCache<T>(
  path: string,
  cacheKey: string,
  ttl: number
): Promise<T | null> {
  if (!navigator.onLine) return lsGetStale<T>(cacheKey);

  const fresh = lsGet<T>(cacheKey);
  if (fresh !== null) return fresh;

  const errKey = `${cacheKey}__err`;
  if (lsGet<unknown>(errKey) !== null) return lsGetStale<T>(cacheKey);

  try {
    const { status, data } = await convex.action(api.tba.fetchTba, { path });
    if (status === 200) {
      lsSet(cacheKey, data, ttl);
      return data as T;
    }
    if (status === 401) return lsGetStale<T>(cacheKey);
    console.warn(`[TBA] ${status} — ${path}`);
    lsSet(errKey, { status }, 5 * 60 * 1000, false);
    return lsGetStale<T>(cacheKey);
  } catch {
    lsSet(errKey, { status: 0 }, 5 * 60 * 1000, false);
    return lsGetStale<T>(cacheKey);
  }
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
    `/event/${eventKey}/teams`,
    `tba_teams_${eventKey}`,
    TTL.MEDIUM  // team lists for an event don't change after registration
  );
}

export async function fetchTBAEventRankings(eventKey: string) {
  return fetchTBAWithCache(
    `/event/${eventKey}/rankings`,
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
    `/event/${eventKey}/matches`,
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
    `/team/frc${teamNumber}`,
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
      `/team/frc${teamNumber}/media/${year}`,
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
// Community mirror first (the official API has been down), official host as the standby. Which one is serving data
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

/** How long to keep the official host in front after the mirror fails, before
 *  probing the mirror again. Matches fetchWithCache's error backoff. */
const SB_MIRROR_STICKY_MS = 5 * 60 * 1000;

/** A host that hangs must not stall EPA forever; give up and try the other. */
const SB_TIMEOUT_MS = 10_000;

/** How long to suppress retries after every host has failed. */
const SB_ERROR_BACKOFF_MS = 60 * 1000;

const SB_DEFAULT_HEALTH: StatboticsHealth = {
  active: "mirror", since: 0, lastError: null, lastSuccessAt: null,
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

/** The order to try hosts in. The official API has been down, and the mirror
 *  is where the data is kept live, so the mirror goes first. The official host
 *  only leads while the mirror is holding a recent failure of its own. */
function statboticsOrder(): StatboticsSource[] {
  const e = getStatboticsHealth().lastError;
  const mirrorDown = e?.source === "mirror" && Date.now() - e.at < SB_MIRROR_STICKY_MS;
  return mirrorDown ? ["primary", "mirror"] : ["mirror", "primary"];
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
      const res = await fetch(`${STATBOTICS_HOSTS[source]}${path}`, { signal: AbortSignal.timeout(SB_TIMEOUT_MS) });
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
  // Short backoff: the mirror stalls intermittently, and a 5-minute blackout
  // for a blip leaves EPA blank long after the host has recovered.
  lsSet(errKey, { status: lastStatus }, SB_ERROR_BACKOFF_MS, false);
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
      const res = await fetch(`${STATBOTICS_HOSTS[source]}/team/4099`, { signal: AbortSignal.timeout(SB_TIMEOUT_MS) });
      result[source] = res.ok;
      if (!res.ok) {
        writeStatboticsHealth({ lastError: { source, status: res.status, at: Date.now() } });
      }
    } catch {
      result[source] = false;
      writeStatboticsHealth({ lastError: { source, status: 0, at: Date.now() } });
    }
  }
  // Prefer the mirror the moment it's healthy; clearing its failure puts it
  // back in front of the official host.
  if (result.mirror) {
    recordStatboticsSuccess("mirror");
    if (getStatboticsHealth().lastError?.source === "mirror") writeStatboticsHealth({ lastError: null });
  } else if (result.primary) recordStatboticsSuccess("primary");
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
    `/event/${eventKey}/insights`,
    `tba_insights_${eventKey}`,
    TTL.SHORT
  );
}
